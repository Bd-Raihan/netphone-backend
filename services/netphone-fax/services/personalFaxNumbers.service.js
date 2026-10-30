'use strict';
const crypto=require('crypto');
const provider=require('./personalFaxProvider');
const policy=require('./personalFaxPolicy');
const {fail,usd,MONTHLY,LEAD_MS,monthStart,nextMonth,initialPeriods}=policy;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const openStates=['reserved','ordering','active','release_pending'];
const one=async(c,q,p=[]) => (await c.query(q,p)).rows[0];
let context,timer,working=false;
let schemaUntil=0,schemaReady=false;
async function hasSchema(db) {
  if(Date.now()<schemaUntil)return schemaReady;
  schemaReady=!!(await one(db,"SELECT to_regclass('public.netphone_personal_fax_numbers') AS present"))?.present;
  schemaUntil=Date.now()+30000;return schemaReady;
}
async function audit(c,n,actor,action,details={}) {
  await c.query('INSERT INTO netphone_personal_fax_audit(number_id,actor_user_id,action,details) VALUES($1,$2,$3,$4::jsonb)',[n.id,actor,action,JSON.stringify(details)]);
}
// Separate transaction types keep rental receipts distinct from fax usage and refunds.
async function money(c,user,amount,credit,key,title,details={}) {
  amount=BigInt(amount);if(amount<0n)throw fail('Invalid rental amount',503);if(amount===0n)return null;
  const w=await one(c,'SELECT * FROM wallets WHERE user_id=$1 FOR UPDATE',[user]);
  if(!w||w.currency!=='USD')throw fail('A USD wallet is required',402);
  const type=credit?'fax_number_refund':'fax_number_charge';
  const old=await one(c,'SELECT * FROM wallet_transactions WHERE user_id=$1 AND idempotency_key=$2',[user,key]);
  if(old){if(old.type!==type||BigInt(old.amount_microusd)!==amount)throw fail('Rental payment conflict',409);return old;}
  const after=BigInt(w.balance_microusd)+(credit?amount:-amount);
  if(after<0n)throw fail('Insufficient wallet balance',402);
  const cents=n=>((n+5000n)/10000n).toString();
  const meta={...details,service:'fax_number',display_title:title,flow:credit?'credit':'debit',exact_wallet_amount:{amount_microusd:amount.toString(),amount_usd:usd(amount),balance_after_microusd:after.toString(),balance_after_usd:usd(after)}};
  const tx=await one(c,`INSERT INTO wallet_transactions(user_id,type,amount_cents,amount_microusd,reference,idempotency_key,status,balance_after_cents,balance_after_microusd,meta)
    VALUES($1,$2,$3,$4,$5::text,$5::text,'posted',$6,$7,$8::jsonb) RETURNING *`,[user,type,cents(amount),amount.toString(),key,cents(after),after.toString(),JSON.stringify(meta)]);
  await c.query('UPDATE wallets SET balance_microusd=$2,balance_cents=$3,updated_at=NOW() WHERE user_id=$1',[user,after.toString(),cents(after)]);
  return tx;
}
function publicNumber(n) {
  if(!n)return null;
  return {id:n.id,phone_number:n.phone_number,state:n.state,monthly_usd:usd(n.monthly_microusd),
    paid_until:n.paid_until,next_charge_at:n.state==='active'?new Date(new Date(n.paid_until).getTime()-LEAD_MS).toISOString():null,
    cancel_requested:!!n.cancel_requested_at,review_required:!!n.review_reason,created_at:n.created_at};
}
function signQuote(q) {
  const text=Buffer.from(JSON.stringify(q)).toString('base64url');
  return text+'.'+crypto.createHmac('sha256',provider.config().key).update('personal-fax-quote:'+text).digest('base64url');
}
function readQuote(token,user,now=Date.now()) {
  if(typeof token!=='string'||token.length>6000)throw fail('Number quote expired. Search again',409);
  const [text,signature,...extra]=token.split('.');
  const expected=signQuote(JSON.parse(Buffer.from(text||'','base64url').toString())).split('.')[1];
  const a=Buffer.from(signature||''),b=Buffer.from(expected);
  if(extra.length||a.length!==b.length||!crypto.timingSafeEqual(a,b))throw fail('Invalid number quote',409);
  const q=JSON.parse(Buffer.from(text,'base64url').toString());
  if(String(q.user)!==String(user)||q.expires<now||q.connection!==provider.config().connection||q.day!==new Date(now).toISOString().slice(0,10))throw fail('Number quote expired. Search again',409);
  return q;
}
function permitted(user) {
  const ids=String(process.env.PERSONAL_FAX_ALLOWED_USER_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);
  return !ids.length||ids.includes(String(user));
}
async function requirePurchase(db,user) {
  if(process.env.PERSONAL_FAX_PURCHASE_ENABLED!=='true')throw fail('Personal fax number purchases are not enabled yet',503);
  if(!permitted(user))throw fail('Personal fax numbers are not available for this account yet',403);
  if(!await hasSchema(db))throw fail('Personal fax number setup is incomplete',503);
  return provider.ready();
}
async function status(req) {
  const {db}=context;
  if(!await hasSchema(db))return {enabled:false,number:null};
  const n=await one(db,"SELECT * FROM netphone_personal_fax_numbers WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",[req.user.id]);
  let enabled=false;
  try{if(process.env.PERSONAL_FAX_PURCHASE_ENABLED==='true'&&permitted(req.user.id)){await provider.ready();enabled=true;}}catch(_){}
  return {enabled,number:publicNumber(n),monthly_usd:'1.000000',country:'US'};
}
async function search(req) {
  const {db}=context,c=await requirePurchase(db,req.user.id);
  const existing=await one(db,"SELECT id FROM netphone_personal_fax_numbers WHERE user_id=$1 AND state=ANY($2::text[])",[req.user.id,openStates]);
  if(existing)throw fail('You already have a personal fax number or pending request',409);
  const rows=(await provider.available()).map(policy.available).filter(Boolean);
  const periods=initialPeriods(),day=new Date().toISOString().slice(0,10);
  return {numbers:rows.slice(0,10).map(n=>{
    const q={user:String(req.user.id),phone:n.phone_number,upfront:n.upfront,periods,connection:c.connection,expires:Date.now()+300000,day};
    const total=BigInt(n.upfront)+periods.reduce((a,p)=>a+BigInt(p.amount),0n);
    return {phone_number:n.phone_number,setup_usd:usd(n.upfront),monthly_usd:'1.000000',
      periods:periods.map(p=>({...p,amount_usd:usd(p.amount)})),total_usd:usd(total),
      next_charge_at:new Date(new Date(periods.at(-1).end).getTime()-LEAD_MS).toISOString(),quote:signQuote(q)};
  })};
}
async function buy(req) {
  const {db,transaction}=context;
  const key=String(req.body.request_key||'');if(!UUID.test(key))throw fail('Invalid purchase request');
  if(!await hasSchema(db))throw fail('Personal fax number setup is incomplete',503);
  const duplicate=await one(db,'SELECT * FROM netphone_personal_fax_numbers WHERE user_id=$1 AND request_key=$2',[req.user.id,key]);
  if(duplicate)return {number:publicNumber(duplicate),duplicate:true};
  await requirePurchase(db,req.user.id);
  let q;try{q=readQuote(req.body.quote,req.user.id);}catch(e){throw fail(e.status?e.message:'Number quote expired. Search again',409);}
  const fresh=(await provider.available(q.phone)).map(policy.available).find(n=>n?.phone_number===q.phone);
  if(!fresh||fresh.upfront!==q.upfront)throw fail('Number availability or price changed. Search again',409);
  const n=await transaction(async c=>{
    await c.query('SELECT pg_advisory_xact_lock($1::bigint)',[req.user.id]);
    const old=await one(c,'SELECT * FROM netphone_personal_fax_numbers WHERE user_id=$1 AND request_key=$2',[req.user.id,key]);
    if(old)return old;
    const live=await one(c,'SELECT id FROM netphone_personal_fax_numbers WHERE user_id=$1 AND state=ANY($2::text[])',[req.user.id,openStates]);
    if(live)throw fail('You already have a personal fax number or pending request',409);
    const row=await one(c,`INSERT INTO netphone_personal_fax_numbers(id,user_id,request_key,phone_number,connection_id,state,upfront_microusd,initial_periods,paid_until)
      VALUES($1,$2,$3,$4,$5,'reserved',$6,$7::jsonb,$8) RETURNING *`,[crypto.randomUUID(),req.user.id,key,q.phone,q.connection,q.upfront,JSON.stringify(q.periods),q.periods.at(-1).end]);
    await money(c,row.user_id,row.upfront_microusd,false,`pfn:${row.id}:setup`,'Fax Number Setup',{number:row.phone_number});
    for(const p of q.periods)await chargePeriod(c,row,p);
    await audit(c,row,req.user.id,'purchase_reserved',{total_usd:usd(BigInt(q.upfront)+q.periods.reduce((s,p)=>s+BigInt(p.amount),0n))});
    return row;
  });
  return {number:publicNumber(n),message:'Payment reserved. Your number will appear after provider activation.'};
}
async function chargePeriod(c,n,p) {
  await money(c,n.user_id,p.amount,false,`pfn:${n.id}:rent:${p.start.slice(0,10)}`,'Fax Number Rental',
    {number:n.phone_number,period_start:p.start,period_end:p.end});
  await c.query(`INSERT INTO netphone_personal_fax_periods(number_id,period_start,period_end,amount_microusd)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[n.id,p.start,p.end,p.amount]);
}
async function cancel(req) {
  const {transaction}=context,id=String(req.params.numberId||'');if(!UUID.test(id))throw fail('Number not found',404);
  const n=await transaction(async c=>{
    const row=await one(c,'SELECT * FROM netphone_personal_fax_numbers WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,req.user.id]);
    if(!row)throw fail('Number not found',404);
    if(['released','failed'].includes(row.state)||row.cancel_requested_at)return row;
    const reason=String(req.body.reason||'').trim();
    if(reason.length<3||reason.length>300)throw fail('Enter a release reason (3–300 characters)');
    await audit(c,row,req.user.id,'release_requested',{reason});
    return one(c,`UPDATE netphone_personal_fax_numbers SET cancel_requested_at=NOW(),state=CASE WHEN state='active' THEN 'release_pending' ELSE state END,updated_at=NOW(),last_checked_at=NULL WHERE id=$1 RETURNING *`,[id]);
  });
  return {number:publicNumber(n),message:'Release requested. Completion will be shown after provider confirmation.'};
}
async function history(req) {
  if(!await hasSchema(context.db))return {history:[],next_before:null};
  const before=req.query?.before==null?null:String(req.query.before);
  if(before!==null&&(!/^[1-9]\d{0,18}$/.test(before)||BigInt(before)>9223372036854775807n))throw fail('Invalid history cursor');
  const rows=(await context.db.query(`SELECT a.id,a.number_id,n.phone_number,a.action,a.actor_user_id,a.details,a.created_at
    FROM netphone_personal_fax_audit a JOIN netphone_personal_fax_numbers n ON n.id=a.number_id
    WHERE n.user_id=$1 AND ($2::bigint IS NULL OR a.id<$2::bigint)
    ORDER BY a.id DESC LIMIT 51`,[req.user.id,before])).rows;
  const items=rows.slice(0,50);
  return {history:items,next_before:rows.length>50?String(items.at(-1).id):null};
}
async function refund(c,n,all) {
  if(all)await money(c,n.user_id,n.upfront_microusd,true,`pfn:${n.id}:setup-refund`,'Fax Number Setup Refund',{number:n.phone_number});
  const periods=(await c.query('SELECT * FROM netphone_personal_fax_periods WHERE number_id=$1 AND refunded=FALSE FOR UPDATE',[n.id])).rows;
  for(const p of periods) {
    if(!all&&new Date(p.period_start)<=new Date())continue;
    const day=new Date(p.period_start).toISOString().slice(0,10);
    await money(c,n.user_id,p.amount_microusd,true,`pfn:${n.id}:rent-refund:${day}`,'Fax Number Rental Refund',{number:n.phone_number,period_start:p.period_start});
    await c.query('UPDATE netphone_personal_fax_periods SET refunded=TRUE WHERE number_id=$1 AND period_start=$2',[n.id,p.period_start]);
  }
}
async function finish(n,state,all=false) {
  return context.transaction(async c=>{
    const row=await one(c,'SELECT * FROM netphone_personal_fax_numbers WHERE id=$1 FOR UPDATE',[n.id]);
    if(['released','failed'].includes(row.state))return;
    await refund(c,row,all);
    await c.query('UPDATE netphone_personal_fax_numbers SET state=$2,released_at=NOW(),review_reason=NULL,updated_at=NOW() WHERE id=$1',[n.id,state]);
    await audit(c,row,null,state);
  });
}
async function review(n,reason) {
  await context.db.query('UPDATE netphone_personal_fax_numbers SET review_reason=$2,updated_at=NOW() WHERE id=$1',[n.id,reason]);
  console.error('Personal fax number needs review:',n.id,reason);
}
async function activate(n,owned) {
  if(String(owned.connection_id)!==n.connection_id||owned.phone_number!==n.phone_number)throw fail('Provider number identity mismatch',503);
  if(owned.status!=='active')return;
  await context.transaction(async c=>{
    const row=await one(c,'SELECT * FROM netphone_personal_fax_numbers WHERE id=$1 FOR UPDATE',[n.id]);
    if(!['reserved','ordering'].includes(row.state))return;
    await c.query(`UPDATE netphone_personal_fax_numbers SET provider_number_id=$2,state=$3,activated_at=NOW(),review_reason=NULL,updated_at=NOW() WHERE id=$1`,
      [n.id,String(owned.id),row.cancel_requested_at?'release_pending':'active']);
    await audit(c,row,null,'activated',{provider_number_id:String(owned.id)});
  });
  await context.notify(n.user_id,null,'Personal Fax Number Ready',`${n.phone_number} is ready. Incoming faxes go directly to your Fax History.`);
}
async function order(n) {
  const {db}=context,ref='netphone-personal-'+n.id;
  if(!n.dispatch_started_at) {
    if(n.cancel_requested_at)return finish(n,'failed',true);
    // Do not submit a stale calendar-price reservation after a long outage.
    if(new Date(n.created_at).toISOString().slice(0,10)!==new Date().toISOString().slice(0,10))return finish(n,'failed',true);
    const saved=await one(db,"UPDATE netphone_personal_fax_numbers SET state='ordering',dispatch_started_at=NOW() WHERE id=$1 AND state='reserved' AND dispatch_started_at IS NULL AND cancel_requested_at IS NULL RETURNING *",[n.id]);
    if(!saved){
      const current=await one(db,'SELECT * FROM netphone_personal_fax_numbers WHERE id=$1',[n.id]);
      if(current?.cancel_requested_at&&!current.dispatch_started_at)return finish(current,'failed',true);
      return;
    }
    try {
      const result=(await provider.api('POST','/number_orders',{connection_id:n.connection_id,customer_reference:ref,phone_numbers:[{phone_number:n.phone_number}]})).data;
      if(result?.id)await db.query('UPDATE netphone_personal_fax_numbers SET provider_order_id=$2 WHERE id=$1',[n.id,String(result.id)]);
      else await review(n,'order_response_unconfirmed');
    } catch(e) {
      // Validation/auth rejection is definite. Timeouts, conflicts, rate limits and 5xx are ambiguous: never buy twice.
      if([400,401,403,422].includes(e.response?.status))return finish(n,'failed',true);
      await review(n,'order_response_unconfirmed');
    }
    return;
  }
  let orders;
  if(n.provider_order_id)orders=[(await provider.api('GET','/number_orders/'+encodeURIComponent(n.provider_order_id))).data];
  else orders=await provider.orders(ref);
  if(orders.length!==1){if(Date.now()-new Date(n.dispatch_started_at)>300000)await review(n,'order_lookup_requires_review');return;}
  const o=orders[0];
  if(o.customer_reference!==ref||String(o.connection_id)!==n.connection_id||!(o.phone_numbers||[]).some(p=>p.phone_number===n.phone_number))return review(n,'order_identity_mismatch');
  if(!n.provider_order_id)await db.query('UPDATE netphone_personal_fax_numbers SET provider_order_id=$2 WHERE id=$1',[n.id,String(o.id)]);
  if(o.status==='failure') {
    const owned=await provider.lookup(n.phone_number);
    if(owned&&owned.status!=='deleted')return review(n,'failed_order_still_has_number');
    return finish(n,'failed',true);
  }
  if(o.status!=='success') {
    if(Date.now()-new Date(n.dispatch_started_at)>86400000)await review(n,'activation_pending_over_24_hours');
    return;
  }
  const owned=await provider.lookup(n.phone_number);
  if(owned)await activate(n,owned);
}
async function release(n) {
  if(!n.provider_number_id)return review(n,'release_missing_provider_identity');
  // Hard guard: this module never releases the existing shared fax/calling numbers.
  const protectedNumbers=[process.env.TELNYX_FAX_PHONE_NUMBER,...String(process.env.PERSONAL_FAX_PROTECTED_NUMBERS||'').split(',')].map(s=>String(s||'').trim());
  if(protectedNumbers.includes(n.phone_number)||n.connection_id===String(process.env.TELNYX_FAX_CONNECTION_ID))return review(n,'protected_number_release_blocked');
  let owned;
  try {owned=(await provider.api('GET','/phone_numbers/'+encodeURIComponent(n.provider_number_id))).data;}
  catch(e){if(e.response?.status===404)return finish(n,'released');throw e;}
  if(owned?.status==='deleted')return finish(n,'released');
  if(owned?.phone_number!==n.phone_number||String(owned.connection_id)!==n.connection_id)return review(n,'release_identity_mismatch');
  try {
    const deleted=(await provider.api('DELETE','/phone_numbers/'+encodeURIComponent(n.provider_number_id))).data;
    if(deleted?.status==='deleted'&&deleted.phone_number===n.phone_number)return finish(n,'released');
    // 2xx without a final deleted representation needs a subsequent GET confirmation.
    await review(n,'release_confirmation_pending');
  } catch(e) {if(e.response?.status===404)return finish(n,'released');throw e;}
}
async function renew(n) {
  const {transaction}=context,now=new Date(),end=new Date(n.paid_until);
  if(n.cancel_requested_at)return;
  if(now.getTime()>=end.getTime()-7*86400000&&n.last_notice_period!==end.toISOString()) {
    await context.notify(n.user_id,null,'Fax Number Renewal',`${n.phone_number}: $1.00 rental will be charged on ${new Date(end-LEAD_MS).toISOString().slice(0,10)} UTC. Keep your wallet funded or release your number.`);
    await context.db.query('UPDATE netphone_personal_fax_numbers SET last_notice_period=$2 WHERE id=$1',[n.id,end.toISOString()]);
  }
  if(now<new Date(end-LEAD_MS))return;
  await transaction(async c=>{
    const row=await one(c,'SELECT * FROM netphone_personal_fax_numbers WHERE id=$1 FOR UPDATE',[n.id]);
    if(row.state!=='active'||row.cancel_requested_at||new Date(row.paid_until)>end)return;
    const user=await one(c,'SELECT status FROM users WHERE id=$1',[row.user_id]);
    if(!user||user.status!=='active') {
      await c.query("UPDATE netphone_personal_fax_numbers SET state='release_pending',cancel_requested_at=NOW() WHERE id=$1",[n.id]);return;
    }
    const wallet=await one(c,'SELECT * FROM wallets WHERE user_id=$1 FOR UPDATE',[row.user_id]);
    if(!wallet||wallet.currency!=='USD'||BigInt(wallet.balance_microusd)<MONTHLY||now>end) {
      await c.query("UPDATE netphone_personal_fax_numbers SET state='release_pending',cancel_requested_at=NOW(),review_reason='renewal_unfunded_or_overdue' WHERE id=$1",[n.id]);
      await audit(c,row,null,'auto_release_requested',{reason:'renewal_unfunded_or_overdue'});return;
    }
    const p={start:end.toISOString(),end:nextMonth(end).toISOString(),amount:MONTHLY.toString()};
    await chargePeriod(c,row,p);
    await c.query('UPDATE netphone_personal_fax_numbers SET paid_until=$2,updated_at=NOW() WHERE id=$1',[n.id,p.end]);
    await audit(c,row,null,'rental_paid',{period_start:p.start,amount_usd:'1.000000'});
  });
}
async function webhook(req,res) {
  if(!policy.signature(req.rawBody,req.headers,process.env.TELNYX_PUBLIC_KEY))return res.status(401).json({success:false});
  const event=req.body?.data,p=event?.payload||{},faxId=String(p.fax_id||'');
  if(event?.event_type!=='fax.received'||!UUID.test(faxId))return res.sendStatus(200);
  try {
    const media=typeof p.media_url==='string'&&p.media_url.length<=12000?p.media_url:null;
    await context.db.query('INSERT INTO netphone_personal_fax_events(fax_id,media_url) VALUES($1,$2) ON CONFLICT DO NOTHING',[faxId,media]);
    res.sendStatus(200);
  } catch(_){res.sendStatus(503);}
}
async function incomingOwner(c,fax) {
  const at=fax.created_at;if(!at||!Number.isFinite(new Date(at).getTime()))return null;
  // Match the immutable lease interval, not the current owner of a recycled number.
  const rows=(await c.query(`SELECT n.user_id,n.id FROM netphone_personal_fax_numbers n JOIN users u ON u.id=n.user_id
    WHERE n.phone_number=$1 AND n.connection_id=$2 AND n.dispatch_started_at<=$3 AND n.activated_at IS NOT NULL
      AND (n.released_at IS NULL OR n.released_at>$3) AND n.state<>'failed' AND u.status='active'`,[fax.to,String(fax.connection_id),at])).rows;
  return rows.length===1?rows[0]:null;
}
async function sender(userId,c=context.db) {
  if(!await hasSchema(context.db))return null;
  return one(c,`SELECT * FROM netphone_personal_fax_numbers WHERE user_id=$1 AND state='active'
    AND cancel_requested_at IS NULL AND paid_until>NOW()`,[userId]);
}
async function ownsUsage(c,connection,destination) {
  if(!await hasSchema(context.db))return false;
  return !!await one(c,'SELECT id FROM netphone_personal_fax_numbers WHERE connection_id=$1 AND phone_number=$2 LIMIT 1',[connection,'+'+String(destination).replace(/^\+/, '')]);
}
async function processEvents() {
  const {db,importPersonal}=context;
  const events=(await db.query('SELECT * FROM netphone_personal_fax_events WHERE completed_at IS NULL AND next_attempt_at<=NOW() ORDER BY next_attempt_at LIMIT 5')).rows;
  for(const e of events) {
    try {
      await importPersonal(e.fax_id,e.media_url);
      await db.query('UPDATE netphone_personal_fax_events SET completed_at=NOW(),review_reason=NULL,media_url=NULL WHERE fax_id=$1',[e.fax_id]);
    } catch(_) {
      await db.query("UPDATE netphone_personal_fax_events SET attempts=attempts+1,next_attempt_at=NOW()+INTERVAL '2 minutes',review_reason='incoming_import_pending' WHERE fax_id=$1",[e.fax_id]);
      console.error('Personal fax incoming retry:',e.fax_id);
    }
  }
}
async function cycle() {
  if(working)return;working=true;let lock;
  try {
    if(!await hasSchema(context.db))return;
    lock=await context.db.getClient();
    if(!(await one(lock,'SELECT pg_try_advisory_lock(733174903011::bigint) AS locked')).locked)return;
    const rows=(await context.db.query(`SELECT * FROM netphone_personal_fax_numbers WHERE state=ANY($1::text[])
      AND (state<>'active' OR paid_until<=NOW()+INTERVAL '2 days' OR
        (paid_until<=NOW()+INTERVAL '7 days' AND last_notice_period IS DISTINCT FROM to_char(paid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
      AND (last_checked_at IS NULL OR last_checked_at<NOW()-INTERVAL '60 seconds')
      ORDER BY CASE WHEN state='release_pending' THEN 0 ELSE 1 END,last_checked_at NULLS FIRST LIMIT 10`,[openStates])).rows;
    for(const n of rows) {
      await context.db.query('UPDATE netphone_personal_fax_numbers SET last_checked_at=NOW() WHERE id=$1',[n.id]);
      try {
        if(['reserved','ordering'].includes(n.state))await order(n);
        else if(n.state==='release_pending')await release(n);
        else if(n.state==='active') {
          await renew(n);
          const current=await one(context.db,'SELECT * FROM netphone_personal_fax_numbers WHERE id=$1',[n.id]);
          if(current.state==='release_pending')await release(current);
        }
      } catch(_){await review(n,'provider_or_database_retry_required');}
    }
    await processEvents();
  } finally {
    if(lock){try{await lock.query('SELECT pg_advisory_unlock(733174903011::bigint)');}finally{lock.release();}}
    working=false;
  }
}
const rateLimits=new Map();
function rateLimit(req,res,next) {
  const key=String(req.user.id),now=Date.now();let entry=rateLimits.get(key);
  if(!entry||entry.expires<now){entry={count:0,expires:now+60000};rateLimits.set(key,entry);}
  if(rateLimits.size>2000)rateLimits.delete(rateLimits.keys().next().value);
  if(++entry.count>10)return res.status(429).json({success:false,message:'Please wait a minute and try again.'});
  next();
}
function install(router,auth,admin,endpoint,dependencies) {
  context=dependencies;
  router.post('/personal-numbers/webhook',webhook);
  router.get('/personal-numbers',auth,endpoint(status));
  router.get('/personal-numbers/history',auth,endpoint(history));
  router.get('/personal-numbers/available',auth,rateLimit,endpoint(search));
  router.post('/personal-numbers/buy',auth,rateLimit,endpoint(buy));
  router.post('/personal-numbers/:numberId/release',auth,rateLimit,endpoint(cancel));
  router.get('/admin/personal-numbers/review',...admin,endpoint(async()=>({numbers:(await dependencies.db.query(`SELECT id,user_id,phone_number,state,review_reason,paid_until FROM netphone_personal_fax_numbers
    WHERE review_reason IS NOT NULL OR state='release_pending' ORDER BY updated_at DESC LIMIT 100`)).rows})));
  if(!timer){timer=setInterval(()=>void cycle().catch(()=>console.error('Personal fax worker needs review')),15000);timer.unref();}
}
module.exports={install,incomingOwner,sender,ownsUsage,publicNumber,_test:{money,readQuote,signQuote,chargePeriod,buy,cancel,history,refund,finish,order,release,renew,cycle,webhook,setContext:c=>{context=c;schemaUntil=0;},status,search}};
