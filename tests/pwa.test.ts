import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
it('provides an installable identity and restricts service-worker interception to navigations',()=>{
 const manifest=JSON.parse(readFileSync('web/judge/public/manifest.webmanifest','utf8'));
 expect(manifest.id).toBe('/');expect(manifest.display).toBe('standalone');
 expect(manifest.icons.some((i:{sizes:string;purpose:string})=>i.sizes==='512x512'&&i.purpose==='maskable')).toBe(true);
 for(const icon of manifest.icons){const bytes=readFileSync('web/judge/public'+icon.src);const [width,height]=icon.sizes.split('x').map(Number);expect(bytes.readUInt32BE(16)).toBe(width);expect(bytes.readUInt32BE(20)).toBe(height);}
 const ico=readFileSync('web/judge/public/favicon.ico');expect(ico.readUInt16LE(2)).toBe(1);expect(ico.readUInt16LE(4)).toBe(3);
 const listeners:Record<string,(e:unknown)=>void>={};
 runInNewContext(readFileSync('web/judge/public/sw.js','utf8'),{self:{addEventListener:(name:string,fn:(e:unknown)=>void)=>{listeners[name]=fn;},location:{origin:'https://order-truth.vercel.app'}},URL});
 for(const [path,method,mode]of [['/api/session','GET','navigate'],['/api/scenarios','POST','navigate'],['/release.json','GET','cors'],['/assets/judge.js','GET','cors']]){
  let intercepted=false;listeners.fetch!({request:{url:'https://order-truth.vercel.app'+path,method,mode},respondWith:()=>{intercepted=true;}});expect(intercepted).toBe(false);
 }
 const offline=readFileSync('web/judge/public/offline.html','utf8');expect(offline).toContain('live connection');expect(offline).not.toContain('SUCCEEDED');
});
