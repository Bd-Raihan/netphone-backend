'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('module');
const root=path.resolve(__dirname,'../services/fax-admin-report');
const report=require(path.join(root,'report'));
const sample={id:'68',direction:'outbound',pages:2,owner:{phone_e164:'+8801700000000',name:'Example'},
 from_number:'+12394451250',to_number:'+13047079471',net_micro:'72500',charged_micro:'85000',refunded_micro:'12500',
 cost_verified:true,provider_cost_microusd:'29000',actual_settled:true,billing_details:{delivered_pages:2},billing_state:'paid'};
test('Fax 68: actual debit less refund gives correct historical charge and profit',()=>{
 const r=report.row(sample);assert.equal(r.total_cost,'0.072500');assert.equal(r.profit,'0.043500');assert.equal(r.per_page_cost,'0.036250000');assert.equal(r.vat,null);assert.equal(r.provider_cost_plus_vat,null);
});
test('pending costs stay pending and failed faxes can show real losses',()=>{
 assert.equal(report.row({...sample,cost_verified:false}).profit,null);
 const r=report.row({...sample,status:'failed',net_micro:'0',provider_cost_microusd:'2000',pages:0,billing_details:{delivered_pages:0}});
 assert.equal(r.profit,'-0.002000');assert.equal(r.per_page_cost,null);
});
test('inbound receiver is never mislabeled as external sender',()=>{
 const r=report.row({...sample,direction:'inbound'});assert.equal(r.sender_name,null);assert.equal(r.receive_cost,'0.072500');assert.equal(r.send_cost,'0.000000');
});
test('money keeps precision beyond JavaScript safe integers',()=>{
 assert.equal(report.amount('9007199254740993'),'9007199254.740993');assert.equal(report.amount('-1'),'-0.000001');
});
test('filters reject invalid dates / ranges / offsets and bind escaped searches',()=>{
 for(const q of [{from:'2026-02-30'},{from:'2026-99-99'},{from:'2026-12-01',to:'2026-01-01'},{offset:-1},{offset:'x'},{bin:'delete'},{direction:'hack'}])assert.throws(()=>report.filters(q),{status:400});
 const f=report.filters({search:"'_%",bin:'all'});assert.equal(f.params[2],"%'\\_\\%%");assert.ok(!report.BASE.includes("'_%"));
});
test('archive/restore touch only new admin tables; never lock source Fax rows',async()=>{
 for(const archived of [true,false]){
 const sql=[];const c={query:async(q,p)=>{sql.push(q);return {rows:[{id:'68'}]};}};
 await report.visibility(c,'68',1,archived,'Admin requested');assert.equal(sql.length,3);
 for(const q of sql)assert.doesNotMatch(q,/DELETE|TRUNCATE|FOR UPDATE|UPDATE (netphone_faxes|wallets|wallet_transactions)/i);
 assert.match(sql[1],/netphone_fax_admin_visibility/);assert.match(sql[2],/netphone_fax_admin_report_audit/);
 }
});
test('missing fax or invalid reason creates no admin mutations',async()=>{
 const sql=[];const c={query:async(q)=>{sql.push(q);return {rows:[]};}};
 await assert.rejects(report.visibility(c,'68',1,true,'x'),{status:400});assert.equal(sql.length,0);
 await assert.rejects(report.visibility(c,'68',1,true,'Reason'),{status:404});assert.equal(sql.length,1);
});
const sums={count:'70',pages:'140',pending:'2',send:'72500',receive:'0',net:'72500',charged:'85000',refunded:'12500',provider:'29000',profit:'43500'};
test('PDF export includes all filtered rows in one transaction, not just current page',async()=>{
 const queries=[];const c={query:async(q,p)=>{queries.push([q,p]);return {rows:q.includes('AS count')?[sums]:Array.from({length:70},(_,i)=>({...sample,id:String(i+1)}))};}};
 const r=await report.list(c,{export:'true',offset:'50'});assert.equal(r.rows.length,70);assert.equal(r.totals.count,70);assert.equal(r.totals.verified_profit,'0.043500');assert.deepEqual(queries[1][1].slice(-2),[5001,0]);
});
test('oversized export stops clearly without returning a partial PDF',async()=>{
 let calls=0;const c={query:async()=>{calls++;return {rows:[{...sums,count:'5001'}]};}};
 await assert.rejects(report.list(c,{export:'true'}),{status:422});assert.equal(calls,1);
});
// Exercise real endpoint wrappers with dependency stubs, no live provider or database.
const handlers={},events=[];let role='admin',poolOptions,hold=false,releaseHold=[];
const client={query:async(q)=>{events.push(q);if(q.startsWith('SELECT id,role')){if(hold)await new Promise(r=>{releaseHold.push(r);});return {rows:[{id:1,role,status:'active'}]};}return {rows:[]};},release:()=>events.push('release')};
const originalLoad=Module._load;
Module._load=function(id,parent,...args){
 if(parent?.filename===path.join(root,'routes.js')){
 if(id==='express')return {Router:()=>({get:(p,h)=>handlers['GET '+p]=h,post:(p,h)=>handlers['POST '+p]=h})};
 if(id==='jsonwebtoken')return {verify:t=>{if(t!=='valid')throw Error();return {userId:1};}};
 if(id==='pg')return {Pool:class {constructor(o){poolOptions=o;}on(){}async connect(){return client;}}};
 if(id==='libphonenumber-js')return {parsePhoneNumberFromString:()=>({country:'US'})};
 }return originalLoad.call(this,id,parent,...args);
};
require(path.join(root,'routes'));Module._load=originalLoad;
process.env.JWT_ACCESS_SECRET='offline-test-secret';
function res(){return {code:200,set(){},status(n){this.code=n;return this;},json(v){this.body=v;return this;}};}
const req=()=>({headers:{authorization:'Bearer valid'},query:{},params:{},body:{}});
test('missing/invalid token never opens a database connection',async()=>{
 for(const token of ['', 'Bearer invalid']){const r=res();await handlers['GET /audit']({...req(),headers:{authorization:token}},r);assert.equal(r.code,401);}assert.equal(events.length,0);
});
test('live database role denies normal users and revoked admins; rollback occurs',async()=>{
 role='user';const r=res();await handlers['GET /audit'](req(),r);assert.equal(r.code,403);assert.ok(events.includes('ROLLBACK'));role='admin';
});
test('admin report uses independent max-two pool, read-only snapshot, bounded statements',async()=>{
 events.length=0;const r=res();await handlers['GET /audit'](req(),r);assert.equal(r.code,200);assert.equal(poolOptions.max,2);assert.equal(poolOptions.application_name,'netphone-fax-admin-report');
 assert.ok(events.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));assert.ok(events.some(q=>q.includes("statement_timeout='5s'")));assert.ok(events.includes('COMMIT'));
});
test('migration contains only new admin tables and no destructive commands',()=>{
 const sql=fs.readFileSync(path.resolve(__dirname,'../database/migrations/20261114_fax_admin_report.sql'),'utf8');
 assert.doesNotMatch(sql,/\b(DELETE|DROP|TRUNCATE|ALTER|UPDATE)\s+(TABLE\s+)?(netphone_faxes|users|wallets|wallet_transactions|netphone_fax_billing)\b/i);
 assert.doesNotMatch(sql,/REFERENCES|CASCADE/i);
});

test('saturated report connections reject extra requests without borrowing Fax worker connections',async()=>{
 hold=true;releaseHold=[];
 const first=res(),second=res(),third=res();
 const p1=handlers['GET /audit'](req(),first),p2=handlers['GET /audit'](req(),second);
 await new Promise(r=>setImmediate(r));
 await handlers['GET /audit'](req(),third);assert.equal(third.code,503);
 hold=false;releaseHold.forEach(r=>r());await Promise.all([p1,p2]);
 assert.equal(first.code,200);assert.equal(second.code,200);
});
test('standalone report never imports original Fax workers or modifies their startup',()=>{
 const files=['server.js','routes.js','report.js'].map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n');
 assert.doesNotMatch(files,/require\(['"][^'"]*(faxPlatform|faxActualBilling|faxCover|telnyxFax|document\.controller)/);
 assert.doesNotMatch(files,/setInterval|unlink|truncate|writeFile|renameSync/);
});
