'use strict';
const crypto=require('crypto');
const axios=require('axios');
const multer=require('multer');
const zlib=require('zlib');
function csvText(file){return (file.originalname.endsWith('.gz') ? zlib.gunzipSync(file.buffer,{maxOutputLength:48*1024*1024}) : file.buffer).toString('utf8');}
const db=require('../database/db');
const math=require('./faxBillingMath');
const {microToUsd}=require('./faxMoney');
const fail=(m,s=422)=>Object.assign(new Error(m),{status:s});
let syncPromise=null,lastAttempt=0;
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:48*1024*1024,files:1}}).single('file');
async function settings(client=db){return (await client.query('SELECT * FROM netphone_fax_settings WHERE id=1')).rows[0];}
async function route(phone,direction,client=db){
 const s=await settings(client);
 if(!s.deck_version)throw fail('Import the Fax SIP rate deck first');
 if(direction==='inbound')return {id:'actual-inbound',revision:s.deck_version,country_code:'US',dynamic:true,provider_cost_microusd_per_page:s.fax_api_microusd,api:s.fax_api_microusd};
 const digits=math.phone(phone);const prefixes=Array.from({length:digits.length},(_,i)=>digits.slice(0,i+1));
 const rows=(await client.query('SELECT route FROM netphone_fax_deck WHERE version=$1 AND prefix=ANY($2::text[])',[s.deck_version,prefixes])).rows.map(x=>x.route);
 let r;try{r=math.select(rows,phone,process.env.TELNYX_FAX_PHONE_NUMBER);}catch(e){throw fail(e.message);}
 return {id:'actual-send',revision:s.deck_version,country_code:r.iso.split('/')[0],dynamic:true,provider_cost_microusd_per_page:s.fax_api_microusd,api:s.fax_api_microusd,route:r,seconds:s.estimate_seconds_per_page};
}
function fee(rate,pages){return math.estimate(rate.route,pages,rate.seconds,rate.api);}
async function importDeck(req,transaction,audit){
 if(!req.file)throw fail('Choose a CSV');
 let rows;try{rows=math.csv(csvText(req.file)).map(math.deckRow);}catch(e){throw fail(e.message);}
 if(!rows.length)throw fail('Empty rate deck');
 const version=crypto.randomUUID();
 await transaction(async c=>{
  await c.query('SELECT id FROM netphone_fax_settings WHERE id=1 FOR UPDATE');
  for(let i=0;i<rows.length;i+=1000){const chunk=rows.slice(i,i+1000).map((r,j)=>({ordinal:i+j,prefix:r.prefix.match(/^[0-9]+/)[0],route:r}));
   await c.query(`INSERT INTO netphone_fax_deck(version,ordinal,prefix,route)
    SELECT $1,x.ordinal,x.prefix,x.route FROM jsonb_to_recordset($2::jsonb) AS x(ordinal integer,prefix text,route jsonb)`,[version,JSON.stringify(chunk)]);
  }
  await c.query('UPDATE netphone_fax_settings SET deck_version=$1,updated_at=NOW() WHERE id=1',[version]);
  await c.query('DELETE FROM netphone_fax_deck WHERE version<>$1',[version]);
  await audit(c,req.user.id,'fax_deck_import',null,{version,rows:rows.length});
 });
 return {version,rows:rows.length};
}
async function store(records,source,transaction){
 let accepted=0,unrelated=0;
 await transaction(async c=>{
  for(const r of records){
   if(r.connection!==String(process.env.TELNYX_FAX_CONNECTION_ID||'')){unrelated++;continue;}
   const destination=r.direction==='inbound'?r.to:r.from;
   if(destination!==math.phone(process.env.TELNYX_FAX_PHONE_NUMBER)){unrelated++;continue;}
   const values=[r.kind,r.key,r.session,r.fax_id,r.direction,r.from,r.to,r.cost,r.connection,source];
   const old=(await c.query('SELECT * FROM netphone_fax_usage WHERE kind=$1 AND record_key=$2 FOR UPDATE',[r.kind,r.key])).rows[0];
   if(old){if(String(old.cost_microusd)!==r.cost||String(old.session_id)!==r.session||old.direction!==r.direction||old.from_number!==r.from||old.to_number!==r.to||String(old.connection_id)!==r.connection)throw fail('Provider usage record changed. Admin review required',409);if(source==='api')await c.query("UPDATE netphone_fax_usage SET source='api' WHERE kind=$1 AND record_key=$2",[r.kind,r.key]);continue;}
   const inserted=await c.query(`INSERT INTO netphone_fax_usage(kind,record_key,session_id,fax_provider_id,direction,from_number,to_number,cost_microusd,connection_id,source)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING record_key`,values);
   if(inserted.rows[0])accepted++;
   else {
    const collision=(await c.query('SELECT * FROM netphone_fax_usage WHERE kind=$1 AND record_key=$2 FOR UPDATE',[r.kind,r.key])).rows[0];
    if(!collision || String(collision.cost_microusd)!==r.cost || String(collision.session_id)!==r.session || collision.direction!==r.direction || collision.from_number!==r.from || collision.to_number!==r.to || String(collision.connection_id)!==r.connection)throw fail('Concurrent usage import conflict; admin review required',409);
   }
  }
 });return {accepted,unrelated};
}
async function importUsage(req,transaction,audit){
 if(!req.file)throw fail('Choose a CSV');
 let rows,kind;try{rows=math.csv(csvText(req.file),20000);kind=rows[0]&&Object.hasOwn(rows[0],'fax id')?'fax':'sip';}catch(e){throw fail(e.message);}
 if(!rows.length)throw fail('Empty usage report');
 const records=[];let rejected=0;
 for(const row of rows){try{records.push(math.usage(row,kind));}catch(_){rejected++;}}
 const result=await store(records,'csv',transaction);
 await audit(db,req.user.id,'fax_usage_import',null,{...result,rejected,kind});
 return {...result,rejected,kind};
}
async function actualCost(fax,client=db){
 let api=(await client.query("SELECT * FROM netphone_fax_usage WHERE kind='fax' AND fax_provider_id=$1",[fax.telnyx_fax_id])).rows;
 if(api.some(x=>x.source==='api'))api=api.filter(x=>x.source==='api');
 if(api.length!==1)return null;
 const f=api[0];
 if(f.direction!==fax.direction||f.from_number!==math.phone(fax.from_number)||f.to_number!==math.phone(fax.to_number)||f.connection_id!==String(process.env.TELNYX_FAX_CONNECTION_ID||''))return null;
 let sip=(await client.query("SELECT * FROM netphone_fax_usage WHERE kind='sip' AND session_id=$1",[f.session_id])).rows;
 if(sip.some(x=>x.source==='api'))sip=sip.filter(x=>x.source==='api');
 if(!sip.length)return null;
 if(sip.some(s=>s.direction!==f.direction||s.from_number!==f.from_number||s.to_number!==f.to_number||s.connection_id!==f.connection_id))return null;
 return BigInt(f.cost_microusd)+sip.reduce((n,x)=>n+BigInt(x.cost_microusd),0n);
}
async function settle(faxId,transaction,ledger){
 return transaction(async c=>{
  const b=(await c.query(`SELECT b.*,f.status,f.direction,f.from_number,f.to_number,f.telnyx_fax_id
   FROM netphone_fax_billing b JOIN netphone_faxes f ON f.id=b.fax_id WHERE b.fax_id=$1 FOR UPDATE OF b`,[faxId])).rows[0];
  if(!b||!b.rate_snapshot?.dynamic||b.actual_settled||['free','refunded'].includes(b.state))return false;
  if(b.direction==='outbound' && !b.submit_started_at && !b.telnyx_fax_id && b.status==='queued' && Date.now()-new Date(b.created_at).getTime()>120000){
   const expired=await c.query("UPDATE netphone_faxes SET status='failed',failure_reason='Submission did not start' WHERE id=$1 AND status='queued' AND telnyx_fax_id IS NULL RETURNING id",[faxId]);
   if(expired.rows[0])b.status='failed';
  }
  if(!['delivered','received','failed'].includes(b.status))return false;
  let cost=await actualCost(b,c);
  if(cost===null){
   // Definitively rejected before Telnyx assigned an ID: no provider work to reconcile.
   if(b.status==='failed'&&!b.telnyx_fax_id)cost=0n;else return false;
  }
  const target=math.markup(cost);let charge=target,shortfall=0n;
  if(b.direction==='outbound'){
   const reserved=BigInt(b.amount_microusd);charge=target>reserved?reserved:target;
   shortfall=target-charge;
   if(reserved>charge)await ledger(c,b.user_id,reserved-charge,'fax_refund',`netphone-fax:${faxId}:actual-refund`,{fax_id:faxId,stage:'actual_settlement'});
  }
  const state=b.direction==='outbound'?(charge===0n?'refunded':'paid'):(charge===0n?'free':'payment_due');
  await c.query(`UPDATE netphone_fax_billing SET amount_microusd=$2,provider_cost_microusd=$3,target_charge_microusd=$4,
   operator_shortfall_microusd=$5,actual_settled=TRUE,state=$6,billing_note=$7,updated_at=NOW() WHERE fax_id=$1`,
   [faxId,charge.toString(),cost.toString(),target.toString(),shortfall.toString(),state,shortfall>0n?'Quote ceiling exceeded: operator absorbs difference':'Actual Fax API + SIP cost, 40% markup']);
  return true;
 });
}
async function sync(transaction){
 if(syncPromise)return syncPromise;
 syncPromise=(async()=>{
  const key=process.env.TELNYX_FAX_API_KEY;if(!key)throw fail('Fax API key unavailable',503);
  let total=0;const records=[];const signal=AbortSignal.timeout(150000);
  // Official detail-record filters. If schema/permission differs, stop instead of guessing charges.
  for(const type of ['fax','sip-trunking'])for(const date of ['today','yesterday']){
   for(let page=1;page<=30;page++){
    const response=await axios.get('https://api.telnyx.com/v2/detail_records',{headers:{Authorization:`Bearer ${key}`},
     signal,params:{'filter[record_type]':type,'filter[date_range]':date,'page[number]':page,'page[size]':100},timeout:12000,maxContentLength:4*1024*1024,maxRedirects:0});
    const data=response.data;if(!Array.isArray(data?.data))throw fail('Unverified Telnyx billing response',503);
    for(const row of data.data){
     const connection=math.get(row,'connection_id','connection id');
     if(connection!==String(process.env.TELNYX_FAX_CONNECTION_ID||''))continue;
     try{records.push(math.usage(row,type==='fax'?'fax':'sip'));}catch(_){throw fail('Telnyx billing fields need verification; upload Fax and Calls CSV reports',503);}
    }
    const last=Number(data.meta?.total_pages);
    if(!Number.isInteger(last)||last<0)throw fail('Unverified billing pagination',503);
    if(page>=last)break;if(page===30)throw fail('Billing report exceeds sync limit; import CSV',503);
   }
  }
  const result=await store(records,'api',transaction);total=result.accepted;
  const candidates=(await db.query(`SELECT f.* FROM netphone_faxes f JOIN netphone_fax_usage a ON a.kind='fax' AND a.fax_provider_id=f.telnyx_fax_id
   WHERE a.source='api' AND EXISTS(SELECT 1 FROM netphone_fax_usage s WHERE s.kind='sip' AND s.session_id=a.session_id AND s.source='api') LIMIT 20`)).rows;
  const directions=new Set();
  for(const fax of candidates)if(await actualCost(fax)!==null)directions.add(fax.direction);
  const proof=directions.has('inbound') && directions.has('outbound');
  await db.query('UPDATE netphone_fax_settings SET last_usage_sync=NOW(),usage_sync_error=NULL,adapter_verified=$1 WHERE id=1',[Boolean(proof)]);
  return {accepted:total,adapter_verified:Boolean(proof)};
 })().catch(async e=>{await db.query('UPDATE netphone_fax_settings SET usage_sync_error=$1 WHERE id=1',[String(e.status?e.message:'Telnyx usage sync failed; check API reporting permissions').slice(0,300)]);throw e;}).finally(()=>{syncPromise=null;});
 return syncPromise;
}
async function cycle(transaction,ledger){
 if(Date.now()-lastAttempt>300000){lastAttempt=Date.now();void sync(transaction).catch(()=>{}); /* Incoming routing is never blocked by reporting. */}
 const pending=(await db.query("SELECT fax_id FROM netphone_fax_billing WHERE rate_snapshot->>'dynamic'='true' AND actual_settled=FALSE AND state IN ('prepaid','payment_due') ORDER BY created_at LIMIT 50")).rows;
 for(const x of pending)await settle(x.fax_id,transaction,ledger);
}
async function status(){
 const s=await settings();const bills=(await db.query(`SELECT b.fax_id,b.state,b.amount_microusd,b.provider_cost_microusd,b.operator_shortfall_microusd,b.actual_settled,f.direction
 FROM netphone_fax_billing b JOIN netphone_faxes f ON f.id=b.fax_id WHERE b.rate_snapshot->>'dynamic'='true' ORDER BY b.created_at DESC LIMIT 50`)).rows;
 return {deck_version:s.deck_version,adapter_verified:s.adapter_verified,last_usage_sync:s.last_usage_sync,usage_sync_error:s.usage_sync_error,
  estimate_seconds_per_page:s.estimate_seconds_per_page,bills:bills.map(b=>({...b,amount_usd:microToUsd(b.amount_microusd),shortfall_usd:microToUsd(b.operator_shortfall_microusd)}))};
}
function install(router,admin,endpoint,transaction,audit,ledger){
 const multipart=(fn)=>(req,res,next)=>upload(req,res,e=>e?res.status(400).json({success:false,message:'Upload one CSV under 48 MB'}):endpoint(fn)(req,res,next));
 router.get('/admin/actual-billing',...admin,endpoint(status));
 router.post('/admin/fax-deck',...admin,multipart(req=>importDeck(req,transaction,audit)));
 router.post('/admin/fax-usage',...admin,multipart(async req=>{const r=await importUsage(req,transaction,audit);await cycle(transaction,ledger);return r;}));
 router.post('/admin/fax-usage/sync',...admin,endpoint(async()=>{const r=await sync(transaction);await cycle(transaction,ledger);return r;}));
 router.patch('/admin/actual-billing',...admin,endpoint(async req=>{
  const seconds=Number(req.body.estimate_seconds_per_page);
  if(!Number.isInteger(seconds)||seconds<60||seconds>3600)throw fail('Estimate must be 60–3600 seconds per page');
  await db.query('UPDATE netphone_fax_settings SET estimate_seconds_per_page=$1,updated_at=NOW() WHERE id=1',[seconds]);
  await audit(db,req.user.id,'fax_estimate_updated',null,{seconds});return {saved:true};
 }));
}
module.exports={route,fee,settle,cycle,install,settings,sync,actualCost,store};
