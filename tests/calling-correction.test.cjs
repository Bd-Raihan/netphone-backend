'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(process.env.NETPHONE_BACKEND_ROOT || path.resolve(__dirname, '..'), 'src');
const money = require(path.join(root, 'modules/calling-guard/money-routes'));
const duration = require(path.join(root, 'modules/calls/provider-duration'));
function load(relative, mocks, append = '', env = {}) {
 const filename=path.join(root,relative), mod={exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8') + append,{
  module:mod,exports:mod.exports,Buffer,Date,process:{env:{TELNYX_PHONE_NUMBER:'+16452199033', ...env}},console:{log(){},warn(){},error(){}},
  require:name=>Object.hasOwn(mocks,name)?mocks[name]:require(require.resolve(name,{paths:[path.dirname(filename)]})),
 },{filename});
 return mod.exports;
}
function fixture({rate='0.2501',sell='0.35294',first=60,next=60,seconds=61,mode='auto_markup',legacy=false,fail=false}={}) {
 const start='2026-11-12T10:00:00Z';
 const session={id:1,user_id:7,provider:'telnyx',provider_call_id:'provider-1',status:'ended',tx_id:null,
  answered_at:new Date(start),ended_at:new Date(Date.parse(start)+seconds*1000),to_phone_e164:'+393196616068',
  meta:{pricing_snapshot:{raw_provider_rate_usd_per_min:Number(rate),sell_rate_usd_per_min:Number(sell),
   total_provider_cost_usd_per_min:Number(rate)+.002,provider_connection_fee_usd:0,customer_connection_fee_usd:0,
   minimum_duration_seconds:first,billing_increment_seconds:next,markup_percent:40},
   ...(!legacy?{calling_rate_guard:{version:'deck',sdk_microusd:'2000',pricing_mode:mode}}:{})}};
 let debits=0,posted=null;
 const query=async(sql,args=[])=>{
  if(sql.includes('SELECT *')&&sql.includes('FROM call_sessions'))return {rows:[session]};
  if(sql.includes("status = 'charged'")){session.status='charged';session.tx_id=args[4];session.charged_amount_cents=args[3];}
  return {rows:[]};
 };
 const wallet={applyWalletTx:async args=>{debits++;if(fail)throw Error('temporary database outage');posted=args;return {ok:true,tx:{id:99},wallet:{balance_usd:4}};}};
 const db={pool:{connect:async()=>({query,release(){}})},query};
 const service=load('modules/calls/calls.service.js',{'../../config/db':db,'../wallet/wallet.service':wallet,
  './provider-router.service':{},'../calling-guard/guard.service':{},'../calling-guard/money-routes':money,'./provider-duration':duration});
 return {service,session,get posted(){return posted},get debits(){return debits}};
}
test('real CSV prefix and origin selection; all paid supplied SIP CDRs reconcile to cost/time',async(t)=>{
 const upload=process.env.NETPHONE_TEST_DATA_DIR || path.resolve(__dirname,'../upload');if(!fs.existsSync(upload)){t.skip('Supply NETPHONE_TEST_DATA_DIR for original CSV audit');return;}
 const routes=[];const deck=fs.readdirSync(upload).find(x=>x.startsWith('global_'));
 const count=await money.readDeck(path.join(upload,deck),async batch=>routes.push(...batch));
 assert.equal(count,264076);
 const byFixed=new Map();for(const r of routes){if(!byFixed.has(r.fixed))byFixed.set(r.fixed,[]);byFixed.get(r.fixed).push(r);}
 const choose=(n,from)=>{const d=money.digits(n);let candidates=[];for(let i=1;i<=d.length;i++)candidates.push(...(byFixed.get(d.slice(0,i))||[]));return money.select(candidates,n,from);};
 for(const [number,prefix,rate] of [['+393196616068','39319','250100'],['+390635091','39','10100'],['+8801782002072','88017','20100']]){
  const r=choose(number,'+16452199033');assert.equal(r.prefix,prefix);assert.equal(r.rate,rate);
 }
 let paid=0,changed=0;
 for(const name of fs.readdirSync(upload).filter(x=>x.startsWith('cdr_')&&x.endsWith('.csv'))){
  const lines=fs.readFileSync(path.join(upload,name),'utf8').trim().split(/\r?\n/),header=money.csvLine(lines.shift());
  for(const line of lines){const values=money.csvLine(line),r=Object.fromEntries(header.map((k,i)=>[k,values[i]]));
   if(money.micro(r.Cost||'0')===0n)continue;paid++;
   const selected=choose(r['Full Terminating number'],r['Originating Number']);
   if(selected.rate!==money.micro(r.Rate).toString())changed++;
   assert.equal(money.fee({...selected,rate:money.micro(r.Rate).toString()},Number(r['Call duration'])),money.micro(r.Cost));
  }
 }
 assert.ok(paid>80); t.diagnostic(`Audited ${paid} paid CDR rows; ${changed} rows use historical rates different from the current deck.`);
});
test('PostgreSQL Date timestamps work; billable seconds never masquerade as talk duration',()=>{
 assert.equal(duration.connectedSeconds({answeredAt:new Date('2026-11-12T10:00:00Z'),endedAt:new Date('2026-11-12T10:00:12Z'),rawPayload:{billable_seconds:60}}),12);
 assert.equal(duration.connectedSeconds({rawPayload:{duration_seconds:0},answeredAt:'2026-11-12T10:00:00Z',endedAt:'2026-11-12T10:02:00Z'}),0);
 assert.equal(duration.connectedSeconds({rawPayload:{},answeredAt:null,endedAt:new Date()}),0);
});
test('provider event time, not webhook delivery time, determines duration',()=>{
 const times=duration.eventTimes('call.hangup',{occurred_at:'2026-11-12T10:00:12Z'},{end_time:'2026-11-12T10:00:11Z'});
 assert.equal(times.endedAt,'2026-11-12T10:00:11.000Z');
});
for(const [seconds,billed,charge] of [[1,60,352940],[60,60,352940],[61,120,705880],[904,960,5647040]]){
 test(`Italy mobile ${seconds}s bills ${billed}s with 40% markup`,async()=>{
  const f=fixture({seconds});const r=await f.service.billCompletedCallByProvider({sessionId:1,callSid:'provider-1',rawPayload:{}});
  assert.equal(r.charged_amount_microusd,charge);assert.equal(r.billable_seconds,billed);
  assert.equal(f.posted.txType,'call_charge');assert.equal(f.posted.idempotencyKey,'call_charge:1');
  assert.ok(r.charged_amount_usd>r.provider_cost_usd);
 });
}
test('Italy fixed line and Bangladesh use their own prefixes, no country-wide mobile rate',async()=>{
 for(const [rate,sell,amount] of [['0.0101','0.01694',16940],['0.0201','0.03094',30940]]){
  const f=fixture({rate,sell,seconds:12});const r=await f.service.billCompletedCallByProvider({sessionId:1,rawPayload:{}});
  assert.equal(r.charged_amount_microusd,amount);
 }
});
test('SIP 60/1 and SDK 60/60 are billed independently',async()=>{
 const f=fixture({rate:'0.0101',sell:'0.01694',next:1,seconds:61});
 const r=await f.service.billCompletedCallByProvider({sessionId:1,rawPayload:{}});
 assert.equal(r.charged_amount_microusd,19977);
 assert.equal(r.provider_cost_usd,.014269);assert.equal(r.billable_seconds,120);
});
test('manual rate stays as quoted; no hidden markup applied',async()=>{
 const f=fixture({mode:'manual_rate',sell:'0.4',seconds:61});
 const r=await f.service.billCompletedCallByProvider({sessionId:1,rawPayload:{}});assert.equal(r.charged_amount_microusd,800000);
});
test('duplicate webhook does not debit twice',async()=>{
 const f=fixture();await f.service.billCompletedCallByProvider({sessionId:1,rawPayload:{}});
 const r=await f.service.billCompletedCallByProvider({sessionId:1,rawPayload:{}});
 assert.equal(r.reason,'already_charged');assert.equal(f.debits,1);
});
test('wallet exception stays retryable; not reported as a successful charge',async()=>{
 const f=fixture({fail:true});await assert.rejects(f.service.billCompletedCallByProvider({sessionId:1,rawPayload:{}}),/database outage/);
 assert.notEqual(f.session.status,'charged');assert.equal(f.session.tx_id,null);
});
test('legacy snapshot first interval 90 then 60 rounds 91s to 150s',async()=>{
 const f=fixture({legacy:true,first:90,next:60,seconds:91});const r=await f.service.billCompletedCallByProvider({sessionId:1,rawPayload:{}});
 assert.equal(r.billable_seconds,150);
});
test('missing answer and zero talk duration create no debit',async()=>{
 for(const missing of [true,false]){const f=fixture({seconds:0});if(missing)f.session.answered_at=null;
  const r=await f.service.billCompletedCallByProvider({sessionId:1,rawPayload:{duration_seconds:0}});
  assert.equal(r.charged_amount_cents,0);assert.equal(f.debits,0);
 }
});
test('call router uses Rate Management resolver and never falls back after denial',async()=>{
 let hits=0;const router=load('modules/calls/provider-router.service.js',{'./provider-router.repository':{},'../calling-guard/guard.service':{tryResolve:async n=>{hits++;return {ok:false,reason:'country_loss_blocked',number:n}}}});
 const r=await router.resolveDestination('+393196616068');assert.equal(hits,1);assert.equal(r.reason,'country_loss_blocked');
});
test('reporting reset contains no financial DELETE/TRUNCATE or UPDATE',()=>{
 const s=fs.readFileSync(path.join(root,'modules/calling-guard/reporting-period.js'),'utf8');
 assert.doesNotMatch(s,/\b(DELETE|TRUNCATE)\b/i);
 assert.doesNotMatch(s,/UPDATE\s+(users|wallets|wallet_transactions|call_sessions)\b/i);
 assert.match(s,/UPDATE voice_guard_settings SET reporting_started_at/);
});
test('new session stores the exact guard quote and passes through admission',async()=>{
 const guardSnapshot={version:'deck-v2',prefix:'39319',pricing_mode:'auto_markup',markup_percent:40,sdk_microusd:'2000'};
 const quote={ok:true,source:'telnyx_origin_csv_guard',provider:{code:'telnyx',id:2},provider_plan:{id:1},
  route:{id:3},route_provider:{route_provider_id:4},provider_rate:{country_code:'IT',country_name:'Italy',prefix:'39319'},
  pricing:{raw_provider_rate_usd_per_min:.2501,total_provider_cost_usd_per_min:.2521,platform_fee_usd_per_min:.002,
   sell_rate_usd_per_min:.35294,markup_percent:40,billing_increment_seconds:60,minimum_duration_seconds:60},guard_snapshot:guardSnapshot};
 let admitted=false,saved;
 const db={query:async(sql,args)=>{if(sql.includes('INSERT INTO call_sessions')){
  saved={id:8,user_id:7,meta:JSON.parse(args.at(-1))};return {rows:[saved]};}return {rows:[]};}};
 const wallet={ensureWallet:async()=>{},getWalletByUserId:async()=>({balance_cents:500,balance_microusd:5000000})};
 const service=load('modules/calls/calls.service.js',{'../../config/db':db,'../wallet/wallet.service':wallet,
  './provider-router.service':{resolveDestination:async()=>quote},'../calling-guard/guard.service':{admit:async(session,rate)=>{
   admitted=true;assert.equal(session.meta.calling_rate_guard.version,'deck-v2');assert.equal(rate.sell_rate_usd_per_min,.35294);return session;}},
  '../calling-guard/money-routes':money,'./provider-duration':duration});
 const result=await service.startCallSession({userId:7,toPhoneE164:'+393196616068'});
 assert.equal(result.ok,true);assert.equal(admitted,true);assert.equal(saved.meta.pricing_snapshot.country_name,'Italy');
});
function controllerFixture({eventType='call.hangup',throwBilling=false,ended=true}={}){
 let billing=0,lastParams;
 const db={query:async(sql,params)=>{lastParams=params;return {rows:[{id:8,user_id:7,provider_call_id:'provider-1',ended_at:ended?'2026-11-12T10:00:12Z':null}]};}};
 const controller=load('modules/calls/calls.controller.js',{'../../config/db':db,
  './calls.service':{billCompletedCallByProvider:async()=>{billing++;if(throwBilling)throw Error('temporary outage');return {ok:true};}},
  './telnyx.service':{},'./telnyx-webrtc.service':{},'../wallet/wallet.service':{},'./provider-duration':duration});
 const req={query:{},body:{data:{event_type:eventType,occurred_at:'2026-11-12T10:00:12Z',payload:{call_control_id:'provider-1',client_state:Buffer.from('{"session_id":8}').toString('base64')}}}};
 const res={statusCode:0,status(c){this.statusCode=c;return this},json(body){this.body=body;return this}};
 return {controller,req,res,get billing(){return billing},get params(){return lastParams}};
}
test('transient billing error returns 503 so provider can retry',async()=>{
 const f=controllerFixture({throwBilling:true});await f.controller.telnyxStatusCallback(f.req,f.res);
 assert.equal(f.res.statusCode,503);assert.equal(f.res.body.ok,false);assert.equal(f.billing,1);
});
test('late answered event can finish billing after an earlier hangup',async()=>{
 const f=controllerFixture({eventType:'call.answered'});await f.controller.telnyxStatusCallback(f.req,f.res);
 assert.equal(f.billing,1);assert.equal(f.params[9],'2026-11-12T10:00:12.000Z');
});

function guardFixture(alerts) {
 const settings={enabled:true,deck_version:'deck',caller_number:'+16452199033',imported_at:new Date(),
  max_deck_age_days:30,monitor_verified:true,last_monitor_sync:new Date(),sdk_microusd:2000,default_markup:40};
 const query=async(sql)=>{
  if(sql.includes('voice_guard_settings'))return {rows:[settings]};
  if(sql.includes('voice_guard_deck'))return {rows:[{route:{iso:'IT',country:'Italy',prefix:'39',fixed:'39',origin:'',rate:'10100',fee:'0',first:60,next:60,exact:false}}]};
  if(sql.includes('voice_guard_alerts'))return {rows:alerts};
  if(sql.includes('SELECT balance_microusd'))return {rows:[{balance_microusd:5000000}]};
  if(sql.includes('UPDATE call_sessions'))return {rows:[{id:42}]};
  return {rows:[]};
 };
 const db={query,getClient:async()=>({query,release(){}})};
 const guard=load('modules/calling-guard/guard.service.js',{'../../config/db':db,'./money-routes':money,
  '../calls/provider-router.repository':{findDestinationPolicy:async()=>null,findActiveRoute:async()=>({id:1}),
   findRouteProviderCandidates:async()=>[{provider_code:'telnyx',provider_plan_code:'payg',provider_id:2}]}});
 return {guard,settings};
}
test('historical missing-cost warning no longer masquerades as a rate failure',async()=>{
 const {guard,settings}=guardFixture([{alert_key:'missing:1517',severity:'warning',details:{rate_update_required:true}}]);
 const r=await guard.resolve('+390635091',settings);assert.equal(r.ok,true);
 const admitted=await guard.admit({id:42,user_id:7,to_phone_e164:'+390635091',meta:{calling_rate_guard:{version:'deck',country_code:'IT'}}},
 {sell_rate_usd_per_min:.01694,customer_connection_fee_usd:0,minimum_duration_seconds:60,billing_increment_seconds:60});
 assert.equal(admitted.id,42);
});
test('confirmed losses and current provider-rate changes remain blocked',async()=>{
 for(const alert of [
  {alert_key:'actual:1',severity:'loss',details:{}},
  {alert_key:'missing:1',severity:'loss',details:{}},
  {alert_key:'rate-change:1',severity:'warning',details:{rate_update_required:true}},
  {alert_key:'readiness',severity:'warning',details:{rate_update_required:true}},
 ]){
  const {guard,settings}=guardFixture([alert]);
  assert.equal((await guard.resolve('+390635091',settings)).reason,'country_loss_blocked');
  await assert.rejects(guard.admit({id:42,user_id:7,to_phone_e164:'+390635091',meta:{calling_rate_guard:{version:'deck',country_code:'IT'}}},{}),/rate review/);
 }
});
test('monitor readiness failure still blocks calling even with a safe CSV quote',async()=>{
 const {guard,settings}=guardFixture([]);settings.monitor_verified=false;
 assert.equal((await guard.resolve('+390635091',settings)).reason,'calling_guard_not_ready');
});
test('existing credential must belong to the currently configured SIP connection',()=>{
 const service=load('modules/calls/telnyx-webrtc.service.js',{'../../config/db':{},'./telnyx.service':{}},
 '\nmodule.exports.checkReuse = isCredentialReusable;', {TELNYX_SIP_CONNECTION_ID:'3901768954213893213'});
 const row={status:'active',provider_credential_id:'credential',connection_id:'3004827948676023813',credential_expires_at:'2030-01-01'};
 assert.equal(service.checkReuse(row),false);
 row.connection_id='3901768954213893213';assert.equal(service.checkReuse(row),true);
});
test('report monitor accepts only explicit additional numeric voice connection IDs',()=>{
 const mocks={'../../config/db':{},'./guard.service':{},'./money-routes':money};
 const valid=load('modules/calling-guard/cost-monitor.js',mocks,'',{
  TELNYX_SIP_CONNECTION_ID:'3901768954213893213',TELNYX_CALLING_REPORT_CONNECTION_IDS:'3004827948676023813'});
 assert.deepEqual([...valid.reportingConnections()].sort(),['3004827948676023813','3901768954213893213']);
 const invalid=load('modules/calling-guard/cost-monitor.js',mocks,'',{TELNYX_CALLING_REPORT_CONNECTION_IDS:'*'});
 assert.throws(()=>invalid.reportingConnections(),/explicit numeric/);
});
