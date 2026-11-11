'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {finalizeRecording}=require('./resume-existing-case.cjs');
const HTML=`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; connect-src 'none'"><style>body{margin:0;background:#102238;color:white;font:64px sans-serif;display:grid;place-content:center;height:100vh}.dot{width:80px;height:80px;background:#41ddbb;animation:move 5s linear infinite}@keyframes move{to{transform:translateX(800px)}}small{font-size:28px}</style></head><body><h1>Recording lifecycle smoke test</h1><small>Local HTML · no session · no page network</small><div class="dot"></div></body></html>`;
function validateEnvironment(e){
 assert.equal(e.GITHUB_ACTIONS,'true','HOSTED_ONLY');assert.equal(e.GITHUB_RUN_ATTEMPT,'1','NO_RERUN');
 assert.equal(e.CLOUD_STAGE,'recording-smoke');assert.equal(e.OWNER_AUTHORIZATION,'RECORDING_SMOKE');
 assert(!e.ORDERTRUTH_GUEST_SESSION_B64,'SECRET_FORBIDDEN');assert(!e.REVIEWED_PLAN_ID&&!e.REVIEWED_PLAN_SHA256,'PLAN_FORBIDDEN');
}
function validateMedia(meta){
 const videos=meta.streams.filter(s=>s.codec_type==='video');assert.equal(videos.length,1);assert.equal(meta.streams.length,1);
 const v=videos[0];assert.equal(v.codec_name,'h264');assert.equal(v.width,1920);assert.equal(v.height,1080);
 assert.equal(v.avg_frame_rate,'30/1');assert.equal(v.pix_fmt,'yuv420p');assert.equal(Number(v.nb_read_frames),150);
 assert(Number.isFinite(Number(meta.format.duration))&&Math.abs(Number(meta.format.duration)-5)<=1/30);
 return {codec:'h264',width:1920,height:1080,fps:30,frames:150,durationSeconds:Number(meta.format.duration)};
}
async function blockPageNetwork(context,onBlocked){
 await context.setOffline(true);
 await context.route('**/*',async route=>{onBlocked();await route.abort();});
 await context.routeWebSocket('**/*',ws=>{onBlocked();ws.close();});
}
async function run(){
 validateEnvironment(process.env);
 const root=fs.realpathSync(path.join(__dirname,'..')),temp=fs.realpathSync(process.env.RUNNER_TEMP);
 const out=path.join(temp,'ordertruth-recording-smoke'),pub=path.join(out,'public'),rawDir=path.join(out,'raw');assert(!fs.existsSync(out));
 const pins=JSON.parse(fs.readFileSync(path.join(root,'tool-pins.json'),'utf8'));
 assert.equal(process.version,'v'+pins.node);assert.equal(require('playwright/package.json').version,pins.playwright);
 assert(process.env.PLAYWRIGHT_BROWSERS_PATH);
 const browserRoot=fs.realpathSync(process.env.PLAYWRIGHT_BROWSERS_PATH),{chromium}=require('playwright');
 assert(fs.realpathSync(chromium.executablePath()).startsWith(browserRoot+path.sep));
 for(const key of ['FFMPEG_PATH','FFPROBE_PATH'])assert(process.env[key]&&fs.statSync(process.env[key]).isFile());
 fs.mkdirSync(pub,{recursive:true});fs.mkdirSync(rawDir);
 let browser,context,page,closed=false,phase='browser-launch',blocked=0,ok=false;
 const lifecycle=[];let media=null;
 const allowedPhases=['browser-launch','context-create','local-page','recording','browser-close','video-save','encode','probe','full-decode','complete'];
 const diag={phase(p){assert(allowedPhases.includes(p));phase=p;},fail(){}};
 function command(tool,args){const r=spawnSync(tool,args,{encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024});assert.equal(r.status,0,'MEDIA_COMMAND_FAILED');return r.stdout;}
 try{
  browser=await chromium.launch({headless:true,chromiumSandbox:true,args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run']});assert.equal(browser.version(),pins.chromium);
  phase='context-create';context=await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:1,recordVideo:{dir:rawDir,size:{width:1920,height:1080}},serviceWorkers:'block'});
  await blockPageNetwork(context,()=>blocked++);
  page=await context.newPage();const video=page.video();phase='local-page';await page.setContent(HTML,{waitUntil:'load'});
  assert.equal(page.url(),'about:blank');phase='recording';await page.waitForTimeout(5000);
  const raw=path.join(rawDir,'smoke.webm');
  // Delegate the real operations to the production helper; wrappers only observe completion order.
  await finalizeRecording({
   context:{close:async()=>{await context.close();context=null;lifecycle.push('context.close');}},
   video:{saveAs:async file=>{assert(!closed);await video.saveAs(file);lifecycle.push('video.saveAs');}},
   browser:{close:async()=>{await browser.close();closed=true;lifecycle.push('browser.close');}},
   rawPath:raw,shouldSave:true
  },diag);
  assert.deepEqual(lifecycle,['context.close','video.saveAs','browser.close']);assert(closed);
  phase='probe';const rawMeta=JSON.parse(command(process.env.FFPROBE_PATH,['-v','error','-show_format','-of','json',raw]));
  const rawSeconds=Number(rawMeta.format.duration);assert(Number.isFinite(rawSeconds)&&rawSeconds>=5);
  const mp4=path.join(pub,'recording-smoke.mp4');phase='encode';
  command(process.env.FFMPEG_PATH,['-v','error','-xerror','-threads','1','-i',raw,'-ss',String(rawSeconds-5),'-t','5','-map','0:v:0','-vf','fps=30,scale=1920:1080,setsar=1','-frames:v','150','-an','-c:v','libx264','-preset','veryfast','-crf','20','-threads','1','-filter_threads','1','-pix_fmt','yuv420p','-movflags','+faststart','-n',mp4]);
  phase='probe';media=validateMedia(JSON.parse(command(process.env.FFPROBE_PATH,['-v','error','-count_frames','-show_streams','-show_format','-of','json',mp4])));
  phase='full-decode';command(process.env.FFMPEG_PATH,['-v','error','-xerror','-threads','1','-i',mp4,'-f','null','-']);
  media.sha256=crypto.createHash('sha256').update(fs.readFileSync(mp4)).digest('hex');phase='complete';ok=true;
 }finally{
  if(context)await context.close().catch(()=>{ok=false;});
  if(browser&&!closed)await browser.close().then(()=>{closed=true;}).catch(()=>{ok=false;});
  fs.rmSync(rawDir,{recursive:true,force:true});
  fs.writeFileSync(path.join(pub,'qc.json'),JSON.stringify({schemaVersion:1,test:'recording-smoke',ok,phase,lifecycle,browserClosed:closed,networkPolicy:'OFFLINE_ABORT_ALL_HTTP_AND_WEBSOCKET',blockedPageRequests:blocked,sessionLoaded:false,media,fullDecode:ok?'PASS':'NOT_PASSED'},null,2));
 }
 assert(ok);console.log('PASS: real local-page recording lifecycle and five-second MP4 QC.');
}
module.exports={validateEnvironment,validateMedia,blockPageNetwork,HTML};
if(require.main===module)run().catch(()=>{console.error('RECORDING_SMOKE_FAILED: sanitized QC only; no retry.');process.exitCode=1;});
