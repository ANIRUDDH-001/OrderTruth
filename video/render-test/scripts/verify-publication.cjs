'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../..');
const inventory=fs.readFileSync(path.join(root,'video/render-test/PUBLICATION-SCOPE.sha256'),'utf8').trim().split(/\r?\n/);
const seen=new Set();
for(const line of inventory){
 const match=/^([a-f0-9]{64}) \*(.+)$/.exec(line);assert(match,'Invalid publication inventory');
 const [,hash,name]=match;assert(!seen.has(name));seen.add(name);
 assert(name==='.github/workflows/video-render.yml'||name.startsWith('video/render-test/'));
 assert(!name.includes('..')&&!name.includes('\\')&&!/(?:^|\/)(?:private|footage|qc|final|__pycache__)(?:\/|$)/i.test(name));
 const file=path.resolve(root,name);assert(file.startsWith(root+path.sep));assert(!fs.lstatSync(file).isSymbolicLink());
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),hash,'Publication hash mismatch: '+name);
}
console.log('PASS: '+seen.size+' publication files hash-verified; inventory excludes its own hash.');
