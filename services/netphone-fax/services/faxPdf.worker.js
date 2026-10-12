"use strict";
const {parentPort, workerData} = require("worker_threads");
const {PDFDocument} = require("pdf-lib");
(async () => {
  const input = new Uint8Array(workerData.bytes);
  let pdf, bytes;
  if (workerData.mime === "application/pdf") {
    pdf = await PDFDocument.load(input, {ignoreEncryption:false});
    bytes = input; // Preserve original PDF bytes, including signed documents.
  } else {
    pdf = await PDFDocument.create();
    if (workerData.mime === "image/png") {
      const header = Buffer.from(input);
      if (header.length < 24 || header.subarray(0,8).toString("hex") !== "89504e470d0a1a0a" ||
        header.readUInt32BE(16)*header.readUInt32BE(20) > 25000000) throw new Error("Invalid/oversized PNG");
    }
    const image = workerData.mime === "image/png" ? await pdf.embedPng(input) : await pdf.embedJpg(input);
    if (image.width * image.height > 25000000) throw new Error("Image resolution is too large.");
    const page = pdf.addPage([612,792]);
    const scale = Math.min(576/image.width,756/image.height);
    const width = image.width*scale, height = image.height*scale;
    page.drawImage(image,{x:(612-width)/2,y:(792-height)/2,width,height});
    bytes = await pdf.save();
  }
  const pages = pdf.getPageCount();
  if (pages < 1 || pages > 350 || bytes.length > 30*1024*1024) throw new Error("Invalid document size or page count.");
  parentPort.postMessage({pages,bytes});
})().catch(() => parentPort.postMessage({error:"Unable to read this PDF/image. Encrypted or invalid documents are not supported."}));
