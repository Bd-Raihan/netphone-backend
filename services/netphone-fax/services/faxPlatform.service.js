"use strict";
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const {Worker} = require("worker_threads");
const axios = require("axios");
const cover = require("./faxCover.service");
const actual = require("./faxActualBilling.service");
const billingControl = require("./faxBillingControl");
const db = require("../database/db");
const provider = require("./telnyxFax.service");
const {createMediaToken,revokeMediaTokens} = require("./mediaToken.service");
const {createNotification} = require("../notifications/notification.service");
const {usdToMicro,microToUsd,sellRate,matchRate,feeForPages} = require("./faxMoney");
const {faxAuthRequired,faxAdminRequired} = require("../middlewares/faxAuth.middleware");

const UPLOADS = path.resolve(__dirname,"../storage/uploads");
// Keep documents and their encryption key outside the Git repository.
const VAULT = path.resolve(process.env.FAX_PRIVATE_STORAGE_DIR ||
  (process.platform === "win32" ? path.join(os.homedir(),"NetPhoneFaxPrivate") : "/root/netphone-fax-private"));
const ARCHIVE = path.resolve(process.env.FAX_LEGACY_INBOX_DIR || "/root/netphone-faxes/inbox");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = (message,status=400) => Object.assign(new Error(message),{status});
let cyclePromise = null;
let timer = null;
const importAttempts = new Map();
let pdfJobs = 0;

function id(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw fail("Record not found",404);
  return result;
}
function filePath(directory,name) {
  if (!name || path.basename(name) !== name) throw fail("Document not found",404);
  const result = path.resolve(directory,name);
  if (path.dirname(result) !== directory) throw fail("Document not found",404);
  return result;
}
async function transaction(fn) {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {await client.query("ROLLBACK");} catch (_) {}
    throw error;
  } finally {client.release();}
}
async function audit(client,actor,action,faxId,details={}) {
  await client.query("INSERT INTO netphone_fax_audit(actor_user_id,action,fax_id,details) VALUES($1,$2,$3,$4::jsonb)",
    [actor,action,faxId,JSON.stringify(details)]);
}
async function settings(client=db) {
  const result = await client.query("SELECT billing_enabled,actual_billing FROM netphone_fax_settings WHERE id=1");
  if (!result.rows[0]) throw fail("Fax setup is incomplete",503);
  return {...result.rows[0],billing_enabled:true,actual_billing:true};
}
async function resolveRate(phone,direction,client=db) {
  if ((await settings(client)).actual_billing) return actual.route(phone,direction,client);
  const result = await client.query("SELECT * FROM netphone_fax_rates WHERE direction=$1",[direction]);
  try {return matchRate(result.rows,phone,direction);} catch (error) {throw fail(error.message,422);}
}
function ratePublic(rate) {
  return {...rate,
    provider_cost_usd_per_page:microToUsd(rate.provider_cost_microusd_per_page),
    sell_usd_per_page:microToUsd(sellRate(rate)),
    profit_usd_per_page:microToUsd(sellRate(rate)-BigInt(rate.provider_cost_microusd_per_page)),
    markup_percent:40,
    manual_sell_usd_per_page:null};
}
async function balance(userId,client=db) {
  const result = await client.query("SELECT balance_microusd,currency FROM wallets WHERE user_id=$1",[userId]);
  if (result.rows[0] && result.rows[0].currency !== "USD") throw fail("Fax charging requires a USD wallet",422);
  return BigInt(result.rows[0]?.balance_microusd || 0);
}
// Uses the same current Wallet schema and row lock, without changing Wallet/Payment code.
async function ledger(client,userId,amount,type,key,meta) {
  if (amount <= 0n || !["fax_charge","fax_refund"].includes(type)) throw fail("Invalid fax charge");
  const walletResult = await client.query("SELECT currency,balance_microusd FROM wallets WHERE user_id=$1 FOR UPDATE",[userId]);
  const wallet = walletResult.rows[0];
  if (!wallet || wallet.currency !== "USD") throw fail("USD wallet not found",402);
  const old = await client.query("SELECT * FROM wallet_transactions WHERE user_id=$1 AND idempotency_key=$2",[userId,key]);
  if (old.rows[0]) {
    if (old.rows[0].type !== type || BigInt(old.rows[0].amount_microusd) !== amount) throw fail("Fax charge conflict",409);
    return old.rows[0];
  }
  const after = BigInt(wallet.balance_microusd) + (type === "fax_refund" ? amount : -amount);
  if (after < 0n) throw fail("Insufficient wallet balance",402);
  // Round the compatibility cents fields exactly as the current Wallet service does.
  const cents = (value) => ((value + 5000n)/10000n).toString();
  const exactMeta = {...meta,service:"fax",display_title:type === "fax_refund" ? "Fax Refund" : meta.direction === "inbound" ? "Fax Receive Charge" : "Fax Send Charge",flow:type === "fax_refund" ? "credit" : "debit",exact_wallet_amount:{
    amount_microusd:amount.toString(),amount_usd:microToUsd(amount),
    balance_after_microusd:after.toString(),balance_after_usd:microToUsd(after)}};
  const tx = await client.query(`INSERT INTO wallet_transactions
    (user_id,type,amount_cents,amount_microusd,reference,idempotency_key,status,balance_after_cents,balance_after_microusd,meta)
    VALUES($1,$2,$3,$4,$5::text,$5::text,'posted',$6,$7,$8::jsonb) RETURNING *`,
    [userId,type,cents(amount),amount.toString(),key,cents(after),after.toString(),JSON.stringify(exactMeta)]);
  await client.query("UPDATE wallets SET balance_microusd=$2,balance_cents=$3,updated_at=NOW() WHERE user_id=$1",
    [userId,after.toString(),cents(after)]);
  return tx.rows[0];
}
async function readPdf(bytes,mime="application/pdf") {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 30*1024*1024) throw fail("Invalid fax document",422);
  // Multipart uploads can be application/octet-stream; trust parsed content, not the MIME label.
  if (bytes.subarray(0,1024).includes(Buffer.from("%PDF-"))) mime = "application/pdf";
  else if (bytes.subarray(0,8).toString("hex") === "89504e470d0a1a0a") mime = "image/png";
  else if (bytes.subarray(0,3).toString("hex") === "ffd8ff") mime = "image/jpeg";
  else throw fail("Unsupported fax document",422);
  if (!["application/pdf","image/png","image/jpeg"].includes(mime)) throw fail("Unsupported fax document",422);
  if (pdfJobs >= 2) throw fail("Document processing is busy. Please try again",429);
  pdfJobs++;
  try {return await new Promise((resolve,reject) => {
    const worker = new Worker(path.join(__dirname,"faxPdf.worker.js"),{
      workerData:{bytes,mime},resourceLimits:{maxOldGenerationSizeMb:128}});
    let completed = false;
    const finish = (error,result) => {
      if (completed) return;
      completed = true; clearTimeout(timeout); void worker.terminate();
      error ? reject(error) : resolve(result);
    };
    const timeout = setTimeout(() => finish(fail("Document processing timed out",422)),12000);
    worker.once("message",result => result.error ? finish(fail(result.error,422)) :
      finish(null,{pages:result.pages,bytes:Buffer.from(result.bytes)}));
    worker.once("error",() => finish(fail("Unable to process this document",422)));
    worker.once("exit",code => {if (!completed) finish(fail("Document processor stopped",422));});
  });} finally {pdfJobs--;}
}
async function vaultKey() {
  await fsp.mkdir(VAULT,{recursive:true,mode:0o700});
  const target = path.join(VAULT,"document.key");
  try {
    const key = await fsp.readFile(target);
    if (key.length !== 32) throw fail("Document key is unavailable",503);
    return key;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // Never replace a lost key when encrypted documents already exist.
    if ((await fsp.readdir(VAULT)).some(name => name.endsWith(".nfx"))) throw fail("Restore the original document key",503);
    try {await fsp.writeFile(target,crypto.randomBytes(32),{flag:"wx",mode:0o600});}
    catch (writeError) {if (writeError.code !== "EEXIST") throw writeError;}
    return vaultKey();
  }
}
async function storePrivate(bytes) {
  const key = await vaultKey(), nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm",key,nonce);
  const encrypted = Buffer.concat([cipher.update(bytes),cipher.final()]);
  const name = `${crypto.randomUUID()}.nfx`;
  await fsp.writeFile(filePath(VAULT,name),Buffer.concat([Buffer.from("NFX1"),nonce,cipher.getAuthTag(),encrypted]),{flag:"wx",mode:0o600});
  return name;
}
async function privateBytes(name,expectedHash) {
  if (!/^[0-9a-f-]{36}\.nfx$/.test(name)) throw fail("Document not found",404);
  const data = await fsp.readFile(filePath(VAULT,name));
  if (data.length < 32 || data.subarray(0,4).toString() !== "NFX1") throw fail("Document verification failed",503);
  const decipher = crypto.createDecipheriv("aes-256-gcm",await vaultKey(),data.subarray(4,16));
  decipher.setAuthTag(data.subarray(16,32));
  const bytes = Buffer.concat([decipher.update(data.subarray(32)),decipher.final()]);
  if (sha256(bytes) !== expectedHash) throw fail("Document verification failed",503);
  return bytes;
}
async function ownedFax(userId,faxId,client=db) {
  const result = await client.query("SELECT * FROM netphone_faxes WHERE id=$1 AND user_id=$2",[faxId,userId]);
  if (!result.rows[0]) throw fail("Fax document not found",404);
  return result.rows[0];
}
async function loadIncomingDocument(userId,faxId) {
  const fax = await ownedFax(userId,faxId);
  if (fax.direction !== "inbound") return null;
  const result = await db.query(`SELECT i.*,b.state FROM netphone_fax_incoming i
    JOIN netphone_fax_billing b ON b.fax_id=i.fax_id AND b.user_id=$2 WHERE i.fax_id=$1`,[faxId,userId]);
  const incoming = result.rows[0];
  if (!incoming) throw fail("Fax document not found",404);
  if (!["paid","free"].includes(incoming.state)) throw fail("Confirm the receive fee before opening this document",402);
  return privateBytes(incoming.vault_file_name,incoming.file_sha256);
}
async function notify(userId,faxId,title,message,type="fax_delivered") {
  try {await createNotification({userId,faxId,title,message,notificationType:type});}
  catch (_) {console.error("Fax notification could not be saved");}
}
function publicFax(fax) {
  const fields = ["id","direction","from_number","to_number","status","file_name","pages","failure_reason","created_at","updated_at"];
  return Object.fromEntries(fields.map(key => [key,fax[key]]));
}

async function quote(req) {
  const uploadId = id(req.body.upload_id), to = String(req.body.to_number || "").trim();
  if (!/^\+[1-9]\d{7,14}$/.test(to)) throw fail("Use an international fax number");
  const uploadResult = await db.query("SELECT * FROM netphone_fax_uploads WHERE id=$1 AND user_id=$2 AND is_used=FALSE",[uploadId,req.user.id]);
  const upload = uploadResult.rows[0];
  if (!upload) throw fail("Fax upload not found",404);
  if (!(await settings()).billing_enabled) return {billing_enabled:false,amount_usd:"0.000000",quote_id:null};
  const config=await actual.settings();
  if((!config.adapter_verified || config.usage_sync_error || !config.last_usage_sync || Date.now()-new Date(config.last_usage_sync).getTime()>900000))throw fail("Fax billing temporarily unavailable. Try again later",503);
  const rate = await resolveRate(to,"outbound");
  const count = await db.query("SELECT COUNT(*)::INTEGER AS count FROM netphone_fax_quotes WHERE user_id=$1 AND expires_at>NOW() AND state='quoted'",[req.user.id]);
  if (count.rows[0].count >= 20) throw fail("Too many pending quotes. Try again later",429);
  const input = await fsp.readFile(filePath(UPLOADS,upload.stored_file_name));
  const parsed = await readPdf(input,upload.mime_type);
  const amount = rate.dynamic ? actual.fee(rate,parsed.pages) : feeForPages(rate,parsed.pages), quoteId = crypto.randomUUID();
  const name = `quote_${quoteId}.pdf`;
  await fsp.writeFile(filePath(UPLOADS,name),parsed.bytes,{flag:"wx",mode:0o600});
  const saved = await db.query(`INSERT INTO netphone_fax_quotes
    (id,user_id,upload_id,to_number,prepared_file_name,file_sha256,pages,amount_microusd,rate_snapshot,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,NOW()+INTERVAL '5 minutes') RETURNING expires_at`,
    [quoteId,req.user.id,uploadId,to,name,sha256(parsed.bytes),parsed.pages,amount.toString(),JSON.stringify(rate)]);
  return {billing_enabled:true,dynamic:rate.dynamic===true,quote_id:quoteId,pages:parsed.pages,amount_usd:microToUsd(amount),
    sell_usd_per_page:microToUsd(sellRate(rate)),balance_usd:microToUsd(await balance(req.user.id)),expires_at:saved.rows[0].expires_at};
}

async function settleFax(faxId) {
  await actual.settle(faxId,transaction,ledger);
  return transaction(async client => {
    const result = await client.query(`SELECT b.*,f.status,f.direction,f.to_number FROM netphone_fax_billing b
      JOIN netphone_faxes f ON f.id=b.fax_id WHERE b.fax_id=$1 FOR UPDATE OF b`,[faxId]);
    const bill = result.rows[0];
    if (!bill || bill.rate_snapshot?.dynamic || bill.direction !== "outbound" || bill.state !== "prepaid") return;
    if (!bill.submit_started_at && Date.now()-new Date(bill.created_at).getTime()>120000) {
      const expired = await client.query(`UPDATE netphone_faxes SET status='failed',failure_reason='Submission did not start'
        WHERE id=$1 AND status='queued' AND telnyx_fax_id IS NULL RETURNING id`,[faxId]);
      if (expired.rows[0]) bill.status = "failed";
    }
    if (bill.status === "delivered") {
      await client.query("UPDATE netphone_fax_billing SET state='paid',updated_at=NOW() WHERE fax_id=$1",[faxId]);
    } else if (bill.status === "failed") {
      const tx = await ledger(client,bill.user_id,BigInt(bill.amount_microusd),"fax_refund",`netphone-fax:${faxId}:refund`,
        {fax_id:faxId,direction:"outbound",pages:bill.pages,to_phone_e164:bill.to_number,reason:"Fax failed"});
      await client.query("UPDATE netphone_fax_billing SET state='refunded',refunded_tx_id=$2,updated_at=NOW() WHERE fax_id=$1",[faxId,tx.id]);
    }
  });
}

async function sendOrContinue(req,res,next) {
  let fax = null, networkStarted = false, acceptedId = null;
  try {
    if (!(await settings()).billing_enabled) return next();
    const quoteId = String(req.body.quote_id || "");
    if (!UUID.test(quoteId)) throw fail("Update NetPhone and try sending again",409);
    for (const name of ["TELNYX_FAX_API_KEY","TELNYX_FAX_CONNECTION_ID","TELNYX_FAX_PHONE_NUMBER","FAX_PUBLIC_BASE_URL"])
      if (!process.env[name]) throw fail("Fax configuration is unavailable",503);
    const base = new URL(process.env.FAX_PUBLIC_BASE_URL);
    if (base.protocol !== "https:") throw fail("Secure fax configuration is required",503);
    const from = process.env.TELNYX_FAX_PHONE_NUMBER.trim();
    if (!/^\+[1-9]\d{7,14}$/.test(from)) throw fail("Fax number is unavailable",503);
    const consumed = await transaction(async client => {
      const result = await client.query("SELECT *,expires_at>NOW() AS valid FROM netphone_fax_quotes WHERE id=$1 AND user_id=$2 FOR UPDATE",[quoteId,req.user.id]);
      const q = result.rows[0];
      if (!q) throw fail("Fax quote not found",404);
      if (q.state === "submitted") return {fax:await ownedFax(req.user.id,q.fax_id,client),duplicate:true};
      if (!q.valid || Number(req.body.upload_id) !== Number(q.upload_id) || String(req.body.to_number).trim() !== q.to_number)
        throw fail("Fax quote expired. Try sending again",409);
      if (!(await settings(client)).billing_enabled) throw fail("Fax pricing changed. Try sending again",409);
      const current = await resolveRate(q.to_number,"outbound",client);
      if (String(current.id) !== String(q.rate_snapshot.id) || current.revision !== q.rate_snapshot.revision)
        throw fail("Fax pricing changed. Try sending again",409);
      const bytes = await fsp.readFile(filePath(UPLOADS,q.prepared_file_name));
      if (sha256(bytes) !== q.file_sha256) throw fail("Document changed. Upload it again",409);
      const upload = await client.query("UPDATE netphone_fax_uploads SET is_used=TRUE WHERE id=$1 AND user_id=$2 AND is_used=FALSE RETURNING id",[q.upload_id,req.user.id]);
      if (!upload.rows[0]) throw fail("Fax upload already submitted",409);
      const inserted = await client.query(`INSERT INTO netphone_faxes
        (user_id,sender_name,direction,from_number,to_number,status,file_name,pages,user_email,country_code)
        VALUES($1,$2,'outbound',$3,$4,'queued',$5,$6,$7,$8) RETURNING *`,
        [req.user.id,String(req.body.sender_name || "").trim().slice(0,150)||null,from,q.to_number,q.prepared_file_name,q.pages,
          String(req.body.user_email || "").trim().slice(0,255)||null,current.country_code]);
      const row = inserted.rows[0], amount = BigInt(q.amount_microusd);
      const tx = await ledger(client,req.user.id,amount,"fax_charge",`netphone-fax:${row.id}:send`,
        {fax_id:row.id,direction:"outbound",pages:q.pages,to_phone_e164:q.to_number,stage:"prepaid",sell_usd_per_page:microToUsd(sellRate(q.rate_snapshot))});
      await client.query(`INSERT INTO netphone_fax_billing(fax_id,user_id,pages,amount_microusd,rate_snapshot,state,charged_tx_id)
        VALUES($1,$2,$3,$4,$5::jsonb,'prepaid',$6)`,[row.id,req.user.id,q.pages,amount.toString(),JSON.stringify(q.rate_snapshot),tx.id]);
      await client.query("UPDATE netphone_fax_quotes SET state='submitted',fax_id=$2 WHERE id=$1",[quoteId,row.id]);
      return {fax:row,duplicate:false};
    });
    if (consumed.duplicate) return res.status(200).json({success:true,fax:publicFax(consumed.fax),duplicated:true});
    fax = consumed.fax;
    const token = await createMediaToken(fax.id);
    const started = await db.query("UPDATE netphone_fax_billing SET submit_started_at=NOW() WHERE fax_id=$1 AND state='prepaid' RETURNING fax_id",[fax.id]);
    if (!started.rows[0]) throw fail("Fax submission is unavailable",409);
    networkStarted = true;
    const sent = await provider.sendFax({to:fax.to_number,
      mediaUrl:`${process.env.FAX_PUBLIC_BASE_URL.replace(/\/+$/,"")}/api/fax/media/${encodeURIComponent(token.token)}`,
      clientState:`netphone-fax-${fax.id}`});
    acceptedId = sent?.data?.id;
    if (!acceptedId) throw fail("Fax submission is not confirmed",503);
    const saved = await db.query(`UPDATE netphone_faxes SET telnyx_fax_id=COALESCE(telnyx_fax_id,$2),updated_at=NOW()
      WHERE id=$1 AND (telnyx_fax_id IS NULL OR telnyx_fax_id=$2) RETURNING *`,[fax.id,acceptedId]);
    if (!saved.rows[0]) throw fail("Fax submission is not confirmed",503);
    await notify(req.user.id,fax.id,"Fax Submitted",`Your fax to ${fax.to_number} has been submitted.`,"fax_submitted");
    return res.status(201).json({success:true,message:"Fax submitted",fax:publicFax(saved.rows[0])});
  } catch (error) {
    const definiteFailure = !networkStarted || (error.response?.status >= 400 && error.response?.status < 500);
    if (fax && definiteFailure) {
      try {
        await db.query("UPDATE netphone_faxes SET status='failed',failure_reason='Fax could not be submitted',updated_at=NOW() WHERE id=$1 AND telnyx_fax_id IS NULL",[fax.id]);
        await settleFax(fax.id);
        await revokeMediaTokens(fax.id);
      } catch (_) {console.error("Fax refund will be retried");}
    } else if (fax) {
      try {
        await db.query("UPDATE netphone_faxes SET telnyx_fax_id=COALESCE(telnyx_fax_id,$2),failure_reason=CASE WHEN status='queued' THEN 'submission_unconfirmed' ELSE failure_reason END WHERE id=$1",[fax.id,acceptedId]);
      } catch (_) {}
    }
    const status = fax && !definiteFailure ? 503 : error.status || (fax ? 502 : 400);
    return res.status(status).json({success:false,fax_id:fax?.id || null,
      message:fax && !definiteFailure ? "Submission not confirmed. Check Fax History before trying again." : error.status ? error.message : "Unable to submit the fax"});
  }
}

async function billingInfo(req) {
  const faxId = id(req.params.faxId);
  await ownedFax(req.user.id,faxId);
  await settleFax(faxId);
  const result = await db.query("SELECT state,amount_microusd,pages,rate_snapshot,actual_settled FROM netphone_fax_billing WHERE fax_id=$1 AND user_id=$2",[faxId,req.user.id]);
  const bill = result.rows[0];
  return {billing_pending:bill?.rate_snapshot?.dynamic===true && !bill.actual_settled && !["free","refunded"].includes(bill.state),payment_required:bill?.state === "payment_due",state:bill?.state || "legacy",
    amount_microusd:String(bill?.amount_microusd || 0),amount_usd:microToUsd(bill?.amount_microusd || 0),pages:bill?.pages || null,receive_billing:await billingControl.receiveBilling(req)};
}
async function payIncoming(req) {
  const faxId = id(req.params.faxId);
  return transaction(async client => {
    const fax = await ownedFax(req.user.id,faxId,client);
    const result = await client.query("SELECT * FROM netphone_fax_billing WHERE fax_id=$1 AND user_id=$2 FOR UPDATE",[faxId,req.user.id]);
    const bill = result.rows[0];
    if (!bill || fax.direction !== "inbound") throw fail("Fax document not found",404);
    if (["paid","free"].includes(bill.state)) return {paid:true};
    if (bill.rate_snapshot?.dynamic && !bill.actual_settled) throw fail("Provider billing is pending. Please try again later",409);
    if (bill.state !== "payment_due" || String(req.body.expected_amount_microusd) !== String(bill.amount_microusd))
      throw fail("Review the receive fee again",409);
    const tx = await ledger(client,req.user.id,BigInt(bill.amount_microusd),"fax_charge",`netphone-fax:${faxId}:receive`,
      {fax_id:faxId,direction:"inbound",pages:bill.pages,from_phone_e164:fax.from_number,sell_usd_per_page:microToUsd(sellRate(bill.rate_snapshot))});
    await client.query("UPDATE netphone_fax_billing SET state='paid',charged_tx_id=$2,updated_at=NOW() WHERE fax_id=$1",[faxId,tx.id]);
    return {paid:true};
  });
}

async function receiveProfile(req) {
  await db.query("INSERT INTO netphone_fax_receivers(user_id,receive_code) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING",
    [req.user.id,`NP-${crypto.randomBytes(8).toString("hex").toUpperCase()}`]);
  const result = await db.query("SELECT receive_code FROM netphone_fax_receivers WHERE user_id=$1",[req.user.id]);
  return {receive_code:result.rows[0].receive_code,fax_number:process.env.TELNYX_FAX_PHONE_NUMBER || "",is_admin:req.user.role === "admin"};
}
async function saveRate(req) {
  if((await settings()).actual_billing)throw fail("Use Import Fax SIP Deck. Old per-page rates are retained for audit only",409);
  const body = req.body;
  const prefix = String(body.phone_prefix || "").trim().replace(/^\+/,"");
  const countryCode = String(body.country_code || "").trim().toUpperCase();
  const countryName = String(body.country_name || "").trim();
  if (!/^[1-9]\d{0,14}$/.test(prefix) || !/^[A-Z0-9-]{2,10}$/.test(countryCode) || !countryName || countryName.length > 120)
    throw fail("Enter a valid country/region and phone prefix");
  if (!["outbound","inbound"].includes(body.direction)) throw fail("Choose Send or Receive");
  let cost;
  try {cost = usdToMicro(body.provider_cost_usd_per_page);} catch (error) {throw fail(error.message,400);}
  const markup = 40;
  const manual = null; // Fax prices are always derived from cost + 40%.
  if (body.is_active && body.cost_confirmed !== true) throw fail("Confirm the total cost before activating this rate");
  return transaction(async client => {
    const values = [countryCode,countryName,prefix,body.direction,cost.toString(),Math.round(markup*100),manual?.toString()||null,body.cost_confirmed === true,body.is_active === true];
    let saved;
    if (body.id) {
      saved = await client.query(`UPDATE netphone_fax_rates SET country_code=$1,country_name=$2,phone_prefix=$3,direction=$4,
        provider_cost_microusd_per_page=$5,markup_basis_points=$6,manual_sell_microusd_per_page=$7,cost_confirmed=$8,
        is_active=$9,revision=revision+1,updated_at=NOW() WHERE id=$10 AND revision=$11 RETURNING *`,[...values,id(body.id),Number(body.revision)]);
      if (!saved.rows[0]) throw fail("Rate changed. Refresh before saving",409);
    } else saved = await client.query(`INSERT INTO netphone_fax_rates(country_code,country_name,phone_prefix,direction,
      provider_cost_microusd_per_page,markup_basis_points,manual_sell_microusd_per_page,cost_confirmed,is_active)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,values);
    await audit(client,req.user.id,"rate_saved",null,{rate_id:saved.rows[0].id});
    return {rate:ratePublic(saved.rows[0])};
  });
}
async function adminRates() {
  const rates = await db.query("SELECT * FROM netphone_fax_rates ORDER BY country_name,phone_prefix,direction");
  return {rates:rates.rows.map(ratePublic),...(await settings())};
}
async function updateSettings(req) {
  if (req.body.billing_enabled !== true) throw fail("Fax charging is always enabled",409);
  return {billing_enabled:true};
}
async function adminInbox() {
  const result = await db.query(`SELECT f.id,f.from_number,f.to_number,f.pages,f.status,f.created_at,
    f.user_id,i.source,i.assigned_at,u.phone_e164 AS assigned_phone FROM netphone_fax_incoming i
    JOIN netphone_faxes f ON f.id=i.fax_id LEFT JOIN users u ON u.id=f.user_id
    WHERE f.user_id IS NULL ORDER BY f.created_at DESC LIMIT 100`);
  return {faxes:result.rows};
}
async function assignIncoming(req) {
  const faxId = id(req.params.faxId), code = String(req.body.receive_code || "").trim().toUpperCase();
  const reference = String(req.body.verified_reference || "").trim();
  if (req.body.recipient_verified !== true || reference.length < 5 || reference.length > 300)
    throw fail("Verify the Receive ID and intended recipient on the fax before assigning it");
  const assigned = await transaction(async client => {
    const target = await client.query(`SELECT r.user_id,u.status,u.phone_e164 FROM netphone_fax_receivers r
      JOIN users u ON u.id=r.user_id WHERE r.receive_code=$1`,[code]);
    if (!target.rows[0] || target.rows[0].status !== "active") throw fail("Active recipient not found",404);
    const user = target.rows[0];
    const found = await client.query(`SELECT f.*,i.assigned_at FROM netphone_faxes f
      JOIN netphone_fax_incoming i ON i.fax_id=f.id WHERE f.id=$1 FOR UPDATE OF f,i`,[faxId]);
    const fax = found.rows[0];
    if (!fax) throw fail("Incoming fax not found",404);
    if (fax.user_id != null) {
      if (String(fax.user_id) !== String(user.user_id)) throw fail("Already assigned. Recipient cannot be changed",409);
      return {user,fax,duplicate:true};
    }
    const enabled = (await settings(client)).billing_enabled;
    if (req.body.waive_fee === true) throw fail("New fax fees cannot be waived",409);
    const waived = false;
    const rate = enabled && !waived ? await resolveRate(fax.to_number,"inbound",client) : null;
    const amount = rate ? feeForPages(rate,Number(fax.pages)) : 0n;
    await client.query("UPDATE netphone_faxes SET user_id=$2,updated_at=NOW() WHERE id=$1",[faxId,user.user_id]);
    await client.query("UPDATE netphone_fax_incoming SET assigned_by=$2,assigned_at=NOW(),verified_reference=$3 WHERE fax_id=$1",[faxId,req.user.id,reference]);
    await client.query(`INSERT INTO netphone_fax_billing(fax_id,user_id,pages,amount_microusd,rate_snapshot,state)
      VALUES($1,$2,$3,$4,$5::jsonb,$6)`,[faxId,user.user_id,fax.pages,amount.toString(),JSON.stringify(rate || {}),amount>0n ? "payment_due" : "free"]);
    await audit(client,req.user.id,"incoming_assigned",faxId,{user_id:user.user_id,receive_code:code,waived,verified_reference:reference});
    return {user,fax,duplicate:false};
  });
  if (!assigned.duplicate) await notify(assigned.user.user_id,faxId,"Fax Received",`A fax from ${assigned.fax.from_number} is available in your private Fax History.`);
  return {assigned:true};
}

const coverAttempts = new Map();
async function routePendingCovers() {
 const pending=await db.query(`SELECT f.*,i.vault_file_name,i.file_sha256,i.source FROM netphone_fax_incoming i
 JOIN netphone_faxes f ON f.id=i.fax_id WHERE f.user_id IS NULL ORDER BY f.created_at DESC LIMIT 50`);
 let scanned=0;
 for(const fax of pending.rows){
  // Both sources pass provider identity/status/page-count checks on import.
  // A valid, unused account-bound QR remains mandatory for ownership.
  if(!['provider_media','legacy_archive'].includes(fax.source))continue;
  if(Date.now()<(coverAttempts.get(String(fax.id))||0))continue;
  if(scanned++>=2)break;
  coverAttempts.set(String(fax.id),Date.now()+300000);
  if(coverAttempts.size>1000)coverAttempts.delete(coverAttempts.keys().next().value);
  try {
   const codes=await cover.decodeCover(await privateBytes(fax.vault_file_name,fax.file_sha256));
   const assigned=await transaction(async client=>{
    const locked=await client.query('SELECT * FROM netphone_faxes WHERE id=$1 FOR UPDATE',[fax.id]);
    const current=locked.rows[0];if(!current || current.user_id!=null)return null;
    const code=await cover.resolveCode(client,codes,current);
    if(!code){console.error('Fax cover routing:',String(fax.id),'no_valid_unused_recipient_cover');return null;}
    const enabled=(await settings(client)).billing_enabled;
    const rate=enabled?await resolveRate(current.to_number,'inbound',client):null;
    const amount=rate?feeForPages(rate,Number(current.pages)):0n;
    await client.query('UPDATE netphone_faxes SET user_id=$2,updated_at=NOW() WHERE id=$1',[fax.id,code.user_id]);
    await client.query("UPDATE netphone_fax_incoming SET assigned_at=NOW(),verified_reference='Valid one-time cover QR' WHERE fax_id=$1",[fax.id]);
    await client.query(`INSERT INTO netphone_fax_billing(fax_id,user_id,pages,amount_microusd,rate_snapshot,state)
     VALUES($1,$2,$3,$4,$5::jsonb,$6)`,[fax.id,code.user_id,current.pages,amount.toString(),JSON.stringify(rate||{}),amount>0n?'payment_due':'free']);
    await client.query('UPDATE netphone_fax_cover_codes SET consumed_fax_id=$2 WHERE id=$1',[code.id,fax.id]);
    await audit(client,null,'cover_auto_assigned',fax.id,{user_id:code.user_id,cover_id:code.id});
    return code.user_id;
   });
   if(assigned){
    // Ownership is committed first. Payment failure must not undo routing.
    try {await actual.settle(fax.id,transaction,ledger);}
    catch(error){console.error('Fax receive billing retry:',String(fax.id),error.code||error.status||'review_required');}
    await notify(assigned,fax.id,'Fax Received','A fax is available in your private Fax History.');
   }
  }catch(error){console.error('Cover routing pending admin review:',String(fax.id),error.code || error.status || 'scan_or_pricing_unavailable');}
 }
}

async function scanIncoming() {
  let names;
  try {names = await fsp.readdir(ARCHIVE);} catch (error) {if (error.code === "ENOENT") return 0; throw error;}
  names = names.filter(name => /^fax_[0-9a-f-]{36}_\d+\.pdf$/i.test(name))
    .sort((a,b) => Number(b.split("_")[2].slice(0,-4))-Number(a.split("_")[2].slice(0,-4)));
  let attempted=0, imported=0;
  for (const name of names) {
    const faxId = name.split("_")[1];
    if (!UUID.test(faxId)) continue;
    if (Date.now() < (importAttempts.get(faxId)||0)) continue;
    const exists = await db.query("SELECT id FROM netphone_faxes WHERE telnyx_fax_id=$1",[faxId]);
    if (exists.rows[0]) continue;
    if (attempted++ >= 3) break;
    if (importAttempts.size > 1000) importAttempts.delete(importAttempts.keys().next().value);
    importAttempts.set(faxId,Date.now()+60000);
    try {
      const fax = await provider.getFax(faxId);
      if (fax.direction !== "inbound" || fax.to !== String(process.env.TELNYX_FAX_PHONE_NUMBER || "").trim() ||
        String(fax.connection_id) !== String(process.env.TELNYX_FAX_CONNECTION_ID)) {
        importAttempts.set(faxId,Date.now()+3600000); continue;
      }
      if (provider.normalizeFaxStatus(fax.status) !== "received") continue;
      const original = filePath(ARCHIVE,name), stat = await fsp.lstat(original);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 30*1024*1024) continue;
      let bytes, source = "legacy_archive";
      const remote = fax.stored_media_url || fax.media_url;
      if (remote) {
        try {
          const url = new URL(remote);
          if (url.protocol === "https:" && /(^|\.)(amazonaws\.com|telnyx\.com|telnyxcloudstorage\.com)$/.test(url.hostname)) {
            const response = await axios.get(url.toString(),{responseType:"arraybuffer",timeout:15000,
              maxContentLength:30*1024*1024,maxRedirects:0,proxy:false});
            bytes = Buffer.from(response.data); source = "provider_media";
          }
        } catch (_) {}
      }
      if (!bytes) bytes = await fsp.readFile(original);
      const parsed = await readPdf(bytes);
      if (fax.page_count != null && Number(fax.page_count) !== parsed.pages) continue;
      const vaultName = await storePrivate(parsed.bytes);
      await transaction(async client => {
        const row = await client.query(`INSERT INTO netphone_faxes
          (direction,from_number,to_number,telnyx_fax_id,status,file_name,pages,created_at)
          VALUES('inbound',$1,$2,$3,'received',$4,$5,$6) ON CONFLICT(telnyx_fax_id) DO NOTHING RETURNING id`,
          [fax.from,fax.to,faxId,vaultName,parsed.pages,fax.created_at || new Date()]);
        if (!row.rows[0]) return;
        await client.query("INSERT INTO netphone_fax_incoming(fax_id,vault_file_name,file_sha256,source) VALUES($1,$2,$3,$4)",
          [row.rows[0].id,vaultName,sha256(parsed.bytes),source]);
        imported++;
      });
    } catch (error) {
      if (error.response?.status >= 400 && error.response?.status < 500) importAttempts.set(faxId,Date.now()+3600000);
      console.error("Incoming fax import needs retry or admin review");
    }
  }
  return imported;
}
async function workCycle() {
  if (cyclePromise) return cyclePromise;
  cyclePromise = (async () => {
    // Route documents before slow reporting/network sync; failures stay isolated.
    try {await scanIncoming();} catch (_) {console.error('Incoming fax scan needs retry');}
    try {await routePendingCovers();} catch (_) {console.error('Fax cover routing needs retry');}
    const pending = await db.query(`SELECT f.*,b.submit_started_at FROM netphone_fax_billing b
      JOIN netphone_faxes f ON f.id=b.fax_id WHERE b.state='prepaid' ORDER BY b.created_at LIMIT 30`);
    let lookedUp = 0;
    for (let fax of pending.rows) {
      try {
      if (!["delivered","failed"].includes(fax.status) && fax.telnyx_fax_id && lookedUp++<3) {
        try {await require("../controllers/telnyxWebhook.controller").refreshFaxStatus(fax);} catch (_) {}
      }
      await settleFax(fax.id);
      } catch (_) {console.error("Fax settlement needs retry");}
    }
    try {await actual.cycle(transaction,ledger);} catch (_) {console.error("Fax billing reconciliation needs review");}
    return true;
  })().finally(() => {cyclePromise=null;});
  return cyclePromise;
}
function startWorker() {
  if (timer) return;
  const run = () => {void workCycle().catch(() => console.error("Fax background check unavailable"));};
  setTimeout(run,1500).unref(); timer = setInterval(run,30000); timer.unref();
}
function endpoint(fn) {
  return async (req,res) => {
    try {res.json({success:true,...(await fn(req))});}
    catch (error) {res.status(error.status || (error.code === "23505" ? 409 : 503)).json({success:false,
      message:error.status ? error.message : error.code === "23505" ? "This rate/record already exists" : "Fax service temporarily unavailable"});}
  };
}
function installRoutes(router) {
  const auth = faxAuthRequired, admin = [auth,faxAdminRequired];
  actual.install(router,admin,endpoint,transaction,audit,ledger,auth);
  router.post("/quote",auth,endpoint(quote));
  router.get("/receive-profile",auth,endpoint(receiveProfile));
  router.post("/receive-cover/revoke",auth,endpoint(async req=>{await cover.revoke(req.user.id);return {revoked:true};}));
  router.post("/receive-cover",auth,async(req,res)=>{
   try {
    if (await balance(req.user.id) <= 0n) throw fail("Recharge your wallet before creating a Receive cover",402);
    const profile=await receiveProfile(req);const bytes=await cover.createCover(req.user.id,req.body.recipient_name,profile);
    res.set({'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="NetPhone_Receive_Cover.pdf"','Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'}).send(bytes);
   }catch(error){res.status(error.status||503).json({success:false,message:error.status?error.message:'Cover page unavailable. Please try again.'});}
  });
  router.get("/billing/:faxId",auth,endpoint(billingInfo));
  router.post("/billing/:faxId/pay",auth,endpoint(payIncoming));
  router.get("/admin/rates",...admin,endpoint(adminRates));
  router.post("/admin/rates",...admin,endpoint(saveRate));
  router.patch("/admin/settings",...admin,endpoint(updateSettings));
  router.get("/admin/inbox",...admin,endpoint(adminInbox));
  router.post("/admin/inbox/scan",...admin,endpoint(async () => {void workCycle().catch(()=>{});return {scanning:true};}));
  router.post("/admin/inbox/:faxId/assign",...admin,endpoint(assignIncoming));
  router.get("/admin/inbox/:faxId/document",...admin,async (req,res) => {
    try {
      const faxId = id(req.params.faxId);
      const result = await db.query("SELECT * FROM netphone_fax_incoming WHERE fax_id=$1",[faxId]);
      if (!result.rows[0]) throw fail("Fax document not found",404);
      const row=result.rows[0], bytes=await privateBytes(row.vault_file_name,row.file_sha256);
      await audit(db,req.user.id,"admin_document_view",faxId);
      res.set({"Content-Type":"application/pdf","Content-Disposition":`inline; filename="Fax_${faxId}.pdf"`,
        "Cache-Control":"no-store, private","X-Content-Type-Options":"nosniff"}).send(bytes);
    } catch (error) {res.status(error.status || 503).json({success:false,message:error.status ? error.message : "Document unavailable"});}
  });
  startWorker();
}
module.exports = {installRoutes,sendOrContinue,loadIncomingDocument,
  _test:{adminInbox,routePendingCovers,workCycle,transaction,ledger,privateBytes,storePrivate,ownedFax,settleFax,saveRate,assignIncoming,payIncoming,quote,readPdf,updateSettings,installRoutes}};
