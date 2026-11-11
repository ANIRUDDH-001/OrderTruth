// Adapted from the reviewed ordinary-host continuation: same case, same UI, separate hosted stages.
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {CASE,ORIGIN,BASE,validateCase,validatePlan,validReceipt,validateSession,configFromEnv,makePolicy,publicCapture}=require('./capture-policy.cjs');
function child(root,file){const p=path.resolve(file);assert(p.startsWith(path.resolve(root)+path.sep));return p;}
async function main(){
 const config=configFromEnv(process.env);assert.equal(process.env.GITHUB_ACTIONS,'true','Hosted capture only');assert.equal(process.env.GITHUB_RUN_ATTEMPT,'1','No mutation reruns');
 const root=fs.realpathSync(process.env.VIDEO_WORKSPACE),temp=fs.realpathSync(process.env.RUNNER_TEMP);
 const captureRoot=child(temp,process.env.CAPTURE_OUTPUT),out=path.join(captureRoot,'public'),privateDir=path.join(temp,'ordertruth-session-private');
 assert(!fs.existsSync(captureRoot));assert(!fs.existsSync(privateDir));
 const pins=JSON.parse(fs.readFileSync(path.join(root,'tool-pins.json'))),installed=require('playwright/package.json');assert.equal(installed.version,pins.playwright);
 assert(process.env.PLAYWRIGHT_BROWSERS_PATH&&fs.statSync(process.env.PLAYWRIGHT_BROWSERS_PATH).isDirectory());
 const {chromium}=require('playwright');const executable=fs.realpathSync(chromium.executablePath());child(fs.realpathSync(process.env.PLAYWRIGHT_BROWSERS_PATH),executable);
 for(const k of ['FFMPEG_PATH','FFPROBE_PATH'])assert(process.env[k]&&fs.statSync(process.env[k]).isFile());
 fs.mkdirSync(privateDir,{mode:0o700});fs.mkdirSync(out,{recursive:true});const sessionFile=path.join(privateDir,'storage-state.json');
 const info={stage:config.stage,complete:false,shots:{}};let browser,context,page,scenario,receipt,video,epoch,success=false;
 const policy=makePolicy(config),pending=new Set();
 const cleanup=()=>{fs.rmSync(privateDir,{recursive:true,force:true});};
 process.once('SIGTERM',()=>{cleanup();process.exit(143);});process.once('SIGINT',()=>{cleanup();process.exit(130);});
 try{
  const encoded=process.env.ORDERTRUTH_GUEST_SESSION_B64;delete process.env.ORDERTRUTH_GUEST_SESSION_B64;assert(encoded&&encoded.length<2000000);
  const state=JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));validateSession(state);
  fs.writeFileSync(sessionFile,JSON.stringify(state),{flag:'wx',mode:0o600});
  browser=await chromium.launch({headless:true,chromiumSandbox:true});assert.equal(browser.version(),pins.chromium);
  context=await browser.newContext({storageState:sessionFile,viewport:{width:1920,height:1080},deviceScaleFactor:1,recordVideo:{dir:privateDir,size:{width:1920,height:1080}},serviceWorkers:'block'});
  await context.route('**/*',async route=>{
   const req=route.request();let body;try{if(req.method()==='POST')body=req.postDataJSON();}catch{return route.abort();}
   if(!policy.allow(req.url(),req.method(),body,scenario))return route.abort();
   if(req.method()==='POST')fs.writeFileSync(path.join(privateDir,'write-attempt.json'),JSON.stringify({stage:config.stage,caseId:CASE}),{flag:'wx'});
   return route.continue();
  });
  page=await context.newPage();epoch=Date.now();video=page.video();
  page.on('response',response=>{const task=(async()=>{const u=new URL(response.url());if(![ORIGIN,'https://ordertruth.onrender.com'].includes(u.origin)||!response.ok())return;
   if(u.pathname===BASE){const d=await response.json();if(d?.run?.id)scenario=d;}
   if(config.planId&&u.pathname===BASE+'/receipts/'+config.planId){const d=await response.json();if(d?.receipt)receipt=d;}
  })().catch(()=>{});pending.add(task);task.finally(()=>pending.delete(task));});
  const now=()=>Math.max(0,(Date.now()-epoch)/1000);
  const wait=async(fn)=>{const until=Date.now()+90000;while(Date.now()<until){if(fn())return;await page.waitForTimeout(300);}throw Error('STAGE_TIMEOUT');};
  const hold=async(seconds)=>{const start=now();await page.waitForTimeout(seconds*1000);return [start,now()];};
  const show=async()=>{const loc=page.locator('.recovery-panel');assert.equal(await loc.count(),1);await loc.scrollIntoViewIfNeeded();};
  const refresh=async()=>{scenario=null;await page.reload({waitUntil:'domcontentloaded',timeout:60000});await wait(()=>scenario?.run?.id===CASE);validateCase(scenario);};
  await page.goto(ORIGIN+'/?run='+CASE,{waitUntil:'domcontentloaded',timeout:60000});await wait(()=>scenario?.run?.id===CASE);validateCase(scenario);
  // Immediately before arming a single UI operation, refresh current server facts.
  await refresh();
  if(config.stage!=='plan')info.reviewedPlan=validatePlan(scenario,config);
  else assert(!scenario.latestPlan||Date.parse(scenario.latestPlan.expires_at)<=Date.now(),'Existing unexpired proposal: review it, do not replace');
  const previous=scenario.latestPlan?.id;await show();const before=await hold(3);
  policy.arm();const start=now();
  const button=config.stage==='plan'?(previous?'Renew expired plan':'Review exact repair plan'):config.stage==='approve'?'Approve this exact merchant-only plan':'Execute approved local repair';
  const control=page.getByRole('button',{name:button,exact:true});assert.equal(await control.count(),1);assert(await control.isEnabled());await control.click();
  if(config.stage==='plan'){
   await wait(()=>scenario?.latestPlan?.id&&scenario.latestPlan.id!==previous);info.reviewedPlan=validatePlan(scenario,config);
   await show();const detail=page.getByText('Exact plan identity and order changes',{exact:true});if(await detail.count()===1)await detail.click();info.shots.S09=[before,[start,now()],await hold(8)];
  }else if(config.stage==='approve'){
   await wait(()=>scenario?.latestPlan?.approved===true);validatePlan(scenario,{...config,stage:'execute'});await show();info.shots.S09=[before,[start,now()],await hold(6)];
  }else{
   await wait(()=>validReceipt(receipt));validateCase(scenario,true);const receiptId=receipt.receipt.execution_id;await show();info.shots.S09=[before,[start,now()],await hold(6)];info.events=[{type:'repair-executed',start:info.shots.S09[2][0],end:info.shots.S09[2][1],receiptId}];
   const prior=await hold(4);receipt=null;scenario=null;const reload=now();await page.reload({waitUntil:'domcontentloaded',timeout:60000});await wait(()=>validReceipt(receipt)&&scenario?.run?.id===CASE);validateCase(scenario,true);assert.equal(receipt.receipt.execution_id,receiptId);
   assert.equal(scenario.latestPlan.id,config.planId);assert.equal(scenario.latestPlan.plan_sha256,config.planSha256);await show();info.shots.S10=[prior,[reload,now()],await hold(12)];
   info.receipt={id:receiptId,planId:config.planId,verifiedCurrent:true,reopened:true,activeOrders:1,matchingKeeper:1,providerUnchanged:true};info.events.push({type:'receipt-reopened',start:info.shots.S10[2][0],end:info.shots.S10[2][1],receiptId});
  }
  assert(policy.used);success=true;
 }finally{
  const captureEnd=epoch?(Date.now()-epoch)/1000:0;
  if(context)await context.close().catch(()=>{success=false;});await Promise.allSettled([...pending]);if(browser)await browser.close().catch(()=>{success=false;});
  try{
   if(success&&video){
    const raw=path.join(privateDir,'capture.webm');await video.saveAs(raw);const mp4=path.join(out,'continuation.mp4');
    function run(tool,args){const r=spawnSync(tool,args,{encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024});assert.equal(r.status,0,'MEDIA_CHECK_FAILED');return r.stdout;}
    run(process.env.FFMPEG_PATH,['-v','error','-xerror','-threads','1','-i',raw,'-vf','fps=30,scale=1920:1080,setsar=1','-an','-c:v','libx264','-preset','ultrafast','-crf','20','-threads','1','-filter_threads','1','-pix_fmt','yuv420p','-movflags','+faststart','-n',mp4]);
    const meta=JSON.parse(run(process.env.FFPROBE_PATH,['-v','error','-show_streams','-show_format','-of','json',mp4])),v=meta.streams.find(s=>s.codec_type==='video');assert(v.codec_name==='h264'&&v.width===1920&&v.height===1080&&v.avg_frame_rate==='30/1');
    const duration=Number(meta.format.duration),offset=duration-captureEnd;
    assert(Number.isFinite(duration)&&duration>0&&Math.abs(offset)<2,'RECORDING_CLOCK_MISMATCH');
    for(const ranges of Object.values(info.shots))for(const range of ranges){range[0]=Math.max(0,range[0]+offset);range[1]=Math.min(duration,range[1]+offset);assert(range[1]>range[0]);}
    for(const event of info.events||[]){event.start=Math.max(0,event.start+offset);event.end=Math.min(duration,event.end+offset);assert(event.end>event.start);}
    run(process.env.FFMPEG_PATH,['-v','error','-xerror','-i',mp4,'-f','null','-']);info.recordingMp4='continuation.mp4';info.sourceSha256=crypto.createHash('sha256').update(fs.readFileSync(mp4)).digest('hex');info.mp4Verified={codec:'h264',width:1920,height:1080,fps:30,duration,fullDecode:true};info.complete=true;
   }
  }finally{cleanup();fs.writeFileSync(path.join(out,'capture.json'),JSON.stringify(publicCapture(info),null,2));if(info.complete&&info.reviewedPlan)fs.writeFileSync(path.join(out,'fresh-plan.json'),JSON.stringify({caseId:CASE,...info.reviewedPlan},null,2));}
 }
 assert(info.complete,'STAGE_INCOMPLETE');console.log('Hosted stage complete; sanitized metadata written. Owner review required before any next stage.');
}
if(require.main===module){
 if(process.argv.includes('--policy-self-test'))require('./capture-policy.test.cjs');
 else main().catch(()=>{console.error('CAPTURE_STOPPED: no automatic retry. Owner must reconcile the existing case; private storage cleanup is also enforced by workflow.');process.exitCode=1;});
}
module.exports={child};
