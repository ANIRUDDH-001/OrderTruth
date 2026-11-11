import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const base = path.resolve('motion-test');
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.woff2':'font/woff2'};
const server = http.createServer((req,res)=>{
  const file = path.resolve(base, '.' + new URL(req.url,'http://localhost').pathname);
  if (!file.startsWith(base + path.sep)) {res.writeHead(403).end();return;}
  try {res.setHeader('Content-Type',mime[path.extname(file)] ?? 'application/octet-stream');res.end(fs.readFileSync(file));}
  catch {res.writeHead(404).end();}
});
let browser;
const report = {ok:false,externalRequests:0,runtimeErrors:0,fontLoaded:false,samples:[]};
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try {
  browser = await puppeteer.launch({executablePath:process.env.HYPERFRAMES_BROWSER_PATH,headless:true,
    args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'],timeout:30000});
  const page = await browser.newPage();
  await page.setViewport({width:1280,height:720,deviceScaleFactor:1});
  const origin=`http://127.0.0.1:${server.address().port}`;
  await page.setRequestInterception(true);
  page.on('request',r=>{
    if (r.url().startsWith(origin+'/') || r.url().startsWith('data:')) r.continue();
    else {report.externalRequests++;r.abort();}
  });
  page.on('pageerror',()=>report.runtimeErrors++);
  page.on('console',m=>{if(m.type()==='error') report.runtimeErrors++;});
  page.on('requestfailed',()=>report.runtimeErrors++);
  page.on('response',r=>{if(r.status()>=400) report.runtimeErrors++;});
  await page.goto(origin+'/index.html',{waitUntil:'networkidle0',timeout:30000});
  const state=await page.evaluate(async()=>{
    await document.fonts.load('400 20px OTInter');await document.fonts.load('700 68px OTInter');await document.fonts.ready;
    const root=document.querySelector('[data-composition-id]');const tl=window.__timelines?.[root.dataset.compositionId];
    if (!tl) throw new Error('timeline missing');
    return {id:root.dataset.compositionId,duration:Number(root.dataset.duration),width:Number(root.dataset.width),height:Number(root.dataset.height),fps:Number(root.dataset.fps),paused:tl.paused(),repeat:tl.repeat(),timelineDuration:tl.totalDuration(),fonts:[...document.fonts].filter(f=>f.family==='OTInter').map(f=>f.status)};
  });
  assert.equal(state.id,'motion-test');assert.equal(state.duration,5);assert.equal(state.width,1280);assert.equal(state.height,720);assert.equal(state.fps,30);
  assert(state.paused && state.repeat===0 && Number.isFinite(state.timelineDuration) && state.timelineDuration>0 && state.timelineDuration<=5);
  assert(state.fonts.length===2 && state.fonts.every(s=>s==='loaded'));report.fontLoaded=true;
  for(const t of [0,0.6,1.5,2.2,3.3,4.5]) {
    const sample=await page.evaluate(t=>{
      window.__timelines['motion-test'].seek(t,false);
      return {time:t,opacity:['test-line-1','test-line-2','test-tag'].map(id=>Number(getComputedStyle(document.getElementById(id)).opacity))};
    },t);
    report.samples.push(sample);
  }
  const o=report.samples.map(s=>s.opacity);
  assert(o[0].every(v=>v<0.01));assert(o[1][0]>0.99 && o[1][1]<0.01);assert(o[2][1]<0.01);
  assert(o[3][1]>0.99 && o[3][2]<0.01);assert(o[4][2]<0.01);assert(o[5].every(v=>v>0.99));
  assert.equal(report.externalRequests,0);assert.equal(report.runtimeErrors,0);
  report.ok=true;report.timeline={id:state.id,paused:state.paused,duration:state.timelineDuration};
} finally {
  if(browser) await browser.close();
  server.close();
  fs.writeFileSync('qc/browser-public.json',JSON.stringify(report,null,2));
}
