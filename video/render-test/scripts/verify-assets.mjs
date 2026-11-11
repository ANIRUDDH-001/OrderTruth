import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const manifest=JSON.parse(fs.readFileSync('ASSET-MANIFEST.json','utf8'));
const actual=[];
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){assert(!e.isSymbolicLink());const p=path.posix.join(dir,e.name);if(e.isDirectory())walk(p);else actual.push(p);}}
walk('motion-test');walk('renders');walk('phase-a');
assert.deepEqual(actual.sort(),manifest.files.map(f=>f.path).sort());
for(const f of manifest.files)assert.equal(createHash('sha256').update(fs.readFileSync(f.path)).digest('hex'),f.sha256);
const html=fs.readFileSync('motion-test/index.html','utf8');
assert(!/(?:src|href)\s*=\s*["'](?:https?:|\/\/)|@import|\bfetch\s*\(|\bXMLHttpRequest\b/i.test(html));
assert(html.includes('window.__timelines["motion-test"] = tl'));
fs.writeFileSync('qc/assets-public.json',JSON.stringify({ok:true,files:manifest.files},null,2));
