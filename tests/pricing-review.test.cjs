'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const review=require('../src/modules/calling-guard/pricing-review');
const money=require('../src/modules/calling-guard/money-routes');
const uuid='22222222-2222-4222-8222-222222222222';
function fixture({rate='10000',sdk='2000',manual=null,usageRates=['10000','2000'],alerts,unsafeCountry=false,failRoute=false}={}) {
 const state={resolved:[],audit:[],queries:[]};
 const config={deck_version:'new-deck',sdk_microusd:sdk,caller_number:'+16452199033'};
 const rows=alerts || ['actual:1','markup:1','rate-change:1'].map(alert_key=>({alert_key,country_code:'IT',prefix:'39',severity:alert_key.startsWith('actual:')?'loss':'warning',details:{session_id:1}}));
 const call={id:1,to_phone_e164:'+390635091',meta:{telnyx_call_session_id:uuid}};
 const usage=usageRates.map((r,i)=>({session_uuid:uuid,kind:i?'webrtc':'sip-trunking',direction:'outbound',rate_microusd:r,to_number:'390635091',from_number:'16452199033'}));
 const query=async(sql,args=[])=>{
  state.queries.push(sql);
  if(sql.startsWith('SELECT * FROM voice_guard_alerts'))return {rows};
  if(sql.startsWith('SELECT id,to_phone'))return {rows:[call]};
  if(sql.startsWith('SELECT session_uuid'))return {rows:usage};
  if(sql.startsWith('UPDATE voice_guard_alerts')){state.resolved.push(...args[0]);return {rows:[]};}
  if(sql.startsWith('SELECT 1 FROM voice_guard_usage'))return {rows:usage.some(x=>x.kind==='webrtc'&&BigInt(x.rate_microusd)>BigInt(sdk))?[{}]:[]};
  return {rows:[]};
 };
 const api={transaction:async fn=>fn({query}),settings:async()=>config,
  selectRoute:async()=>{if(failRoute)throw Error('Ambiguous route costs');return {rate,fee:'0'}},
  policy:async()=>manual?{pricing_mode:'manual_rate',manual_sell_rate_usd_per_min:manual}:{markup_percent:30},
  prices:(r,p,c)=>money.pricing(r,p,c.sdk_microusd),
  countries:async()=>[{country_code:'IT',profit_usd_per_min:unsafeCountry?-.01:.01}],
  audit:async(...v)=>state.audit.push(v)};
 return {api,state,rows,usage};
}
test('CSV/current pricing repaired: all historical pricing warning kinds retire together',async()=>{
 const f=fixture();await review.reconcile(f.api,7);
 assert.deepEqual(f.state.resolved,['actual:1','markup:1','rate-change:1']);
 assert.equal(f.state.audit.length,1);
 assert.ok(!f.state.queries.some(x=>/UPDATE (call_sessions|wallet|voice_guard_actuals)/.test(x)));
});
test('CSV still below observed SIP cost: alert remains and cannot be dismissed by pricing UI',async()=>{
 const f=fixture({rate:'9000'});await review.reconcile(f.api);assert.deepEqual(f.state.resolved,[]);
});
test('separate WebRTC cost mismatch remains until verified WebRTC setting is corrected',async()=>{
 const f=fixture({sdk:'1000'});await review.reconcile(f.api);assert.deepEqual(f.state.resolved,[]);
 const fixed=fixture({sdk:'3000'});await review.reconcile(fixed.api);assert.equal(fixed.state.resolved.length,3);
});
test('manual below cost remains; safe saved manual price clears current issues',async()=>{
 const f=fixture({manual:'0.011'});await review.reconcile(f.api);assert.equal(f.state.resolved.length,0);
 const fixed=fixture({manual:'0.016'});await review.reconcile(fixed.api);assert.equal(fixed.state.resolved.length,3);
});
test('loss evidence is retained while WebRTC rate report is missing',async()=>{
 const f=fixture({usageRates:['10000']});await review.reconcile(f.api);
 assert.ok(!f.state.resolved.includes('actual:1'));assert.ok(!f.state.resolved.includes('rate-change:1'));
});
test('unrelated phone usage in same session cannot clear a loss',async()=>{
 const f=fixture();f.usage[1].to_number='8801712345678';await review.reconcile(f.api);
 assert.ok(!f.state.resolved.includes('actual:1'));
});
test('ambiguous route stays visible',async()=>{
 const f=fixture({failRoute:true});await review.reconcile(f.api);assert.deepEqual(f.state.resolved,[]);
});
test('manual country alert checks every prefix and retains any below-cost prefix',async()=>{
 const alerts=[{alert_key:'manual:IT',country_code:'IT',details:{}}];
 const bad=fixture({alerts,unsafeCountry:true});await review.reconcile(bad.api);assert.equal(bad.state.resolved.length,0);
 const good=fixture({alerts});await review.reconcile(good.api);assert.deepEqual(good.state.resolved,['manual:IT']);
});
test('dozens of historical warnings for one prefix are one actionable issue',()=>{
 const input=Array.from({length:84},(_,i)=>({alert_key:'markup:'+i,country_code:'IT',prefix:'39',severity:'warning',details:{csv_update_required:i===20}}));
 const rows=review.groupAlerts(input);assert.equal(rows.length,1);assert.equal(rows[0].related_alert_count,84);assert.equal(rows[0].details.csv_update_required,true);
 assert.equal(input[0].related_alert_count,undefined);
});
test('pending reports are not current-price warnings, but confirmed loss remains actionable',()=>{
 assert.equal(review.isReportNotice({alert_key:'missing:1',severity:'warning'}),true);
 assert.equal(review.isReportNotice({alert_key:'partial:1',severity:'warning'}),true);
 assert.equal(review.isReportNotice({alert_key:'actual:1',severity:'loss'}),false);
});

// Exercise the actual service entry points, not a copy of their logic.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os');
function serviceFixture({open=true,source=null,missingProvider=false}={}) {
 const state={sql:[],reviews:0,settings:{deck_version:'deck',sdk_microusd:'2000',default_markup:30,caller_number:'+16452199033',source_sha256:source},policies:[{prefix:'39',country_code:'IT',scope:'country',is_active:open}],reviewKeys:[]};
 const query=async(sql,args=[])=>{
  state.sql.push({sql,args});
  if(sql.startsWith("SELECT id FROM voice_providers")) return {rows:missingProvider?[]:[{id:1}]};
  if(sql.startsWith("SELECT id FROM voice_provider_plans")) return {rows:[{id:2}]};
  if(sql.startsWith('SELECT * FROM voice_guard_settings'))return {rows:[state.settings]};
  if(sql.startsWith('WITH eligible'))return {rows:[{iso:'IT',country:'Italy',count:1,min_rate:'10000',max_rate:'10000',min_cost:'12000',max_cost:'12000',min_sell:'15600',max_sell:'15600',min_profit:'3600',unsafe:false,prefix:'39',max_fee:'0'}]};
  if(sql.startsWith('SELECT * FROM voice_guard_policies'))return {rows:state.policies};
  if(sql.startsWith('SELECT country_code,prefix,is_active'))return {rows:[]};
  if(sql.startsWith('SELECT MAX(rate_microusd)'))return {rows:[{rate:'3000'}]};
  if(sql.startsWith('SELECT COUNT(*)'))return {rows:[{count:1}]};
  if(sql.startsWith('UPDATE voice_guard_settings SET deck_version')){state.settings.deck_version=args[0];return {rows:[]};}
  return {rows:[]};
 };
 const db={query,getClient:async()=>({query,release(){}})};
 const mod={exports:{}};
 const src=fs.readFileSync(path.join(__dirname,'../src/modules/calling-guard/guard.service.js'),'utf8');
 const m={...money,readDeck:async(_,fn)=>{await fn([{fixed:'39',iso:'IT',country:'Italy',origin:'',prefix:'39',rate:'10000',fee:'0'}],0);return 1;}};
 vm.runInNewContext(src,{module:mod,exports:mod.exports,process:{env:{TELNYX_PHONE_NUMBER:'+16452199033'}},console,Date,Buffer,require:n=>{
  if(n==='../../config/db')return db;
  if(n==='./money-routes')return m;
  if(n==='./pricing-review')return {...review,reconcile:async()=>{state.reviews++;state.reviewKeys.push(state.settings.deck_version);return {resolved:3}}};
  return require(n);
 }});
 return {guard:mod.exports,state};
}
test('real CSV activation entry point reconciles immediately after active deck switches',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'netphone-review-test-'));const file=path.join(dir,'rates.csv');fs.writeFileSync(file,'test rate deck');
 try {
  const f=serviceFixture();const result=await f.guard.importDeck({filePath:file});
  assert.equal(result.duplicate_import,false);assert.equal(f.state.reviews,1);
  assert.equal(f.state.reviewKeys[0],result.rate_card_code);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('reimport of same CSV also reconciles old alerts without duplicating deck',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'netphone-review-test-'));const file=path.join(dir,'rates.csv');fs.writeFileSync(file,'test rate deck');
 try {
  const source=require('node:crypto').createHash('sha256').update('test rate deck').digest('hex');
  const f=serviceFixture({source});const result=await f.guard.importDeck({filePath:file});
  assert.equal(result.duplicate_import,true);assert.equal(f.state.reviews,1);
  assert.ok(!f.state.sql.some(x=>x.sql.startsWith('INSERT INTO voice_guard_deck')));
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('one click updates all policies of open countries and known SDK cost, with no enable or wallet mutation',async()=>{
 const f=serviceFixture();const result=await f.guard.repairOpenPricing(7);
 const update=f.state.sql.find(x=>x.sql.startsWith('UPDATE voice_guard_policies SET pricing_mode'));
 assert.deepEqual(Array.from(update.args[0]),['IT']);assert.equal(result.countries_updated,1);
 assert.ok(f.state.sql.some(x=>x.sql==='UPDATE voice_guard_settings SET sdk_microusd=$1 WHERE id=1'&&x.args[0]==='3000'));
 assert.ok(!f.state.sql.some(x=>/UPDATE (wallet|call_sessions|voice_routes|voice_destination_policies)/.test(x.sql)||/SET is_active/.test(x.sql)));
});
test('one click excludes disabled countries',async()=>{
 const f=serviceFixture({open:false});await f.guard.repairOpenPricing(7);
 const update=f.state.sql.find(x=>x.sql.startsWith('UPDATE voice_guard_policies SET pricing_mode'));
 assert.equal(update.args[0].length,0);
});
test('actual country Save triggers review before returning refreshed country alerts',async()=>{
 const f=serviceFixture();const result=await f.guard.saveCountry({prefix:'39',adminUserId:7,payload:{country_code:'IT',pricing_mode:'auto_markup',markup_percent:30}});
 assert.equal(result.ok,true);assert.equal(f.state.reviews,1);
 assert.ok(f.state.sql.some(x=>x.args.includes('calling_country_policy_saved')));
});

test('activate-all enables country/prefix flags while preserving existing retail pricing and balances',async()=>{
 const f=serviceFixture({open:false});const result=await f.guard.activateAllCountries(7);
 assert.equal(result.activated,1);assert.equal(result.failed.length,0);
 const updates=f.state.sql.filter(x=>x.sql.startsWith('UPDATE voice_guard_policies'));
 assert.ok(updates.some(x=>x.sql.includes('is_active=TRUE')));
 assert.ok(updates.every(x=>!x.sql.includes('pricing_mode=')&&!x.sql.includes('markup_percent=')));
 assert.ok(!f.state.sql.some(x=>/UPDATE (users|wallets|wallet_transactions)/.test(x.sql)));
});
test('activate-all reports route setup failure and never claims that country was activated',async()=>{
 const f=serviceFixture({missingProvider:true});const result=await f.guard.activateAllCountries(7);
 assert.equal(result.activated,0);assert.equal(result.failed.length,1);
 assert.ok(result.failed[0].message.includes('provider'));
 assert.ok(!f.state.sql.some(x=>x.sql.startsWith('UPDATE voice_routes')));
});
test('registration reports retain all verified accounts regardless of the reporting cutoff',async()=>{
 const queries=[];const mod={exports:{}};
 const src=fs.readFileSync(path.join(__dirname,'../src/modules/admin-profit/admin.profit.service.js'),'utf8');
 vm.runInNewContext(src,{module:mod,exports:mod.exports,require:()=>({query:async sql=>{queries.push(sql);return {rows:[{}]}}})});
 await mod.exports.getRegisteredUserSummary();await mod.exports.getRegisteredUsers();
 assert.equal(queries.length,2);
 assert.ok(queries.every(q=>!q.includes('u.created_at >=') && q.includes('u.phone_verified_at IS NOT NULL')));
 assert.ok(queries.every(q=>!/(DELETE|UPDATE|ALTER)\s/i.test(q)));
});
