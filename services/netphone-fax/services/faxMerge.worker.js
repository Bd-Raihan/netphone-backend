'use strict';
const {parentPort,workerData}=require('worker_threads');
const {PDFDocument}=require('pdf-lib');
(async()=>{
 const documents=workerData.documents;
 if(!Array.isArray(documents)||!documents.length||documents.length>20)throw Error('Choose 1–20 files');
 let total=0,pages=0;const merged=await PDFDocument.create();let single;
 for(const item of documents){
  const bytes=Buffer.from(item.bytes);total+=bytes.length;
  if(!bytes.length||bytes.length>20*1024*1024||total>40*1024*1024)throw Error('Files exceed the upload limit');
  let doc;
  if(bytes.subarray(0,5).toString()==='%PDF-'){
   doc=await PDFDocument.load(bytes,{ignoreEncryption:false});
   if(doc.getPageCount()<1)throw Error('PDF has no pages');
   if(doc.getForm().getFields().some(field=>field.constructor.name==='PDFSignature')&&documents.length>1)throw Error('Send a digitally signed PDF by itself to preserve its signature');
   if(documents.length===1)single=bytes;
   else doc.getForm().flatten(); // Preserve filled form appearance in the combined fax.
  }else{
   doc=await PDFDocument.create();let image;
   if(bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a'){
    if(bytes.length<24||bytes.readUInt32BE(16)*bytes.readUInt32BE(20)>25000000)throw Error('Image resolution exceeds limit');
    image=await doc.embedPng(bytes);
   }else if(bytes[0]===255&&bytes[1]===216)image=await doc.embedJpg(bytes);
   else throw Error('Invalid PDF, JPG or PNG document');
   if(image.width*image.height>25000000)throw Error('Image resolution exceeds limit');
   const page=doc.addPage([612,792]),scale=Math.min(576/image.width,756/image.height);
   page.drawImage(image,{x:(612-image.width*scale)/2,y:(792-image.height*scale)/2,width:image.width*scale,height:image.height*scale});
  }
  pages+=doc.getPageCount();if(pages>350)throw Error('Combined fax exceeds 350 pages');
  if(!single)for(const page of await merged.copyPages(doc,doc.getPageIndices()))merged.addPage(page);
 }
 const bytes=single||Buffer.from(await merged.save());
 if(bytes.length>30*1024*1024)throw Error('Combined PDF exceeds 30 MB. Reduce document sizes');
 parentPort.postMessage({bytes,pages});
})().catch(e=>parentPort.postMessage({error:e.message.startsWith('Input document')?'Encrypted or invalid PDF is not supported':e.message.slice(0,160)}));
