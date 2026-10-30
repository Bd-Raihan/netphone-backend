'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const path=require('path'),fs=require('fs').promises,os=require('os');
const root=require('fs').realpathSync(path.resolve(__dirname,'../services/netphone-fax'));
const {PDFDocument,StandardFonts}=require(path.join(root,'node_modules/pdf-lib'));
const {PNG}=require(path.join(root,'node_modules/pngjs'));
const math=require(path.join(root,'services/faxBillingMath'));
const money=require(path.join(root,'services/faxMoney'));
const multi=require(path.join(root,'services/faxMultiUpload.service'));
const receive=require(path.join(root,'services/faxReceiveId.service'));
const archive=require(path.join(root,'services/faxInboxArchive.service'));
const db={query:async()=>{throw Error('Unexpected database access');}};
require.cache[path.join(root,'database/db.js')]={id:path.join(root,'database/db.js'),filename:path.join(root,'database/db.js'),loaded:true,exports:db};
const actual=require(path.join(root,'services/faxActualBilling.service'));
process.env.TELNYX_FAX_CONNECTION_ID='fax-test';process.env.TELNYX_FAX_PHONE_NUMBER='+12058588597';
async function pdf(labels){const p=await PDFDocument.create(),font=await p.embedFont(StandardFonts.Helvetica);for(const label of labels)p.addPage([612,792]).drawText(label,{x:40,y:650,font,size:16});return Buffer.from(await p.save());}
async function text(bytes){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fax-test-'));try{const file=path.join(dir,'fax.pdf');await fs.writeFile(file,bytes);return (await require('util').promisify(require('child_process').execFile)('pdftotext',[file,'-'])).stdout;}finally{await fs.rm(dir,{recursive:true,force:true});}}
test('150% new markup; exact old 55/40 snapshots; rounding and zero cost',()=>{
 assert.equal(math.MARKUP_PERCENT,150);assert.equal(math.markup(12000n),30000n);assert.equal(math.markup(24200n),60500n);
 assert.equal(math.markup(12000n,55),18600n);assert.equal(math.markup(12000n,40),16800n);
 assert.equal(math.markup(0n),0n);assert.equal(math.markup(1n),3n);assert.throws(()=>math.markup(1n,500));
 assert.equal(money.sellRate({provider_cost_microusd_per_page:'7000',markup_percent:150}),17500n);
 const route={first:60,next:60,rate:'5000',per_call:'0'};
 assert.equal(math.estimate(route,1,120,'7000'),42500n);
 assert.equal(math.estimate(route,1,120,'7000',55),26350n);
});
test('new routes carry 150 snapshot and new quote revision',async()=>{
 const client={query:async sql=>sql.includes('netphone_fax_settings')?{rows:[{deck_version:'v1',fax_api_microusd:'7000',estimate_seconds_per_page:120}]}:{rows:[]}};
 const r=await actual.route('+12058588597','inbound',client);assert.equal(r.markup_percent,150);assert.match(r.revision,/:markup150:/);
});
test('PDF pages merge in user order; single PDF bytes remain identical',async()=>{
 const a=await pdf(['FIRST']),b=await pdf(['SECOND','THIRD']);
 const result=await multi.merge([{bytes:a},{bytes:b}]);assert.equal(result.pages,3);
 const words=await text(result.bytes);assert.ok(words.indexOf('FIRST')<words.indexOf('SECOND'));assert.ok(words.indexOf('SECOND')<words.indexOf('THIRD'));
 assert.deepEqual((await multi.merge([{bytes:a}])).bytes,a);
});
test('PDF + PNG mixed upload is one two-page fax; malformed and oversized rejected',async()=>{
 const png=new PNG({width:10,height:10});png.data.fill(255);
 const r=await multi.merge([{bytes:await pdf(['COVER'])},{bytes:PNG.sync.write(png)}]);assert.equal(r.pages,2);
 await assert.rejects(multi.merge([{bytes:Buffer.from('not a PDF')}]),/Invalid/);
 await assert.rejects(multi.merge(Array(21).fill({bytes:Buffer.from('x')})),/1–20/);
 await assert.rejects(multi.merge([{bytes:Buffer.alloc(20*1024*1024+1)}]),/limit/);
 const huge=await pdf(Array(351).fill('PAGE'));await assert.rejects(multi.merge([{bytes:huge}]),/350 pages/);
});
test('multiple upload stores one owner-bound record and original single endpoint is untouched',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'fax-upload-test-'));let insert;
 try{const bytes=await pdf(['ONE']);const result=await multi.upload({user:{id:91},files:[{buffer:bytes,size:bytes.length,originalname:'a.pdf'},{buffer:bytes,size:bytes.length,originalname:'b.pdf'}]},
 {query:async(sql,args)=>{insert=args;return {rows:[{id:8,created_at:'now'}]};}},directory);
 assert.equal(result.upload.upload_id,8);assert.equal(result.upload.pages,2);assert.equal(insert[0],91);assert.equal((await fs.readdir(directory)).length,1);
 await assert.rejects(multi.upload({user:{id:91},files:[{buffer:bytes,size:bytes.length,originalname:'bad.doc'}]}, {},directory),/PDF/);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('upload DB failure removes merged orphan',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fax-orphan-'));try{const bytes=await pdf(['A']);await assert.rejects(multi.upload({user:{id:1},files:[{buffer:bytes,size:bytes.length,originalname:'a.pdf'}]}, {query:async()=>{throw Error('DB failure');}},dir));assert.deepEqual(await fs.readdir(dir),[]);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('Receive ID parser never guesses user IDs, names or incomplete references',()=>{
 assert.deepEqual(receive.references('User ID: 42; NP-0123456789ABCDEF; IRS 12345'),[]);
 assert.deepEqual(receive.references('NetPhone Receive ID: NP-0123456789ABCDEF'),['NP-0123456789ABCDEF']);
 assert.deepEqual(receive.references('NetPhone Receive ID: NP-0123456789ABCDEFX'),[]);
 assert.equal(receive.references('NetPhone Receive ID: NP-0123456789ABCDEF\nNetPhone Receive ID: NP-1123456789ABCDEF').length,2);
});
test('real PDF extraction + OCR detects first and third-page IDs and conflicts',async()=>{
 const code='NP-0123456789ABCDEF',other='NP-1123456789ABCDEF';
 assert.deepEqual(await receive.decode(await pdf(['NetPhone Receive ID: '+code])),[code]);
 assert.deepEqual(await receive.decode(await pdf(['PAGE 1','PAGE 2','NetPhone Receive ID: '+code])),[code]);
 const codes=await receive.decode(await pdf(['NetPhone Receive ID: '+code,'NetPhone Receive ID: '+other]));assert.equal(codes.length,2);
 assert.deepEqual(await receive.decode(await pdf(['IRS reply without recipient ID'])),[]);
});
test('only a unique active exact Receive ID to our shared number resolves',async()=>{
 const code='NP-0123456789ABCDEF',fax={to_number:process.env.TELNYX_FAX_PHONE_NUMBER};
 const client={query:async()=>({rows:[{user_id:9,status:'active',receive_code:code}]})};
 assert.equal((await receive.resolve(client,[code],fax)).user_id,9);
 assert.equal(await receive.resolve(client,[code,'NP-1123456789ABCDEF'],fax),null);
 assert.equal(await receive.resolve(client,[code],{to_number:'+19999999999'}),null);
 assert.equal(await receive.resolve({query:async()=>({rows:[{status:'disabled'}]})},[code],fax),null);
});
function archiveClient({assigned=false,exists=false}={}){let insert=0;return {get insert(){return insert;},query:async(sql,args)=>{
 if(sql.includes('SELECT f.*'))return {rows:[{id:8,user_id:assigned?9:null,file_name:'incoming_8.pdf',from_number:'+19999999999'}]};
 if(sql.includes('INSERT INTO netphone_fax_inbox_archives')){insert++;return {rows:exists?[]:[{fax_id:8}]};}
 throw Error('Unexpected archive SQL');
}};}
test('archive records who/what/why, duplicate is idempotent; assigned fax forbidden',async()=>{
 const req={params:{faxId:'8'},user:{id:3},body:{reason:'No matching recipient'}};let actions=[];
 const client=archiveClient();assert.deepEqual(await archive.archive(req,fn=>fn(client),async(...args)=>actions.push(args)),{archived:true});
 assert.equal(actions[0][1],3);assert.equal(actions[0][2],'incoming_archived');assert.equal(actions[0][4].file_name,'incoming_8.pdf');
 actions=[];await archive.archive(req,fn=>fn(archiveClient({exists:true})),async(...args)=>actions.push(args));assert.equal(actions.length,0);
 await assert.rejects(archive.archive(req,fn=>fn(archiveClient({assigned:true})),async()=>{}),e=>e.status===409);
 await assert.rejects(archive.archive({...req,body:{reason:''}},()=>{},async()=>{}),/reason/);
});
async function settlement({percent=150,direction='outbound',cost=12000,reserve=42500,settled=false,state='prepaid',failBalance=false}={}){
 const b={fax_id:1,user_id:9,rate_snapshot:{dynamic:true,markup_percent:percent},state,actual_settled:settled,status:direction==='inbound'?'received':'delivered',direction,
 from_number:'+19999999999',to_number:'+12058588597',telnyx_fax_id:'provider-id',pages:1,amount_microusd:String(reserve),fax_created_at:new Date().toISOString()};
 const api={source:'api',session_id:'session',direction,from_number:'19999999999',to_number:'12058588597',connection_id:'fax-test',cost_microusd:String(cost),usage_details:{delivered_pages:1}};
 const sip={...api,cost_microusd:'0',usage_details:{billed_seconds:60}};let updated,ledger=[];
 const client={query:async(sql,args)=>{
  if(sql.includes('SELECT b.*,f.status'))return {rows:[b]};
  if(sql.includes("kind='fax'"))return {rows:[api]};
  if(sql.includes("kind='sip'"))return {rows:[sip]};
  if(sql.includes('SELECT receive_auto_from'))return {rows:[{receive_auto_from:'2026-01-01'}]};
  if(sql.includes('UPDATE netphone_fax_billing')){updated=args;return {rows:[]};}
  throw Error('Unexpected settle SQL '+sql);
 }};
 const value=await actual.settle(1,fn=>fn(client),async(c,user,amount,type,key)=>{
  if(failBalance)throw Object.assign(Error('Insufficient'),{status:402});ledger.push({amount,type,key});return {id:1};
 });return {value,updated,ledger};
}
test('Send 150% final charge/refund; old 55 snapshot remains at old charge',async()=>{
 const a=await settlement();assert.equal(a.updated[1],'30000');assert.equal(a.ledger[0].amount,12500n);assert.equal(a.ledger[0].type,'fax_refund');
 const old=await settlement({percent:55,reserve:26350});assert.equal(old.updated[1],'18600');assert.equal(old.ledger[0].amount,7750n);
});
test('Receive 150% charges once via same ledger; low balance remains payment due',async()=>{
 const r=await settlement({direction:'inbound',state:'payment_due',cost:24200,reserve:0});assert.equal(r.updated[1],'60500');assert.equal(r.ledger[0].amount,60500n);assert.equal(r.updated[5],'paid');
 const low=await settlement({direction:'inbound',state:'payment_due',cost:24200,reserve:0,failBalance:true});assert.equal(low.updated[5],'payment_due');assert.equal(low.ledger.length,0);
 const paid=await settlement({direction:'inbound',state:'paid',settled:true});assert.equal(paid.value,false);assert.equal(paid.ledger.length,0);
});
test('Send ceiling remains enforced, zero provider cost refunds full reserve',async()=>{
 const cap=await settlement({cost:40000});assert.equal(cap.updated[1],'42500');assert.equal(cap.updated[4],'57500');assert.equal(cap.ledger.length,0);
 const free=await settlement({cost:0});assert.equal(free.updated[5],'refunded');assert.equal(free.ledger[0].amount,42500n);
});
test('real QR routing, revoked QR fallback blocking, archive exclusion and exact-ID fallback',async()=>{
 const vault=await fs.mkdtemp(path.join(os.tmpdir(),'netphone-vault-test-'));
 process.env.FAX_PRIVATE_STORAGE_DIR=vault;
 const notifications=[];
 const notifyPath=path.join(root,'notifications/notification.service.js');
 require.cache[notifyPath]={id:notifyPath,filename:notifyPath,loaded:true,exports:{createNotification:async n=>notifications.push(n)}};
 const platform=require(path.join(root,'services/faxPlatform.service'));
 const QRCode=require(path.join(root,'node_modules/qrcode'));
 const token='a'.repeat(64),code='NP-0123456789ABCDEF';
 const p=await PDFDocument.create();const page=p.addPage([612,792]);
 const qr=await p.embedPng(await QRCode.toBuffer('NPFX1:'+token,{width:700,margin:4,errorCorrectionLevel:'H'}));
 page.drawImage(qr,{x:164,y:274,width:284,height:284});
 page.drawText('NetPhone Receive ID: '+code,{x:40,y:650,size:16});const qrBytes=Buffer.from(await p.save());
 const originalRoute=actual.route,originalSettle=actual.settle;let received=0;
 actual.route=async()=>({dynamic:true,markup_percent:150,provider_cost_microusd_per_page:'7000'});
 actual.settle=async()=>{received++;};
 try{
  let serial=100;
  async function run(bytes,{revoked=false,archived=false,alreadyAssigned=false}={}){
   const id=serial++,name=await platform._test.storePrivate(bytes),hash=require('crypto').createHash('sha256').update(bytes).digest('hex');
   const fax={id,user_id:null,to_number:'+12058588597',from_number:'+19999999999',pages:1,source:'provider_media',vault_file_name:name,file_sha256:hash};
   let assigned=0,invoices=0;
   const query=async(sql,args)=>{
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return {rows:[]};
    if(sql.includes('SELECT f.*,i.vault_file_name'))return {rows:[fax]};
    if(sql.includes('SELECT * FROM netphone_faxes WHERE id=$1 FOR UPDATE'))return {rows:[{...fax,user_id:alreadyAssigned?9:null}]};
    if(sql.includes('SELECT fax_id FROM netphone_fax_inbox_archives'))return {rows:archived?[{fax_id:id}]:[]};
    if(sql.includes('SELECT c.*,u.status'))return {rows:[{id:'cover-id',user_id:9,status:'active',revoked_at:revoked?'2026-01-01':null,destination:fax.to_number}]};
    if(sql.includes('SELECT r.user_id,r.receive_code'))return {rows:[{user_id:9,receive_code:code,status:'active'}]};
    if(sql.includes('SELECT billing_enabled,actual_billing'))return {rows:[{billing_enabled:true,actual_billing:true}]};
    if(sql.includes('UPDATE netphone_faxes SET user_id'))assigned++;
    if(sql.includes('INSERT INTO netphone_fax_billing')){invoices++;assert.equal(JSON.parse(args[4]).markup_percent,150);}
    return {rows:[]};
   };
   db.query=query;db.getClient=async()=>({query,release(){}});
   await platform._test.routePendingCovers();return {assigned,invoices};
  }
  assert.deepEqual(await run(qrBytes),{assigned:1,invoices:1});
  assert.deepEqual(await run(qrBytes,{revoked:true}),{assigned:0,invoices:0});
  assert.deepEqual(await run(qrBytes,{archived:true}),{assigned:0,invoices:0});
  assert.deepEqual(await run(qrBytes,{alreadyAssigned:true}),{assigned:0,invoices:0});
  assert.deepEqual(await run(await pdf(['NetPhone Receive ID: '+code])),{assigned:1,invoices:1});
  assert.deepEqual(await run(await pdf(['IRS reply without recipient ID'])),{assigned:0,invoices:0});
  assert.equal(received,2);assert.equal(notifications.length,2);
 }finally{actual.route=originalRoute;actual.settle=originalSettle;await fs.rm(vault,{recursive:true,force:true});}
});
test('multipart endpoint: auth first, 3 and 20 files accepted, bad extension rejected; temp files cleaned',async()=>{
 const express=require(path.join(root,'node_modules/express'));
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'fax-http-'));
 const app=express();let saved=0;
 multi.install(app,(req,res,next)=>{if(req.headers.authorization!=='Bearer test')return res.sendStatus(401);req.user={id:9};next();},
 fn=>async(req,res)=>{try{res.json({success:true,...await fn(req)});}catch(e){res.status(e.status||503).json({success:false,message:e.message});}},
 {query:async()=>({rows:[{id:++saved}]})},directory);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const url=`http://127.0.0.1:${server.address().port}/upload/multiple`;
 try{
  assert.equal((await fetch(url,{method:'POST'})).status,401);
  const bytes=await pdf(['PAGE']);
  for(const n of [3,20]){
   const body=new FormData();for(let i=0;i<n;i++)body.append('documents',new Blob([bytes],{type:'application/pdf'}),`file-${i}.pdf`);
   const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer test'},body});
   const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.upload.pages,n);
  }
  const invalid=new FormData();invalid.append('documents',new Blob([bytes]),'word.doc');
  assert.equal((await fetch(url,{method:'POST',headers:{authorization:'Bearer test'},body:invalid})).status,422);
  assert.equal(saved,2);
 }finally{await new Promise(r=>server.close(r));await fs.rm(directory,{recursive:true,force:true});}
});
test('filled PDF form values survive multi-file merge',async()=>{
 const p=await PDFDocument.create();const page=p.addPage();const field=p.getForm().createTextField('customer');field.setText('FORM VALUE');field.addToPage(page,{x:40,y:600,width:250,height:30});
 const merged=await multi.merge([{bytes:Buffer.from(await p.save())},{bytes:await pdf(['SECOND'])}]);assert.match(await text(merged.bytes),/FORM VALUE/);
});
