'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {statusTiming}=require('../src/modules/calls/provider-duration');
const root=path.join(__dirname,'../src');
test('active timer uses provider answer timestamp even when first poll arrives four seconds late',()=>{
 const result=statusTiming({answered_at:new Date('2026-11-14T08:12:49Z'),ended_at:null},new Date('2026-11-14T08:12:53Z'));
 assert.equal(result.elapsed_seconds,4);assert.equal(result.finalized,false);
});
test('final screen and summary share the stored provider duration, including delayed handset events',()=>{
 const result=statusTiming({answered_at:'2026-11-14T08:12:49Z',ended_at:'2026-11-14T08:13:00Z',duration_sec:11},new Date('2026-11-14T08:14:00Z'));
 assert.equal(result.elapsed_seconds,11);assert.equal(result.finalized,true);
});
test('unanswered and free call duration are zero',()=>{
 assert.equal(statusTiming({answered_at:null,ended_at:new Date(),duration_sec:0}).elapsed_seconds,0);
});
test('stored provider duration wins over timestamp subsecond rounding once finalized',()=>{
 assert.equal(statusTiming({answered_at:'2026-11-14T08:12:49.507Z',ended_at:'2026-11-14T08:13:00.047Z',duration_sec:11}).elapsed_seconds,11);
});
test('report history is no longer hidden by the retired reporting-period cutoff; estimates remain separate',async()=>{
 const queries=[],mod={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'modules/admin-profit/admin.profit.service.js'),'utf8'),{
 module:mod,exports:mod.exports,require:()=>({query:async sql=>{queries.push(sql);return {rows:[{}]}}})});
 await mod.exports.getProfitSummary();await mod.exports.getCallWiseProfitDetails();
 assert.ok(queries.every(q=>!q.includes('cs.started_at >= COALESCE')));
 assert.ok(queries[0].includes('pending_estimated_profit'));
 assert.ok(queries[0].includes("SUM(net_profit)"));
 assert.ok(queries[0].includes("a.cost_status='sip_and_webrtc' THEN (ledger.net-a.provider_microusd)"));
});
test('fast scheduling coalesces concurrent webhook triggers and never blocks them on Telnyx',()=>{
 let schedules=0,canceled=0;
 const mod={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'modules/calling-guard/cost-monitor.js'),'utf8'),{
 module:mod,exports:mod.exports,require:()=>({}),process:{env:{}},console,Date,
 setTimeout:()=>{schedules++;return {unref(){}}},clearTimeout:()=>{canceled++},clearInterval(){},
 });
 mod.exports.scheduleSync();mod.exports.scheduleSync();mod.exports.scheduleSync();
 assert.equal(schedules,1);mod.exports.stop();assert.equal(canceled,1);
});
test('local pending refresh matches records immediately and requests a coalesced provider refresh',async()=>{
 const sql=[],mod={exports:{}};let scheduled=0;
 const query=async q=>{sql.push(q);return {rows:q.includes('SELECT 1 FROM call_sessions')?[{}]:[]}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'modules/calling-guard/cost-monitor.js'),'utf8'),{
 module:mod,exports:mod.exports,require:n=>n==='../../config/db'?{query}:{},process:{env:{}},console,Date,
 setTimeout:()=>{scheduled++;return {unref(){}}}
 });
 await mod.exports.refreshPending();
 assert.equal(scheduled,1);
 assert.ok(sql.some(q=>q.includes('s.ended_at<=NOW()')));
 assert.ok(!sql.some(q=>q.includes("INTERVAL '5 minutes'")));
});
