'use strict';
const fs=require('fs').promises,os=require('os');
const path=require('path'),{Worker}=require('worker_threads');
function references(text){
 const codes=[];
 // Exact account Receive ID only; never guess numeric user IDs, names or sender numbers.
 const re=/\bNetPhone\s+Receive\s+ID\s*[:#]\s*(NP-[A-F0-9]{16})(?![A-Z0-9-])/gi;
 for(const m of String(text).matchAll(re))codes.push(m[1].toUpperCase());
 return [...new Set(codes)];
}
let jobs=0;
async function decode(bytes){
 if(process.env.FAX_RECEIVE_ID_ROUTING_ENABLED==='false')return [];
 if(jobs>=1)throw Error('Receive ID scanner busy');
 jobs++;
 let directory;
 try {
 directory=await fs.mkdtemp(path.join(os.tmpdir(),'netphone-receive-id-'));
 return await new Promise((resolve,reject)=>{
  let worker,timer,done=false;
  const finish=(e,r)=>{if(done)return;done=true;clearTimeout(timer);if(worker)void worker.terminate();e?reject(e):resolve(r);};
  try{
   worker=new Worker(path.join(__dirname,'faxReceiveId.worker.js'),{workerData:{bytes,directory},resourceLimits:{maxOldGenerationSizeMb:128}});
   timer=setTimeout(()=>finish(Error('Receive ID scan timed out')),50000);
   worker.once('message',r=>r.error?finish(Error('Receive ID scan unavailable')):finish(null,r.codes));
   worker.once('error',e=>finish(e));worker.once('exit',()=>{if(!done)finish(Error('Receive ID scan stopped'));});
  }catch(e){finish(e);}
 });
 } finally {jobs--;if(directory)await fs.rm(directory,{recursive:true,force:true});}
}
async function resolve(client,codes,fax){
 if(fax.to_number!==String(process.env.TELNYX_FAX_PHONE_NUMBER||'').trim())return null;
 const unique=[...new Set(codes)];if(unique.length!==1||!/^NP-[A-F0-9]{16}$/.test(unique[0]))return null;
 const rows=(await client.query(`SELECT r.user_id,r.receive_code,u.status FROM netphone_fax_receivers r
 JOIN users u ON u.id=r.user_id WHERE r.receive_code=$1`,[unique[0]])).rows;
 if(rows.length!==1||rows[0].status!=='active')return null;
 return {user_id:rows[0].user_id,receive_code:rows[0].receive_code,via_receive_id:true};
}
module.exports={references,decode,resolve};
