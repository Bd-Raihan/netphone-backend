'use strict';
const {parentPort,workerData}=require('worker_threads');
const fs=require('fs').promises,os=require('os'),path=require('path');
const {execFile}=require('child_process'),{promisify}=require('util');
const {PNG}=require('pngjs'),jsQR=require('jsqr');
(async()=>{
 const dir=workerData.directory;
 try {
  const input=path.join(dir,'input.pdf'),output=path.join(dir,'page');
  await fs.writeFile(input,Buffer.from(workerData.bytes),{mode:0o600});
  const codes=[];
  for(const resolution of ['1200','1800']){
  await promisify(execFile)('pdftoppm',['-f','1','-l','3','-scale-to',resolution,'-png',input,output],{timeout:15000,maxBuffer:1024*1024});
  const pages=(await fs.readdir(dir)).filter(name=>/^page-\d+\.png$/.test(name)).sort();
  if(!pages.length || pages.length>3)throw Error('Invalid rendered pages');
  for(const name of pages){
  const png=PNG.sync.read(await fs.readFile(path.join(dir,name)));
  if(png.width*png.height>4000000)throw Error('Raster too large');
  const scanRegion=(left,top,width,height)=>{
   const pixels=new Uint8ClampedArray(width*height*4);
   for(let y=0;y<height;y++)pixels.set(png.data.subarray(((top+y)*png.width+left)*4,((top+y)*png.width+left+width)*4),y*width*4);
   for(let i=0;i<6;i++){
    const found=jsQR(pixels,width,height,{inversionAttempts:'attemptBoth'});
    if(!found)break;codes.push(found.data);
    const pts=Object.values(found.location);
    const minX=Math.max(0,Math.floor(Math.min(...pts.map(p=>p.x)))-12),maxX=Math.min(width-1,Math.ceil(Math.max(...pts.map(p=>p.x)))+12);
    const minY=Math.max(0,Math.floor(Math.min(...pts.map(p=>p.y)))-12),maxY=Math.min(height-1,Math.ceil(Math.max(...pts.map(p=>p.y)))+12);
    for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){const k=(y*width+x)*4;pixels[k]=pixels[k+1]=pixels[k+2]=pixels[k+3]=255;}
    if(i===5)throw Error('Too many QR codes');
   }
  };
  scanRegion(0,0,png.width,png.height);
  const midX=Math.floor(png.width/2),midY=Math.floor(png.height/2);
  scanRegion(0,0,midX,png.height);scanRegion(midX,0,png.width-midX,png.height);
  scanRegion(0,0,png.width,midY);scanRegion(0,midY,png.width,png.height-midY);
  }
  for(const name of pages)await fs.unlink(path.join(dir,name));
  }
  parentPort.postMessage({codes:[...new Set(codes)]});
 } finally {await fs.rm(dir,{recursive:true,force:true});}
})().catch(()=>parentPort.postMessage({error:true}));
