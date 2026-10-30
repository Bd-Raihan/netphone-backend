'use strict';
const multer=require('multer'),path=require('path'),fs=require('fs').promises,crypto=require('crypto');
const {Worker}=require('worker_threads');
const MAX=40*1024*1024,MAX_FILES=20;
let jobs=0,uploadsInFlight=0;
const fail=(m,s=422)=>Object.assign(new Error(m),{status:s});
function merge(documents){
 if(jobs>=2)return Promise.reject(fail('Document processor busy. Try again shortly',429));
 jobs++;
 return new Promise((resolve,reject)=>{
  let worker,timer,done=false;
  const finish=(e,r)=>{if(done)return;done=true;clearTimeout(timer);if(worker)void worker.terminate();jobs--;e?reject(e):resolve(r);};
  try{
   worker=new Worker(path.join(__dirname,'faxMerge.worker.js'),{workerData:{documents},resourceLimits:{maxOldGenerationSizeMb:256}});
   timer=setTimeout(()=>finish(fail('Document merge timed out')),30000);
   worker.once('message',r=>r.error?finish(fail(r.error)):finish(null,{bytes:Buffer.from(r.bytes),pages:r.pages}));
   worker.once('error',()=>finish(fail('Unable to merge fax documents')));
   worker.once('exit',()=>{if(!done)finish(fail('Document processor stopped'));});
  }catch(e){finish(e);}
 });
}
async function upload(req,db,uploads){
 const files=req.files||[];
 if(!files.length||files.length>MAX_FILES)throw fail('Choose 1–20 PDF, JPG or PNG files');
 if(files.reduce((n,f)=>n+f.size,0)>MAX)throw fail('Combined files must be at most 40 MB');
 for(const f of files)if(!/\.(pdf|jpe?g|png)$/i.test(f.originalname))throw fail('Only PDF, JPG and PNG files are supported');
 const merged=await merge(files.map(f=>({bytes:f.buffer})));
 const name=`merged_${crypto.randomUUID()}.pdf`,target=path.join(uploads,name);
 await fs.mkdir(uploads,{recursive:true});
 await fs.writeFile(target,merged.bytes,{flag:'wx',mode:0o600});
 try{
  const original=files.length===1?path.basename(files[0].originalname).slice(0,240):`Combined_${files.length}_files.pdf`;
  const row=(await db.query(`INSERT INTO netphone_fax_uploads(user_id,stored_file_name,original_file_name,mime_type,file_size)
   VALUES($1,$2,$3,'application/pdf',$4) RETURNING id,created_at`,[req.user.id,name,original,merged.bytes.length])).rows[0];
  return {upload:{upload_id:row.id,original_name:original,mime_type:'application/pdf',size:merged.bytes.length,pages:merged.pages,created_at:row.created_at}};
 }catch(e){await fs.unlink(target).catch(()=>{});throw e;}
}
function install(router,auth,endpoint,db,uploads){
 // Disk-backed parsing caps memory before the aggregate 40 MB validation.
 const temp=path.join(uploads,'multi-temp');require('fs').mkdirSync(temp,{recursive:true});
 const storage={
  _handleFile(req,file,cb){
   const filename=crypto.randomUUID(),target=path.join(temp,filename);
   const output=require('fs').createWriteStream(target,{flags:'wx',mode:0o600});
   const limiter=new (require('stream').Transform)({transform(chunk,encoding,done){
    req.faxTotalBytes=(req.faxTotalBytes||0)+chunk.length;
    done(req.faxTotalBytes>MAX?fail('Combined files exceed 40 MB'):null,chunk);
   }});
   require('stream').pipeline(file.stream,limiter,output,error=>{
    if(error)void fs.unlink(target).catch(()=>{}).then(()=>cb(error));
    else cb(null,{destination:temp,filename,path:target,size:output.bytesWritten});
   });
  },
  _removeFile(req,file,cb){require('fs').unlink(file.path,cb);}
 };
 const parser=multer({storage,limits:{fileSize:20*1024*1024,files:MAX_FILES,fields:0,parts:MAX_FILES},
 fileFilter:(req,file,cb)=>cb(/\.(pdf|jpe?g|png)$/i.test(file.originalname)?null:fail('Only PDF, JPG and PNG files are supported'),/\.(pdf|jpe?g|png)$/i.test(file.originalname))}).array('documents',MAX_FILES);
 router.post('/upload/multiple',auth,(req,res,next)=>{
  if(uploadsInFlight>=2)return res.status(429).json({success:false,message:'Document upload busy. Try again shortly'});
  uploadsInFlight++;
  let released=false;const release=()=>{if(!released){released=true;uploadsInFlight--;}};
  res.once('finish',release);res.once('close',release);
  parser(req,res,async e=>{
  const files=req.files||[];
  try{
   if(e)throw fail('Choose up to 20 PDF/JPG/PNG files; maximum 20 MB each and 40 MB total');
   if(!files.length||files.reduce((n,f)=>n+f.size,0)>MAX)throw fail('Choose files up to 40 MB combined');
   // Files are read only after the aggregate limit is checked.
   for(const f of files)f.buffer=await fs.readFile(f.path);
   await endpoint(r=>upload(r,db,uploads))(req,res,next);
  }catch(err){res.status(err.status||503).json({success:false,message:err.status?err.message:'Unable to upload documents'});}
  finally{await Promise.all(files.map(f=>fs.unlink(f.path).catch(()=>{})));}
 });
 });
}
module.exports={install,upload,merge,MAX,MAX_FILES};
