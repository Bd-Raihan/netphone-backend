'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const snapshot=require('./fax-admin-preservation.json');
test('all supplied existing Fax sending, receiving, documents, billing, rates and workers retain their original content (allowing Git line endings)',()=>{
 for(const [file,expected] of Object.entries(snapshot)){
  const bytes=fs.readFileSync(path.resolve(__dirname,'..',file));
  const raw=crypto.createHash('sha256').update(bytes).digest('hex');
  const lf=crypto.createHash('sha256').update(bytes.toString('utf8').replace(/\r\n/g,'\n')).digest('hex');
  assert.ok(raw===expected.sha256 || lf===expected.lf_sha256,file+' changed');
 }
});
