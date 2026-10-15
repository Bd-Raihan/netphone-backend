"use strict";
const crypto=require('crypto');
const db=require('../database/db');
const math=require('./faxBillingMath');
const {microToUsd}=require('./faxMoney');
const fail=m=>Object.assign(new Error(m),{status:422});
function floor(policy,pages,base){
 const manual=BigInt(policy?.minimum_page_microusd||0)*BigInt(pages);
 return manual>BigInt(base)?manual:BigInt(base);
}
async function policy(phone,direction,client=db){
 const p=math.phone(phone);
 const prefixes=Array.from({length:p.length},(_,i)=>p.slice(0,i+1));
 const row=(await client.query(`SELECT * FROM netphone_fax_price_controls WHERE direction=$1
 AND phone_prefix=ANY($2::text[]) ORDER BY length(phone_prefix) DESC LIMIT 1`,[direction,prefixes])).rows[0];
 return row&&row.active!==false?{id:row.id,revision:new Date(row.updated_at).toISOString(),minimum_page_microusd:String(row.minimum_page_microusd)}:null;
}
async function save(req,transaction,audit){
 const b=req.body;const prefix=String(b.phone_prefix||'').replace(/^\+/,'');
 if(!/^[1-9]\d{0,14}$/.test(prefix)||!['inbound','outbound'].includes(b.direction)||
 !/^[A-Z]{2}$/.test(b.country_code||'')||typeof b.active!=='boolean')throw fail('Enter ISO (US), numeric prefix (1), direction and active status');
 const name=String(b.country_name||'').trim();if(!name||name.length>100)throw fail('Country name required (max 100 characters)');
 let amount;try{amount=math.money(String(b.minimum_page_usd));}catch(_){throw fail('Enter a valid USD per-page minimum, up to six decimal places');}
 if(amount>100000000n)throw fail('Per-page minimum must be between $0 and $100');
 await transaction(async c=>{
 const saved=await c.query(`INSERT INTO netphone_fax_price_controls(id,country_code,country_name,phone_prefix,direction,minimum_page_microusd,active)
 VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(direction,phone_prefix) DO UPDATE SET
 country_code=EXCLUDED.country_code,country_name=EXCLUDED.country_name,minimum_page_microusd=EXCLUDED.minimum_page_microusd,
 active=EXCLUDED.active,updated_at=GREATEST(clock_timestamp(),netphone_fax_price_controls.updated_at+interval '1 millisecond') RETURNING id`,
 [crypto.randomUUID(),b.country_code,name,prefix,b.direction,amount.toString(),b.active]);
 await audit(c,req.user.id,'fax_manual_minimum_saved',null,{id:saved.rows[0].id,prefix,direction:b.direction,minimum_page_microusd:amount.toString(),active:b.active});
 });return {saved:true};
}
function usageInfo(row,kind){
 const integer=(...keys)=>{const v=math.get(row,...keys);return /^\d+$/.test(v)&&Number.isSafeInteger(Number(v))?Number(v):null;};
 return {billed_seconds:kind==='sip'?integer('billed_sec','Billed seconds','billed_seconds'):null,
 delivered_pages:kind==='fax'?integer('fax_transferred_pages','pages delivered','transferred_pages','pages_delivered'):null};
}
async function detail(fax,client=db){
 let api=(await client.query("SELECT * FROM netphone_fax_usage WHERE kind='fax' AND fax_provider_id=$1",[fax.telnyx_fax_id])).rows;
 if(api.some(x=>x.source==='api'))api=api.filter(x=>x.source==='api');
 if(api.length!==1)return {billed_seconds:null,delivered_pages:null};
 let legs=(await client.query("SELECT * FROM netphone_fax_usage WHERE kind='sip' AND session_id=$1",[api[0].session_id])).rows;
 if(legs.some(x=>x.source==='api'))legs=legs.filter(x=>x.source==='api');
 return {billed_seconds:legs.length&&legs.every(x=>x.usage_details?.billed_seconds!=null)?legs.reduce((n,x)=>n+x.usage_details.billed_seconds,0):null,
 delivered_pages:api[0].usage_details?.delivered_pages??null,
 api_cost_usd:microToUsd(api[0].cost_microusd),sip_cost_usd:microToUsd(legs.reduce((n,x)=>n+BigInt(x.cost_microusd),0n))};
}
function publicBill(b){
 const pending=b.rate_snapshot?.dynamic===true&&!b.actual_settled&&!['free','refunded'].includes(b.state);
 const amount=BigInt(b.amount_microusd||0);const pages=Number(b.billing_details?.delivered_pages??b.pages);const reserve=b.reserved_microusd==null?null:BigInt(b.reserved_microusd);
 return {state:b.state,pending,updated_at:b.updated_at||null,amount_usd:microToUsd(amount),charged_usd:microToUsd(['paid','prepaid'].includes(b.state)?amount:0),
 reserved_usd:reserve==null?null:microToUsd(reserve),refund_usd:reserve!=null&&b.actual_settled?microToUsd(reserve>amount?reserve-amount:0):null,
 billed_seconds:b.billing_details?.billed_seconds??null,
 average_page_usd:b.actual_settled&&pages>0?microToUsd((amount+BigInt(pages)-1n)/BigInt(pages)):null};
}
async function attach(faxes,userId){
 if(!faxes.length)return;
 const bills=(await db.query('SELECT * FROM netphone_fax_billing WHERE user_id=$1 AND fax_id=ANY($2::bigint[])',[userId,faxes.map(f=>f.id)])).rows;
 const map=new Map(bills.map(b=>[String(b.fax_id),publicBill(b)]));
 for(const f of faxes)f.billing=map.get(String(f.id))||null;
}
async function list(){
 const rows=(await db.query('SELECT * FROM netphone_fax_price_controls ORDER BY country_name,direction,phone_prefix')).rows;
 return {rules:rows.map(x=>({...x,minimum_page_usd:microToUsd(x.minimum_page_microusd)}))};
}
async function search(req){
 const q=String(req.query.search||'').trim();if(q.length>100)throw fail('Search too long');
 const offset=Number(req.query.offset||0);if(!Number.isSafeInteger(offset)||offset<0||offset>300000)throw fail('Invalid offset');
 const version=(await db.query('SELECT deck_version,fax_api_microusd FROM netphone_fax_settings WHERE id=1')).rows[0];
 const rows=(await db.query(`SELECT route FROM netphone_fax_deck WHERE version=$1 AND
 ($2='' OR route->>'country' ILIKE $3 OR $4=ANY(string_to_array(route->>'iso','/')) OR prefix LIKE $5)
 ORDER BY ordinal LIMIT 51 OFFSET $6`,[version.deck_version,q,'%'+q.replace(/[\\%_]/g,'\\$&')+'%',q.toUpperCase(),q.replace(/^\+/,'')+'%',offset])).rows;
 return {api_page_usd:microToUsd(version.fax_api_microusd),more:rows.length>50,routes:rows.slice(0,50).map(({route:x})=>({...x,
 sip_minute_usd:microToUsd(x.rate),sell_sip_minute_usd:microToUsd(math.markup(x.rate)),per_call_usd:microToUsd(x.per_call)}))};
}
// The deployment timestamp excludes historical faxes; no per-user opt-in or cap.
async function receiveBilling(){
 return {enabled:true,agreement_required:false,limit_usd:null};
}
async function saveReceiveBilling(req){
 if(req.body.enabled!==true)throw Object.assign(new Error('Receive charging is automatic and cannot be disabled'),{status:409});
 return {saved:true,enabled:true};
}
async function autoPay(b,charge,client,ledger){
 const setting=(await client.query('SELECT receive_auto_from FROM netphone_fax_settings WHERE id=1')).rows[0];
 const start=new Date(setting?.receive_auto_from||'').getTime();
 const received=new Date(b.fax_created_at||'').getTime();
 if(!Number.isFinite(start)||!Number.isFinite(received)||received<start)return null;
 try {return await ledger(client,b.user_id,charge,'fax_charge',`netphone-fax:${b.fax_id}:receive`,
  {fax_id:b.fax_id,direction:'inbound',stage:'automatic_receive',pages:b.pages});}
 catch(e){if(e.status===402)return null;throw e;}
}
function install(router,admin,endpoint,transaction,audit,auth){
 router.get('/receive-billing',auth,endpoint(receiveBilling));
 router.patch('/receive-billing',auth,endpoint(req=>saveReceiveBilling(req,transaction,audit)));
 router.get('/admin/price-controls',...admin,endpoint(list));
 router.post('/admin/price-controls',...admin,endpoint(req=>save(req,transaction,audit)));
 router.get('/admin/rate-browser',...admin,endpoint(search));
}
module.exports={floor,policy,usageInfo,detail,publicBill,attach,install,save,autoPay,receiveBilling,saveReceiveBilling};
