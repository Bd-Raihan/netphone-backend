'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const money = require('../src/modules/calling-guard/money-routes');
const client = require('../src/modules/calling-guard/report-client');
function response(status, body = {data:[],meta:{total_pages:1}}, retry=null) {
 return {ok:status===200,status,headers:{get:()=>retry},body:{cancel:async()=>{}},text:async()=>JSON.stringify(body)};
}
test('short Retry-After is respected; 429 can recover', async()=>{
 let calls=0;const waits=[];
 const result=await client.page('https://api.telnyx.com/v2/detail_records','test',undefined,{
 fetch:async()=>++calls===1?response(429,{},'2'):response(200),sleep:async ms=>waits.push(ms)});
 assert.equal(calls,2);assert.deepEqual(result.data,[]);assert.ok(waits.some(x=>x>=1900));
});
test('long Retry-After defers without hammering or waiting past request lifetime',async()=>{
 let calls=0;
 await assert.rejects(client.page('url','test',undefined,{fetch:async()=>{calls++;return response(429,{},'90')},sleep:async()=>{}}),e=>e.retryAt>Date.now()+89000);
 assert.equal(calls,1);
});
test('authorization failures are not retried',async()=>{
 let calls=0;await assert.rejects(client.page('url','test',undefined,{fetch:async()=>{calls++;return response(401)},sleep:async()=>{}}),/HTTP 401/);assert.equal(calls,1);
});
test('malformed reports fail closed',async()=>{
 await assert.rejects(client.page('url','test',undefined,{fetch:async()=>response(200,{data:{}}),sleep:async()=>{}}),/schema/);
});
test('Retry-After supports HTTP date',()=>{
 const now=Date.parse('2026-11-14T00:00:00Z');assert.equal(client.retryTime('Sat, 14 Nov 2026 00:01:00 GMT',now),now+60000);
});
function fixture({settings={},locked=true,pages=[]}={}) {
 const sql=[], alerts=[];let requests=0,released=0;
 const config={monitor_verified:true,last_monitor_sync:null,...settings};
 const query=async(q,args=[])=>{sql.push({q,args});
  if(q.includes('pg_try_advisory_lock'))return {rows:[{locked}]};
  if(q.includes('SELECT * FROM voice_guard_usage'))return {rows:[]};
  return {rows:[]};
 };
 const connection={query,release(){released++}};
 const db={getClient:async()=>connection,query};
 const guard={settings:async()=>config,transaction:async fn=>fn(connection),alert:async(...v)=>alerts.push(v),health:async()=>{},audit:async()=>{}};
 const mod={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'src/modules/calling-guard/cost-monitor.js'),'utf8'),{
 module:mod,exports:mod.exports,require:n=>({'../../config/db':db,'./guard.service':guard,'./money-routes':money,'./report-client':{page:async()=>{requests++;const r=pages.shift();if(r instanceof Error)throw r;return r||{data:[],meta:{total_pages:1}}}}}[n]),
 process:{env:{TELNYX_API_KEY:'test',TELNYX_SIP_CONNECTION_ID:'3004827948676023813'}},Date,URL,AbortSignal,console,setInterval,clearInterval,setTimeout,
 });
 return {monitor:mod.exports,sql,alerts,get requests(){return requests},get released(){return released}};
}
test('another PM2 worker owns sync: no provider request',async()=>{
 const f=fixture({locked:false});assert.equal((await f.monitor.sync()).in_progress,true);assert.equal(f.requests,0);assert.equal(f.released,1);
});
test('shared rate-limit cooldown suppresses manual and scheduled calls',async()=>{
 const f=fixture({settings:{monitor_retry_after:new Date(Date.now()+90000)}});assert.equal((await f.monitor.sync()).deferred,true);assert.equal(f.requests,0);
});
test('recent successful refresh is cached across workers',async()=>{
 const f=fixture({settings:{last_monitor_sync:new Date()}});assert.equal((await f.monitor.sync()).cached,true);assert.equal(f.requests,0);
});
test('empty valid scan preserves prior activation and releases lock',async()=>{
 const f=fixture();const result=await f.monitor.sync();assert.equal(result.verified,true);assert.equal(f.requests,2);assert.equal(f.released,1);
 assert.ok(!f.sql.some(x=>x.q.includes('monitor_verified=FALSE')));
});
test('first activation still requires matching SIP and WebRTC evidence',async()=>{
 const f=fixture({settings:{monitor_verified:false}});assert.equal((await f.monitor.sync()).verified,false);
});
test('earlier page is committed even if a later page hits 429',async()=>{
 const row={id:'11111111-1111-4111-8111-111111111111',telnyx_session_id:'22222222-2222-4222-8222-222222222222',connection_id:'3004827948676023813',cld:'+393196616068',cli:'+16452199033',cost:'0.2501',rate:'0.2501',billed_sec:60,direction:'outbound'};
 const error=Object.assign(Error('HTTP 429'),{retryAt:Date.now()+90000});
 const f=fixture({pages:[{data:[row],meta:{total_pages:2}},error]});
 await assert.rejects(f.monitor.sync(),/429/);assert.ok(f.sql.some(x=>x.q.includes('INSERT INTO voice_guard_usage')));
 assert.ok(f.sql.some(x=>x.q.includes('monitor_retry_after=$2')));assert.equal(f.released,1);
});
test('30% prefix billing: Italy fixed/mobile and BD use own rate',()=>{
 for(const [rate,expected] of [['0.0101',15730n],['0.2501',327730n],['0.0201',28730n]]) {
  const r=money.billUsage({rate:money.micro(rate),first:60,next:60},{pricing_mode:'auto_markup',markup_percent:30},2000,24);
  assert.equal(r.sellUsage,expected);assert.equal(r.customerSeconds,60);
 }
});
function auditFixture({wallet='15000', web=true}={}) {
 const sql=[],alerts=[];
 const call={id:44,user_id:1,to_phone_e164:'+393196616068',guard_country:'IT',meta:{telnyx_call_session_id:'22222222-2222-4222-8222-222222222222',telnyx_call_leg_id:'leg',provider_phone_number:'+16452199033',calling_rate_guard:{prefix:'39319'}}};
 const usage=[{kind:'sip-trunking',direction:'outbound',cost_microusd:'250100',rate_microusd:'250100',billed_seconds:60},...(web?[{kind:'webrtc',direction:'outbound',cost_microusd:'2000',rate_microusd:'2000',billed_seconds:60}]:[])];
 const config={deck_version:'deck',sdk_microusd:'2000',default_markup:30};
 const route={rate:'250100',fee:'0',first:60,next:60};
 const query=async(q,args=[])=>{sql.push({q,args});
  if(q.includes('SELECT s.*'))return {rows:[call]};
  if(q.includes('SELECT * FROM voice_guard_usage'))return {rows:usage};
  if(q.includes('AS net'))return {rows:[{net:wallet}]};
  return {rows:[]};
 };
 const connection={query};
 const guard={transaction:async fn=>fn(connection),settings:async()=>config,
 alert:async(...a)=>alerts.push(a),selectRoute:async()=>route,policy:async()=>({pricing_mode:'auto_markup',markup_percent:30}),prices:()=>({sell:327730n})};
 const mod={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'src/modules/calling-guard/cost-monitor.js'),'utf8'),{module:mod,exports:mod.exports,require:n=>({'../../config/db':{query},'./guard.service':guard,'./money-routes':money,'./report-client':client}[n]),process:{env:{}},Date,console});
 return {monitor:mod.exports,sql,alerts};
}
test('confirmed loss includes actual cost and actionable prefix rate advice, no wallet mutation',async()=>{
 const f=auditFixture();await f.monitor.reconcile();
 assert.ok(f.alerts.some(a=>a[0]==='actual:44'&&a[3]==='loss'));
 assert.ok(f.alerts.some(a=>a[0]==='markup:44'&&a[5].suggested_sell_usd_per_min===.32773));
 assert.ok(!f.alerts.some(a=>a[0]==='route-review:44'));
 assert.ok(!f.sql.some(x=>/UPDATE wallet|INSERT INTO wallet|DELETE|TRUNCATE/.test(x.q)));
});
test('partial cost never becomes verified profit',async()=>{
 const f=auditFixture({web:false});await f.monitor.reconcile();
 assert.ok(f.alerts.some(a=>a[0]==='partial:44'));
 assert.ok(!f.sql.some(x=>x.q.includes('UPDATE call_sessions SET provider_cost_usd')));
});
test('correct 30% charge produces no loss or markup shortfall warning',async()=>{
 const f=auditFixture({wallet:'327730'});await f.monitor.reconcile();assert.ok(!f.alerts.some(a=>a[3]==='loss'||a[0]==='markup:44'));
});
test('transient report failure keeps only existing 15-minute verified window; stale or never verified still blocks',()=>{
 const mod={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'src/modules/calling-guard/guard.service.js'),'utf8'),{module:mod,exports:mod.exports,require:n=>n==='../../config/db'?{}:n==='./money-routes'?money:require(n),process:{env:{TELNYX_PHONE_NUMBER:'+16452199033'}},Date,console});
 const config={deck_version:'deck',caller_number:'+16452199033',imported_at:new Date(),max_deck_age_days:30,monitor_verified:true,last_monitor_sync:new Date(Date.now()-60000),monitor_error:'HTTP 429'};
 assert.equal(mod.exports.readiness(config),null);
 assert.match(mod.exports.readiness({...config,last_monitor_sync:new Date(Date.now()-16*60000)}),/monitor/);
 assert.match(mod.exports.readiness({...config,monitor_verified:false}),/monitor/);
});
