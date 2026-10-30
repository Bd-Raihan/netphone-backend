'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('crypto'),fs=require('fs'),path=require('path');
const root=process.env.PERSONAL_FAX_TEST_ROOT||path.resolve(__dirname,'../../services/netphone-fax');
const policy=require(path.join(root,'services/personalFaxPolicy'));
const provider=require(path.join(root,'services/personalFaxProvider'));
const service=require(path.join(root,'services/personalFaxNumbers.service'));
const T=service._test;
const {PGlite}=require(process.env.PGLITE_TEST_MODULE||'@electric-sql/pglite');
process.env.TELNYX_FAX_API_KEY='offline-test-only';process.env.TELNYX_FAX_PHONE_NUMBER='+12058588597';
process.env.TELNYX_FAX_CONNECTION_ID='111';process.env.TELNYX_PERSONAL_FAX_CONNECTION_ID='222';
process.env.TELNYX_PUBLIC_KEY=Buffer.alloc(32).toString('base64');process.env.FAX_PUBLIC_BASE_URL='https://example.com';
process.env.PERSONAL_FAX_PURCHASE_ENABLED='true';
const available={phone_number:'+12025550123',quickship:true,best_effort:false,cost_information:{currency:'USD',monthly_cost:'1.00000',upfront_cost:'1.00000'},features:[{name:'fax'}],region_information:[{region_type:'country_code',region_name:'US'}]};
provider.ready=async()=>provider.config();provider.available=async()=>[available];
provider.api=async()=>{throw Error('Unexpected provider request: no live API calls allowed');};
provider.lookup=async()=>null;provider.orders=async()=>[];
function req(user=1,body={},params={}){return {user:{id:user},body,params};}
async function expectStatus(p,status){await assert.rejects(p,e=>e.status===status);}

test('calendar rent: month lengths, leap year, initial proration, 2-day prepayment window',()=>{
 assert.deepEqual(policy.initialPeriods(new Date('2026-10-15T12:00:00Z')).map(x=>x.amount),['548390']);
 assert.deepEqual(policy.initialPeriods(new Date('2026-10-30T12:00:00Z')).map(x=>x.amount),['64520','1000000']);
 assert.equal(policy.initialPeriods(new Date('2028-02-29T12:00:00Z'))[0].amount,'34490');
 assert.equal(policy.nextMonth(new Date('2026-12-01')).toISOString(),'2027-01-01T00:00:00.000Z');
 assert.equal(policy.usd(1234567n),'1.234567');assert.throws(()=>policy.micro('-1'));assert.throws(()=>policy.micro('1.0000001'));
});
test('inventory only accepts verified instant US fax numbers at exactly $1/month',()=>{
 assert.ok(policy.available(available));
 for(const patch of [{quickship:false},{best_effort:true},{features:[{name:'voice'}]},{phone_number:'+442012345678'},{region_information:[]}])assert.equal(policy.available({...available,...patch}),null);
 for(const price of [{currency:'EUR',monthly_cost:'1',upfront_cost:'1'},{currency:'USD',monthly_cost:'2',upfront_cost:'1'},{currency:'USD',monthly_cost:'0',upfront_cost:'0'},{currency:'USD',monthly_cost:'1',upfront_cost:'1.01'}])assert.equal(policy.available({...available,cost_information:price}),null);
});
test('real Ed25519 webhook signature: exact raw bytes and timestamp replay limit',()=>{
 const keys=crypto.generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64');
 const raw=Buffer.from('{"data":{"event_type":"fax.received"}}'),now=Date.now(),timestamp=String(Math.floor(now/1000));
 const headers={'telnyx-timestamp':timestamp,'telnyx-signature-ed25519':crypto.sign(null,Buffer.concat([Buffer.from(timestamp+'|'),raw]),keys.privateKey).toString('base64')};
 assert.equal(policy.signature(raw,headers,publicKey,now),true);
 assert.equal(policy.signature(Buffer.from('{}'),headers,publicKey,now),false);
 assert.equal(policy.signature(raw,headers,publicKey,now+301000),false);
 assert.equal(policy.signature(raw,headers,'invalid',now),false);
});
test('owner-bound, signed price quotes reject tampering, expiry, account and connection changes',()=>{
 const q={user:'1',connection:'222',expires:Date.now()+10000,day:new Date().toISOString().slice(0,10)};
 const signed=T.signQuote(q);assert.deepEqual(T.readQuote(signed,1),q);
 assert.throws(()=>T.readQuote(signed,2));assert.throws(()=>T.readQuote(signed,1,Date.now()+20000));
 assert.throws(()=>T.readQuote(signed+'x',1));
 process.env.TELNYX_PERSONAL_FAX_CONNECTION_ID='333';assert.throws(()=>T.readQuote(signed,1));process.env.TELNYX_PERSONAL_FAX_CONNECTION_ID='222';
});
test('real PostgreSQL engine migration and purchase/rental/release lifecycle (provider mocked)',async t=>{
 const pg=new PGlite();
 const db={query:(q,p=[])=>pg.query(q,p),getClient:async()=>({query:(q,p=[])=>pg.query(q,p),release:()=>{}})};
 const transaction=async fn=>{await pg.exec('BEGIN');try{const r=await fn(db);await pg.exec('COMMIT');return r;}catch(e){await pg.exec('ROLLBACK');throw e;}};
 const sql=file=>fs.readFileSync(path.resolve(__dirname,'../../database/migrations',file),'utf8');
 await pg.exec(`CREATE TABLE users(id BIGINT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'active');
 CREATE TABLE wallets(user_id BIGINT PRIMARY KEY REFERENCES users(id),currency TEXT DEFAULT 'USD',balance_microusd BIGINT NOT NULL DEFAULT 0 CHECK(balance_microusd>=0),balance_cents BIGINT DEFAULT 0,updated_at TIMESTAMPTZ DEFAULT NOW());
 CREATE TABLE wallet_transactions(id BIGSERIAL PRIMARY KEY,user_id BIGINT REFERENCES users(id),type VARCHAR(20),amount_cents BIGINT,amount_microusd BIGINT,reference VARCHAR(100),idempotency_key TEXT,status TEXT,balance_after_cents BIGINT,balance_after_microusd BIGINT,meta JSONB,created_at TIMESTAMPTZ DEFAULT NOW());
 CREATE UNIQUE INDEX wallet_unique ON wallet_transactions(user_id,idempotency_key);
 CREATE TABLE netphone_faxes(id BIGINT PRIMARY KEY);
 CREATE ROLE netphone_user;
 INSERT INTO users(id) VALUES(1),(2),(3),(4),(5),(6);
 INSERT INTO wallets(user_id,balance_microusd,balance_cents) SELECT id,10000000,1000 FROM users;`);
 const notices=[];T.setContext({db,transaction,notify:async(...x)=>notices.push(x),importPersonal:async()=>{}});
 let lease;
 await t.test('migration applies twice without destroying data',async()=>{await pg.exec(sql('20261030_personal_fax_numbers.sql'));await pg.exec(sql('20261030_personal_fax_numbers.sql'));
 const p=(await pg.query("SELECT has_table_privilege('netphone_user','netphone_personal_fax_numbers','UPDATE') AS write,has_table_privilege('netphone_user','netphone_personal_fax_audit','DELETE') AS delete")).rows[0];assert.equal(p.write,true);assert.equal(p.delete,false);});
 await t.test('rollout allowlist blocks purchases for other accounts without disabling existing leases',async()=>{
  process.env.PERSONAL_FAX_ALLOWED_USER_IDS='6';await expectStatus(T.search(req(1)),403);
  assert.equal((await T.status(req(1))).enabled,false);
  delete process.env.PERSONAL_FAX_ALLOWED_USER_IDS;
 });
 await t.test('buy reserves exact setup + calendar rent atomically; retry never charges twice',async()=>{
  const found=await T.search(req()),option=found.numbers[0],body={request_key:crypto.randomUUID(),quote:option.quote};
  const first=await T.buy(req(1,body));lease=(await pg.query('SELECT * FROM netphone_personal_fax_numbers WHERE id=$1',[first.number.id])).rows[0];
  const balance=(await pg.query('SELECT balance_microusd FROM wallets WHERE user_id=1')).rows[0].balance_microusd;
  assert.equal(BigInt(balance),10000000n-policy.micro(option.total_usd));
  await T.buy(req(1,body));assert.equal((await pg.query('SELECT balance_microusd FROM wallets WHERE user_id=1')).rows[0].balance_microusd,balance);
  await expectStatus(T.buy(req(1,{...body,request_key:crypto.randomUUID()})),409);
 });
 await t.test('insufficient funds rolls back both lease and any partial setup debit',async()=>{
  await pg.query('UPDATE wallets SET balance_microusd=1000100 WHERE user_id=2');
  const option=(await T.search(req(2))).numbers[0];
  // Use another phone so the global live-number index is not the reason for rejection.
  available.phone_number='+12025550124';const o=(await T.search(req(2))).numbers[0];
  await expectStatus(T.buy(req(2,{request_key:crypto.randomUUID(),quote:o.quote})),402);
  assert.equal((await pg.query('SELECT balance_microusd FROM wallets WHERE user_id=2')).rows[0].balance_microusd,1000100);
  assert.equal((await pg.query('SELECT * FROM netphone_personal_fax_numbers WHERE user_id=2')).rows.length,0);
 });
 await t.test('ambiguous order POST is never repeated; customer-reference reconciliation activates exact number',async()=>{
  let posts=0;provider.api=async(method)=>{if(method==='POST'){posts++;throw Object.assign(Error('timeout'),{code:'ETIMEDOUT'});}throw Error('Unexpected');};
  await T.order(lease);lease=(await pg.query('SELECT * FROM netphone_personal_fax_numbers WHERE id=$1',[lease.id])).rows[0];
  assert.equal(lease.state,'ordering');assert.ok(lease.dispatch_started_at);
  await T.order(lease);assert.equal(posts,1);
  provider.orders=async()=>[{id:'order-1',customer_reference:'netphone-personal-'+lease.id,connection_id:'222',status:'success',phone_numbers:[{phone_number:lease.phone_number}]}];
  provider.lookup=async()=>({id:'p-1',phone_number:lease.phone_number,connection_id:'222',status:'active'});
  await T.order(lease);lease=(await pg.query('SELECT * FROM netphone_personal_fax_numbers WHERE id=$1',[lease.id])).rows[0];
  assert.equal(lease.state,'active');assert.equal(lease.provider_number_id,'p-1');assert.equal(posts,1);
 });
 await t.test('dedicated inbound maps recipient by destination/connection and lease interval only',async()=>{
  const fax={to:lease.phone_number,connection_id:'222',created_at:new Date(Date.now()+1000).toISOString()};
  assert.equal(String((await service.incomingOwner(db,fax)).user_id),'1');
  assert.equal(await service.incomingOwner(db,{...fax,connection_id:'111'}),null);
  assert.equal(await service.incomingOwner(db,{...fax,created_at:'2020-01-01'}),null);
  assert.equal(await service.incomingOwner(db,{...fax,to:'+12025550999'}),null);
  await pg.query("UPDATE users SET status='blocked' WHERE id=1");assert.equal(await service.incomingOwner(db,fax),null);
  await pg.query("UPDATE users SET status='active' WHERE id=1");
 });
 await t.test('release is owner-only, idempotent, confirmed remotely; future rent refunded and documents untouched',async()=>{
  await expectStatus(T.cancel(req(2,{}, {numberId:lease.id})),404);
  await T.cancel(req(1,{}, {numberId:lease.id}));await T.cancel(req(1,{}, {numberId:lease.id}));
  lease=(await pg.query('SELECT * FROM netphone_personal_fax_numbers WHERE id=$1',[lease.id])).rows[0];
  let deletes=0;provider.api=async method=>{if(method==='GET')return {data:{id:'p-1',phone_number:lease.phone_number,connection_id:'222',status:'active'}};deletes++;throw Error('timeout');};
  await assert.rejects(T.release(lease));assert.equal((await pg.query('SELECT state FROM netphone_personal_fax_numbers WHERE id=$1',[lease.id])).rows[0].state,'release_pending');
  provider.api=async method=>({data:{id:'p-1',phone_number:lease.phone_number,connection_id:'222',status:method==='GET'?'active':'deleted'}});
  await T.release(lease);let n=(await pg.query('SELECT * FROM netphone_personal_fax_numbers WHERE id=$1',[lease.id])).rows[0];assert.equal(n.state,'released');
  const before=(await pg.query('SELECT COUNT(*) AS n FROM wallet_transactions')).rows[0].n;await T.finish(n,'released');assert.equal((await pg.query('SELECT COUNT(*) AS n FROM wallet_transactions')).rows[0].n,before);
  const p=(await pg.query('SELECT * FROM netphone_personal_fax_periods WHERE number_id=$1',[lease.id])).rows;
  for(const x of p)assert.equal(x.refunded,new Date(x.period_start)>new Date());
 });
 await t.test('cancelling before dispatch refunds all charges without calling provider',async()=>{
  available.phone_number='+12025550125';const o=(await T.search(req(3))).numbers[0],r=await T.buy(req(3,{request_key:crypto.randomUUID(),quote:o.quote}));
  await T.cancel(req(3,{}, {numberId:r.number.id}));const n=(await pg.query('SELECT * FROM netphone_personal_fax_numbers WHERE id=$1',[r.number.id])).rows[0];
  provider.api=async()=>{throw Error('Must not contact provider');};await T.order(n);
  assert.equal((await pg.query('SELECT balance_microusd FROM wallets WHERE user_id=3')).rows[0].balance_microusd,10000000);
 });
 await t.test('renewal debits once; insufficient funds requests release without a negative wallet',async()=>{
  available.phone_number='+12025550126';const o=(await T.search(req(4))).numbers[0],r=await T.buy(req(4,{request_key:crypto.randomUUID(),quote:o.quote}));
  const soon=new Date(Date.now()+86400000);
  await pg.query("UPDATE netphone_personal_fax_numbers SET state='active',paid_until=$2,provider_number_id='p-4' WHERE id=$1",[r.number.id,soon]);
  const n=(await pg.query('SELECT * FROM netphone_personal_fax_numbers WHERE id=$1',[r.number.id])).rows[0];
  const before=BigInt((await pg.query('SELECT balance_microusd FROM wallets WHERE user_id=4')).rows[0].balance_microusd);
  await T.renew(n);await T.renew(n);
  assert.equal(BigInt((await pg.query('SELECT balance_microusd FROM wallets WHERE user_id=4')).rows[0].balance_microusd),before-1000000n);
  const current=(await pg.query('SELECT * FROM netphone_personal_fax_numbers WHERE id=$1',[r.number.id])).rows[0];
  await pg.query('UPDATE wallets SET balance_microusd=10 WHERE user_id=4');await pg.query('UPDATE netphone_personal_fax_numbers SET paid_until=$2 WHERE id=$1',[r.number.id,soon]);
  await T.renew({...current,paid_until:soon});assert.equal((await pg.query('SELECT state FROM netphone_personal_fax_numbers WHERE id=$1',[r.number.id])).rows[0].state,'release_pending');
  assert.equal((await pg.query('SELECT balance_microusd FROM wallets WHERE user_id=4')).rows[0].balance_microusd,10);
 });
 await t.test('shared number and foreign connection cannot be released',async()=>{
  let called=false;provider.api=async()=>{called=true;return {data:{phone_number:'+12025550126',connection_id:'999',status:'active'}};};
  const n=(await pg.query('SELECT * FROM netphone_personal_fax_numbers WHERE user_id=4')).rows[0];
  await T.release({...n,phone_number:process.env.TELNYX_FAX_PHONE_NUMBER});assert.equal(called,false);
  await T.release(n);assert.equal((await pg.query('SELECT state FROM netphone_personal_fax_numbers WHERE id=$1',[n.id])).rows[0].state,'release_pending');
 });
 await t.test('definite purchase rejection fully refunds reservation',async()=>{
  available.phone_number='+12025550127';const o=(await T.search(req(5))).numbers[0],r=await T.buy(req(5,{request_key:crypto.randomUUID(),quote:o.quote}));
  const n=(await pg.query('SELECT * FROM netphone_personal_fax_numbers WHERE id=$1',[r.number.id])).rows[0];
  provider.api=async()=>{throw {response:{status:422}};};await T.order(n);
  assert.equal((await pg.query('SELECT state FROM netphone_personal_fax_numbers WHERE id=$1',[n.id])).rows[0].state,'failed');
  assert.equal((await pg.query('SELECT balance_microusd FROM wallets WHERE user_id=5')).rows[0].balance_microusd,10000000);
 });
 await t.test('signed inbound queue is durable and duplicates do not create two jobs',async()=>{
  const keys=crypto.generateKeyPairSync('ed25519');process.env.TELNYX_PUBLIC_KEY=keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64');
  const faxId=crypto.randomUUID(),body={data:{event_type:'fax.received',payload:{fax_id:faxId,media_url:'https://s3.amazonaws.com/test.pdf'}}};
  const raw=Buffer.from(JSON.stringify(body)),timestamp=String(Math.floor(Date.now()/1000));
  const headers={'telnyx-timestamp':timestamp,'telnyx-signature-ed25519':crypto.sign(null,Buffer.concat([Buffer.from(timestamp+'|'),raw]),keys.privateKey).toString('base64')};
  let code;const response={status:s=>{code=s;return response;},json:()=>{},sendStatus:s=>{code=s;}};
  await T.webhook({rawBody:raw,headers,body},response);assert.equal(code,200);
  await T.webhook({rawBody:raw,headers,body},response);assert.equal((await pg.query('SELECT * FROM netphone_personal_fax_events WHERE fax_id=$1',[faxId])).rows.length,1);
  await T.webhook({rawBody:Buffer.from('{}'),headers,body},response);assert.equal(code,401);
 });
 await t.test('worker due query, PostgreSQL advisory lock and event retry execute',async()=>{
  await T.cycle();const rows=(await pg.query('SELECT * FROM netphone_personal_fax_events')).rows;
  assert.ok(rows[0].completed_at);
 });
 await pg.close();
});

test('actual fax cost uses stored personal connection and rejects shared/foreign billing identity',async()=>{
 const actual=require(path.join(root,'services/faxActualBilling.service'));
 const f={direction:'inbound',from_number:'19012510258',to_number:'12025550123',connection_id:'222',session_id:'session',cost_microusd:'21000',source:'api'};
 const sip={...f,cost_microusd:'32000'};
 const c={query:async q=>({rows:q.includes("kind='fax'")?[f]:[sip]})};
 const fax={telnyx_fax_id:'test',direction:'inbound',from_number:'+19012510258',to_number:'+12025550123',provider_connection_id:'222'};
 assert.equal(await actual.actualCost(fax,c),53000n);
 assert.equal(await actual.actualCost({...fax,provider_connection_id:'111'},c),null);
 sip.connection_id='999';assert.equal(await actual.actualCost(fax,c),null);
});
