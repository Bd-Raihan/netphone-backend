'use strict';
// Local administrator diagnostic. GET only; never buys, releases, sends or bills.
require('dotenv').config({path:require('path').resolve(__dirname,'../.env'),quiet:true});
const fs=require('fs'),crypto=require('crypto');
const {PDFDocument}=require('pdf-lib');
const {spawnSync}=require('child_process');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function mediaUrl(value){
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||!/(^|\.)(amazonaws\.com|telnyx\.com|telnyxcloudstorage\.com)$/.test(url.hostname))
  throw Error('Provider media URL is outside the approved HTTPS hosts');
 return url.toString();
}
async function summary(bytes){
 const pdf=await PDFDocument.load(bytes,{ignoreEncryption:false});
 const dimensions=pdf.getPages().map((p,i)=>({page:i+1,width_pt:+p.getWidth().toFixed(3),height_pt:+p.getHeight().toFixed(3),
  width_mm:+(p.getWidth()*25.4/72).toFixed(2),height_mm:+(p.getHeight()*25.4/72).toFixed(2)}));
 const scan=spawnSync('/usr/bin/pdfimages',['-list','-'],{input:bytes,encoding:'utf8',timeout:15000,maxBuffer:256*1024});
 return {bytes:bytes.length,sha256:hash(bytes),page_count:dimensions.length,pages:dimensions,
  embedded_image_resolution:scan.status===0?scan.stdout.trim():'pdfimages unavailable or failed'};
}
async function run(){
 const db=require('../database/db');
 try{
 const args=process.argv.slice(2);
 if(args[0]==='--file'&&args.length===2){console.log(JSON.stringify(await summary(fs.readFileSync(args[1])),null,2));return;}
 if(args.length!==1||!/^\d+$/.test(args[0])||!Number.isSafeInteger(Number(args[0]))||Number(args[0])<1)throw Error('Usage: node scripts/fax-document-quality-check.js FAX_ID (or --file LOCAL_PDF)');
 const id=Number(args[0]);
 const row=(await db.query(`SELECT f.id,f.telnyx_fax_id,f.from_number,f.to_number,f.direction,f.pages,f.provider_connection_id,
 i.vault_file_name,i.file_sha256,i.source FROM netphone_faxes f JOIN netphone_fax_incoming i ON i.fax_id=f.id WHERE f.id=$1`,[id])).rows[0];
 if(!row||row.direction!=='inbound')throw Error('Received fax not found');
 const platform=require('../services/faxPlatform.service');
 const local=await platform._test.privateBytes(row.vault_file_name,row.file_sha256);
 console.log('READ ONLY: no document changes, fax transmission, purchase or wallet charges.');
 console.log(JSON.stringify({fax_id:id,source:row.source,stored_original:await summary(local)},null,2));
 const fax=await require('../services/telnyxFax.service').getFax(row.telnyx_fax_id);
 const connection=String(row.provider_connection_id||process.env.TELNYX_FAX_CONNECTION_ID);
 if(fax.direction!=='inbound'||fax.from!==row.from_number||fax.to!==row.to_number||String(fax.connection_id)!==connection)
  throw Error('Provider identity mismatch: stop and review this fax');
 console.log(JSON.stringify({provider_quality:fax.quality||'not_reported',provider_pages:fax.page_count||null,provider_status:fax.status},null,2));
 const seen=new Set();let checked=0;
 for(const key of ['stored_media_url','media_url']){
  if(!fax[key]||seen.has(fax[key]))continue;seen.add(fax[key]);
  try{
   const r=await require('axios').get(mediaUrl(fax[key]),{responseType:'arraybuffer',timeout:15000,maxContentLength:30*1024*1024,maxRedirects:0,proxy:false});
   const bytes=Buffer.from(r.data);
   console.log(JSON.stringify({provider_field:key,exact_byte_match:hash(bytes)===hash(local),provider_document:await summary(bytes)},null,2));checked++;
  }catch(e){console.log(JSON.stringify({provider_field:key,result:'unavailable',http_status:e.response?.status||null}));}
 }
 if(!checked)console.log('Provider media unavailable/expired. Compare a PDF downloaded from the Telnyx portal; do not resend or re-import blindly.');
 }finally{await db.pool.end();}
}
if(require.main===module)run().catch(e=>{console.error('Quality check failed:',e.response?'Provider request failed (no secret URLs printed)':e.message);process.exitCode=1;});
module.exports={hash,mediaUrl,summary};
