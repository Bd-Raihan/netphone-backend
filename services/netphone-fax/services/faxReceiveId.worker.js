'use strict';
const {parentPort,workerData}=require('worker_threads');
const fs=require('fs').promises,os=require('os'),path=require('path');
const exec=require('util').promisify(require('child_process').execFile);
const {references}=require('./faxReceiveId.service');
(async()=>{
 const directory=workerData.directory;
 try{
  const input=path.join(directory,'input.pdf');await fs.writeFile(input,Buffer.from(workerData.bytes),{mode:0o600});
  // Inspect all of the first three pages, even if a reference is found early.
  const result=await exec('pdftotext',['-f','1','-l','3','-layout',input,'-'],{timeout:5000,maxBuffer:512*1024});
  const textCodes=references(result.stdout);
  await exec('pdftoppm',['-f','1','-l','3','-scale-to','2200','-png',input,path.join(directory,'page')],{timeout:10000,maxBuffer:1024*1024});
  const pages=(await fs.readdir(directory)).filter(n=>/^page-\d+\.png$/.test(n)).sort();
  if(!pages.length||pages.length>3)throw Error('Invalid PDF pages');
  const found=[...textCodes];
  for(const name of pages){
   const ocr=await exec('tesseract',[path.join(directory,name),'stdout','-l','eng','--psm','3'],{timeout:8000,maxBuffer:512*1024});
   found.push(...references(ocr.stdout));
  }
  parentPort.postMessage({codes:[...new Set(found)]});
 }finally{await fs.rm(directory,{recursive:true,force:true});}
})().catch(()=>parentPort.postMessage({error:true}));
