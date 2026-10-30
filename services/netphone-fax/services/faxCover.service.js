'use strict';
const crypto = require('crypto');
const path = require('path');
const {Worker} = require('worker_threads');
const fs = require('fs').promises, os = require('os');
const {PDFDocument, StandardFonts, rgb} = require('pdf-lib');
const QRCode = require('qrcode');
const db = require('../database/db');
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
let jobs = 0;
function routingToken(value) {
 const m = /^NPFX1:([a-f0-9]{64})$/.exec(String(value));
 return m ? m[1] : null;
}
async function createCover(userId, recipientName, profile) {
 const destination = String(process.env.TELNYX_FAX_PHONE_NUMBER || '').trim();
 if (!/^\+[1-9]\d{7,14}$/.test(destination)) throw new Error('Fax number unavailable');
 const name=String(recipientName||'').trim();
 if(!/^[\x20-\x7e]{1,60}$/.test(name))throw Object.assign(new Error('Enter your recipient name in English (1–60 characters).'),{status:422});
 const token = crypto.randomBytes(32).toString('hex'), coverId = crypto.randomUUID();
 const count = await db.query('SELECT COUNT(*)::int AS n FROM netphone_fax_cover_codes WHERE user_id=$1 AND created_at>NOW()-INTERVAL \'1 hour\'',[userId]);
 if (count.rows[0].n >= 20) throw Object.assign(new Error('Too many cover pages. Try again later.'),{status:429});
 const pdf = await PDFDocument.create(), page = pdf.addPage([612,792]);
 const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
 const qr = QRCode.create(`NPFX1:${token}`,{errorCorrectionLevel:'H'});
 const line=(text,y,size=12,strong=false)=>page.drawText(text,{x:48,y,size,font:strong?bold:font,color:rgb(0,0,0)});
 line('NETPHONE - RECEIVE FAX COVER PAGE',738,20,true);
 const red=rgb(0.76,0.05,0.08);
 page.drawRectangle({x:48,y:650,width:516,height:68,borderColor:red,borderWidth:1.8});
 page.drawText('IMPORTANT: ATTACH THIS COVER PAGE FIRST.',{x:60,y:697,size:16,font:bold,color:red});
 page.drawText('Without it, your fax cannot be automatically delivered',{x:60,y:678,size:13,font:bold,color:red});
 page.drawText('to my NetPhone account.',{x:60,y:660,size:13,font:bold,color:red});
 const label=`Recipient: ${name}`;
 const nameSize=Math.min(14,516/bold.widthOfTextAtSize(label,1));
 line(label,628,nameSize,true);
 line(`Send fax to: ${destination}`,604,16,true);
 line(`NetPhone Receive ID: ${profile.receive_code}`,580,16,true);
 // Fixed QR location; renderer also checks the full first page for conflicting routing codes.
 // True PDF vectors: no embedded bitmap, JPEG compression or image interpolation.
 // Keep the existing physical size and four-module white quiet zone.
 const qrX=164,qrY=274,qrSize=284,margin=4,modules=qr.modules.size;
 const unit=qrSize/(modules+2*margin);
 page.drawRectangle({x:qrX,y:qrY,width:qrSize,height:qrSize,color:rgb(1,1,1)});
 // Draw horizontal black runs to keep the PDF compact and edges shared exactly.
 for(let row=0;row<modules;row++){
  for(let col=0;col<modules;){
   if(!qr.modules.get(row,col)){col++;continue;}
   const start=col;while(col<modules&&qr.modules.get(row,col))col++;
   page.drawRectangle({x:qrX+(margin+start)*unit,
    y:qrY+(margin+modules-row-1)*unit,width:(col-start)*unit,height:unit,color:rgb(0,0,0)});
  }
 }
 line('Reusable cover. No fixed expiry while your account remains active.',240,11,true);
 line('Valid until revoked. A new download does not cancel previous covers.',220,11);
 line('Keep the QR large, upright, uncropped and clear. Do not write over it.',198,11);
 line('This extra cover page may incur a per-page fax charge.',176,11);
 line('If routing fails, the document waits for private Admin review.',154,11);
 line('The code cannot open, download or sign in to an account.',132,11);
 const bytes=Buffer.from(await pdf.save());
 await db.query(`INSERT INTO netphone_fax_cover_codes(id,user_id,token_hash,destination,expires_at)
 VALUES($1,$2,$3,$4,'infinity'::timestamptz)`,[coverId,userId,hash(token),destination]);
 return bytes;
}
async function decodeCover(bytes) {
 if(jobs>=1) throw new Error('Cover scanner busy');
 jobs++;
 let directory;
 try {
 directory=await fs.mkdtemp(path.join(os.tmpdir(),"netphone-cover-"));return await new Promise((resolve,reject)=>{
  const worker=new Worker(path.join(__dirname,'faxCover.worker.js'),{workerData:{bytes,directory},resourceLimits:{maxOldGenerationSizeMb:192}});
  let done=false;
  const finish=(err,result)=>{if(done)return;done=true;clearTimeout(timer);void worker.terminate();err?reject(err):resolve(result);};
  const timer=setTimeout(()=>finish(new Error('Cover scan timeout')),25000);
  worker.once('message',m=>m.error?finish(new Error('Cover scan unavailable')):finish(null,m.codes));
  worker.once('error',e=>finish(e));worker.once('exit',()=>{if(!done)finish(new Error('Cover scan stopped'));});
 });} finally {jobs--;if(directory)await fs.rm(directory,{recursive:true,force:true});}
}
async function resolveCode(client, codes, fax) {
 const unique=[...new Set(codes.filter(c=>String(c).startsWith('NPFX1:')))];
 if(unique.length!==1)return null;
 const token=routingToken(unique[0]);if(!token)return null;
 const result=await client.query(`SELECT c.*,u.status FROM netphone_fax_cover_codes c
 JOIN users u ON u.id=c.user_id WHERE c.token_hash=$1 FOR UPDATE OF c`,[hash(token)]);
 const row=result.rows[0];
 // Existing non-revoked covers are reusable too, including previously used/expired covers.
 // Ownership, active-account, revocation and destination checks remain mandatory.
 if(!row || row.status!=='active' || row.revoked_at || row.destination!==fax.to_number)return null;
 return row;
}
async function revoke(userId) {
 await db.query(`UPDATE netphone_fax_cover_codes SET revoked_at=NOW() WHERE user_id=$1
 AND revoked_at IS NULL`,[userId]);
}
module.exports={createCover,decodeCover,resolveCode,revoke,_test:{routingToken,hash}};
