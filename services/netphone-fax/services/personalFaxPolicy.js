'use strict';
const crypto = require('crypto');
const fail = (m,s=400) => Object.assign(new Error(m), {status:s});
const MONTHLY = 1000000n;
const LEAD_MS = 2*86400000;
function micro(value) {
  const s=String(value);
  if(!/^\d+(\.\d{1,6})?$/.test(s)) throw fail('Invalid provider price',503);
  const [a,b='']=s.split('.');return BigInt(a)*1000000n+BigInt(b.padEnd(6,'0'));
}
const usd = n => `${BigInt(n)/1000000n}.${(BigInt(n)%1000000n).toString().padStart(6,'0')}`;
function monthStart(date) {const d=new Date(date);return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1));}
function nextMonth(date) {const d=monthStart(date);d.setUTCMonth(d.getUTCMonth()+1);return d;}
function initialPeriods(now=new Date()) {
  const start=monthStart(now), end=nextMonth(now);
  const days=(end-start)/86400000, remaining=days-now.getUTCDate()+1;
  // Match the provider report's five-decimal precision, rounding upward.
  const prorated=((MONTHLY*BigInt(remaining)+BigInt(days)-1n)/BigInt(days)+9n)/10n*10n;
  const periods=[{start:start.toISOString(),end:end.toISOString(),amount:prorated.toString()}];
  // Prepay the next calendar month only when already in its renewal window.
  if(now.getTime()>=end.getTime()-LEAD_MS) periods.push({start:end.toISOString(),end:nextMonth(end).toISOString(),amount:MONTHLY.toString()});
  return periods;
}
// Both quickship values are valid: activation is independently verified by the worker.
// Keep rejecting missing flags and best-effort inventory.
function available(row) {
  const c=row?.cost_information;
  if(!/^\+1\d{10}$/.test(row?.phone_number||'') || c?.currency!=='USD' || typeof row.quickship!=='boolean' || row.best_effort!==false) return null;
  if(!(row.features||[]).some(f=>f.name==='fax'))return null;
  if(!(row.region_information||[]).some(r=>r.region_type==='country_code'&&r.region_name==='US'))return null;
  try {if(micro(c.monthly_cost)!==MONTHLY||micro(c.upfront_cost)>MONTHLY)return null;}
  catch(_){return null;}
  return {phone_number:row.phone_number,upfront:micro(c.upfront_cost).toString(),monthly:MONTHLY.toString()};
}
function signature(raw,headers,publicKey,now=Date.now()) {
  const timestamp=String(headers['telnyx-timestamp']||''), sig=String(headers['telnyx-signature-ed25519']||'');
  if(!Buffer.isBuffer(raw)||!/^\d{10}$/.test(timestamp)||Math.abs(now/1000-Number(timestamp))>300)return false;
  try {
    const keyBytes=Buffer.from(publicKey||'','base64');if(keyBytes.length!==32)return false;
    const key=crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),keyBytes]),format:'der',type:'spki'});
    return crypto.verify(null,Buffer.concat([Buffer.from(timestamp+'|'),raw]),key,Buffer.from(sig,'base64'));
  } catch(_){return false;}
}
module.exports={fail,micro,usd,MONTHLY,LEAD_MS,monthStart,nextMonth,initialPeriods,available,signature};
