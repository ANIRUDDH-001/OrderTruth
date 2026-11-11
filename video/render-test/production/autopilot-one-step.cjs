'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {CASE,ORIGIN,BASE,validateCase,validateSession}=require('./capture-policy.cjs');
const {finalizeRecording}=require('./resume-existing-case.cjs');
const MODEL='groq:openai/gpt-oss-120b';
const CHECKS=['HANDLER_TIMING','IDEMPOTENCY_KEYS','MERCHANT_WRITE_OUTCOMES'];
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function unchangedIdentity(s){
 validateCase(s);const p=s.latestPlan;
 if(p){assert.equal(p.approved,false);assert.equal(p.has_receipt,false);}
 return digest({orders:s.orders,paymentReference:s.paymentReference,plan:p?{
  id:p.id,hash:p.plan_sha256,keep:p.keep_order_id,voids:p.void_order_ids_json,
  expiresAt:p.expires_at,approved:p.approved,hasReceipt:p.has_receipt
 }:null});
}
function validateEnvironment(e){
 assert.equal(e.GITHUB_ACTIONS,'true');assert.equal(e.GITHUB_RUN_ATTEMPT,'1');
 assert.equal(e.CLOUD_STAGE,'autopilot-one-step');assert.equal(e.OWNER_AUTHORIZATION,'RECORD_ONE_AI_STEP');
 assert(!e.REVIEWED_PLAN_ID&&!e.REVIEWED_PLAN_SHA256);assert(!e.GROQ_API_KEY&&!e.GEMINI_API_KEY&&!e.AI_API_KEY,'Provider keys belong only on backend');
}
function makePolicy(initialIdentity){
 let armed=false,used=false,blockedPosts=0;
 return {arm(){assert(!used);armed=true;},allow(url,method,body,scenario){
  let u;try{u=new URL(url);}catch{return false;}
  if(u.origin!==ORIGIN||u.username||u.password)return false;
  if(['GET','HEAD'].includes(method))return !u.pathname.startsWith('/api/')||(!u.search&&['/api/session',BASE,BASE+'/investigation',BASE+'/autopilot/trace'].includes(u.pathname));
  if(method!=='POST')return false;
  if(!armed||used||u.pathname!==BASE+'/autopilot'||u.search){blockedPosts++;return false;}
  try{assert.deepEqual(body,{});assert.equal(unchangedIdentity(scenario),initialIdentity);}catch{blockedPosts++;return false;}
  used=true;armed=false;return true;
 },get used(){return used;},get blockedPosts(){return blockedPosts;}};
}
function validateEntry(s){
 assert.equal(s?.model,MODEL);assert.match(s.snapshotSha256,/^[a-f0-9]{64}$/);
 assert(typeof s.generatedAt==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(s.generatedAt)&&Number.isFinite(Date.parse(s.generatedAt)));assert.equal(typeof s.concluded,'boolean');
 assert(s.usage&&['promptTokens','outputTokens','totalTokens'].every(k=>s.usage[k]===null||(Number.isSafeInteger(s.usage[k])&&s.usage[k]>=0)));
 assert(Array.isArray(s.evidence)&&s.evidence.length>0&&s.evidence.length<=100);
 const ids=new Set(s.evidence.map(e=>e.id));assert.equal(ids.size,s.evidence.length);
 for(const id of ids)assert(typeof id==='string'&&/^[A-Za-z0-9_:-]{1,100}$/.test(id));
 const i=s.investigation;assert(i&&CHECKS.includes(i.nextDiagnostic));
 assert(Array.isArray(i.hypotheses)&&i.hypotheses.length>=2&&i.hypotheses.length<=4);
 for(const h of i.hypotheses){
  assert.equal(h.status,'HYPOTHESIS');assert.equal(h.confidence,'LOW');
  assert(typeof h.explanation==='string'&&h.explanation.length>0&&h.explanation.length<=500);
  assert(Array.isArray(h.evidenceIds)&&h.evidenceIds.length>0&&h.evidenceIds.length<=10);
  assert(h.evidenceIds.every(id=>ids.has(id)));
 }
 return s;
}
function validateFresh(s){
 assert.equal(s?.status,'FRESH');assert.equal(s.freshModelExecution,true);validateEntry(s);
 if(s.concluded)assert.equal(s.executed,null);
 else {assert.equal(s.executed?.source,'MERCHANT_DIAGNOSTIC');assert.equal(s.executed?.facts?.diagnostic,s.investigation.nextDiagnostic);}
 return s;
}
function validatePersisted(t,s){
 assert.equal(t?.policy,'merchant-agent-v1');assert(Array.isArray(t.steps)&&t.steps.length===1);
 const saved=validateEntry(t.steps[0]);
 for(const k of ['snapshotSha256','model','generatedAt','concluded'])assert.equal(saved[k],s[k]);
 assert.deepEqual(saved.investigation,s.investigation);assert.deepEqual(saved.evidence,s.evidence);
 assert.equal(t.concluded,s.concluded);return saved;
}
async function run(){
 validateEnvironment(process.env);
 const temp=fs.realpathSync(process.env.RUNNER_TEMP),root=fs.realpathSync(path.join(__dirname,'..'));
 const out=path.join(temp,'ordertruth-ai-one-step'),pub=path.join(out,'public'),priv=path.join(temp,'ordertruth-ai-private');
 assert(!fs.existsSync(out)&&!fs.existsSync(priv));fs.mkdirSync(pub,{recursive:true});
 const report={schemaVersion:1,stage:'autopilot-one-step',caseId:CASE,status:'RUNNING',phase:'preflight',failedPhase:null,
  postAdmitted:false,postOutcome:'NOT_SENT',responseClass:null,aiRequestCap:1,providerRequestCount:null,unavailableReason:null,privateCleanup:'NOT_REACHED'};
 const persist=()=>{const file=path.join(pub,'failure-report.json'),tmp=file+'.tmp',fd=fs.openSync(tmp,'w',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(report,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);};
 const phases=['preflight','session-validation','browser-launch','initial-case-read','ai-preflight','control-check','await-ai','ai-validation','ai-hold','ai-reload','case-validation','browser-close','video-save','encode','probe','clock-check','full-decode','complete'];
 const diag={phase(p){assert(phases.includes(p));report.phase=p;persist();},fail(){report.failedPhase??=report.phase;report.status='FAILED';persist();}};
 let browser,context,video,scenario,trace,session,step,policy,baseline,epoch,finished,recordingReady=false,info,postTask;
 const now=()=>Math.max(0,(Date.now()-epoch)/1000);
 const wait=async fn=>{const end=Date.now()+90000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,250));}throw Error('BOUNDED_WAIT_FAILED');};
 function command(tool,args){const r=spawnSync(tool,args,{encoding:'utf8',windowsHide:true,timeout:90000,maxBuffer:4*1024*1024});assert.equal(r.status,0,'MEDIA_COMMAND_FAILED');return r.stdout;}
 try{
  persist();const pins=JSON.parse(fs.readFileSync(path.join(root,'tool-pins.json'),'utf8'));
  assert.equal(process.version,'v'+pins.node);assert.equal(require('playwright/package.json').version,pins.playwright);
  const {chromium}=require('playwright');assert(fs.realpathSync(chromium.executablePath()).startsWith(fs.realpathSync(process.env.PLAYWRIGHT_BROWSERS_PATH)+path.sep));
  for(const key of ['FFMPEG_PATH','FFPROBE_PATH'])assert(process.env[key]&&fs.statSync(process.env[key]).isFile());
  diag.phase('session-validation');const encoded=process.env.ORDERTRUTH_GUEST_SESSION_B64;delete process.env.ORDERTRUTH_GUEST_SESSION_B64;
  assert(encoded&&encoded.length<2000000);const state=JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));validateSession(state);
  fs.mkdirSync(priv,{mode:0o700});diag.phase('browser-launch');browser=await chromium.launch({headless:true,chromiumSandbox:true});assert.equal(browser.version(),pins.chromium);
  context=await browser.newContext({storageState:state,viewport:{width:1920,height:1080},deviceScaleFactor:1,recordVideo:{dir:priv,size:{width:1920,height:1080}},serviceWorkers:'block'});
  await context.routeWebSocket('**/*',ws=>ws.close());
  await context.route('**/*',async route=>{
   const req=route.request();let body;try{if(req.method()==='POST')body=req.postDataJSON();}catch{return route.abort();}
   const guard=policy??makePolicy('not-armed');if(!guard.allow(req.url(),req.method(),body,scenario))return route.abort();
   if(req.method()==='POST'){
    try{report.postAdmitted=true;report.postOutcome='UNKNOWN';persist();}catch{return route.abort();}
   }
   return route.continue();
  });
  const page=await context.newPage();epoch=Date.now();video=page.video();
  page.on('response',response=>{
   const req=response.request(),u=new URL(response.url());if(u.origin!==ORIGIN)return;
   if(req.method()==='POST'&&u.pathname===BASE+'/autopilot'){
    postTask=(async()=>{report.responseClass=Math.floor(response.status()/100)+'xx';report.postOutcome=response.ok()?'HTTP_SUCCESS':'HTTP_FAILURE';persist();
     if(response.ok())step=await response.json();})();postTask.catch(()=>{});return;
   }
   if(req.method()!=='GET'||!response.ok())return;
   const task=(async()=>{if(u.pathname===BASE)scenario=await response.json();else if(u.pathname===BASE+'/autopilot/trace')trace=await response.json();else if(u.pathname==='/api/session')session=await response.json();})();task.catch(()=>{});
  });
  diag.phase('initial-case-read');await page.goto(ORIGIN+'/?run='+CASE,{waitUntil:'domcontentloaded',timeout:60000});
  await wait(()=>scenario&&trace&&session);assert.equal(session.authenticated,true);baseline=unchangedIdentity(scenario);
  diag.phase('ai-preflight');assert.equal(trace.policy,'merchant-agent-v1');assert.deepEqual(trace.steps,[]);assert.equal(trace.concluded,false);
  // Re-read immediately before arming the one admitted POST. No plan is created or renewed.
  scenario=null;trace=null;await page.reload({waitUntil:'domcontentloaded',timeout:60000});await wait(()=>scenario&&trace);
  assert.equal(unchangedIdentity(scenario),baseline);assert.deepEqual(trace.steps,[]);assert.equal(trace.concluded,false);
  policy=makePolicy(baseline);diag.phase('control-check');const button=page.getByRole('button',{name:'Investigate with Autopilot',exact:true});
  assert.equal(await button.count(),1);assert(await button.isEnabled());await button.scrollIntoViewIfNeeded();await page.waitForTimeout(3000);
  policy.arm();diag.phase('await-ai');await button.click();await wait(()=>step);await postTask;
  diag.phase('ai-validation');
  if(step.status==='UNAVAILABLE'){
   const reasons=['AI_NOT_CONFIGURED','BUDGET_DISABLED','APP_DAILY_BUDGET','SESSION_DAILY_BUDGET','NETWORK_DAILY_BUDGET','APP_REQUEST_SPACING','AI_BUSY','PROVIDER_CIRCUIT_OPEN','QUOTA_OR_RATE_LIMIT','PROVIDER_UNAVAILABLE','PROVIDER_REJECTED','TIMEOUT','NETWORK','INVALID_JSON','INVALID_SCHEMA','AI_EGRESS_REJECTED'];
   report.unavailableReason=reasons.includes(step.reason)?step.reason:'UNAVAILABLE_OTHER';persist();
  }
  validateFresh(step);assert(policy.used);report.providerRequestCount=1;report.postOutcome='STATE_OBSERVED';persist();
  await page.locator('#autopilot-trace').scrollIntoViewIfNeeded();diag.phase('ai-hold');const start=now();await page.waitForTimeout(18000);
  diag.phase('ai-reload');scenario=null;trace=null;await page.reload({waitUntil:'domcontentloaded',timeout:60000});await wait(()=>scenario&&trace);
  validatePersisted(trace,step);diag.phase('case-validation');assert.equal(unchangedIdentity(scenario),baseline);
  await page.locator('#autopilot-trace').scrollIntoViewIfNeeded();const reopenedStart=now();await page.waitForTimeout(55000);const end=now();
  info={schemaVersion:1,stage:'autopilot-one-step',caseId:CASE,complete:false,aiRequestCap:1,providerRequestCount:1,
   providerRequestCountBasis:'One admitted application POST and fresh result; one-request/no-retry backend source contract, not provider transport metering',
   aiResponses:[{status:'success',freshModelExecution:true,schemaValidated:true,evaluationOnly:false,model:MODEL,snapshotSha256:step.snapshotSha256,
    generatedAt:step.generatedAt,usage:{promptTokens:step.usage.promptTokens,outputTokens:step.usage.outputTokens,totalTokens:step.usage.totalTokens},evidenceIds:[...new Set(step.investigation.hypotheses.flatMap(h=>h.evidenceIds))],
    selectedDiagnostic:step.investigation.nextDiagnostic,concluded:step.concluded,persistedAfterReload:true}],
   events:[{type:'ai-investigation',caseId:CASE,start,end,status:'success',validRecordedInvestigation:true,providerRequestCount:1,
    schemaValidated:true,evaluationOnly:false,freshModelExecution:true,model:MODEL,snapshotSha256:step.snapshotSha256,persistedAfterReload:true}],
   shots:{S06:[[reopenedStart,reopenedStart+13]],S07:[[reopenedStart+13,reopenedStart+37]],S08:[[reopenedStart+37,reopenedStart+49]]},merchantStateUnchanged:true,blockedAdditionalPosts:policy.blockedPosts};
  finished=now();recordingReady=true;
 }catch{diag.fail();throw Error('AI_CAPTURE_STOPPED');}
 finally{
  try{
   const raw=path.join(priv,'capture.webm');
   await finalizeRecording({context,browser,video,rawPath:raw,shouldSave:recordingReady},diag);context=null;browser=null;
   if(recordingReady){
    const mp4=path.join(pub,'autopilot-one-step.mp4');diag.phase('encode');
    command(process.env.FFMPEG_PATH,['-v','error','-xerror','-threads','1','-i',raw,'-vf','fps=30,scale=1920:1080,setsar=1','-an','-c:v','libx264','-preset','ultrafast','-crf','20','-threads','1','-filter_threads','1','-pix_fmt','yuv420p','-movflags','+faststart','-n',mp4]);
    diag.phase('probe');const meta=JSON.parse(command(process.env.FFPROBE_PATH,['-v','error','-count_frames','-show_streams','-show_format','-of','json',mp4]));
    const v=meta.streams.find(s=>s.codec_type==='video');assert(v.codec_name==='h264'&&v.width===1920&&v.height===1080&&v.avg_frame_rate==='30/1'&&Number(v.nb_read_frames)>0);
    diag.phase('clock-check');const duration=Number(meta.format.duration),offset=duration-finished;assert(Number.isFinite(duration)&&duration>0&&Math.abs(offset)<2);
    for(const event of info.events){event.start=Math.max(0,event.start+offset);event.end=Math.min(duration,event.end+offset);assert(event.end>event.start);}
    for(const ranges of Object.values(info.shots))for(const range of ranges){range[0]=Math.max(0,range[0]+offset);range[1]=Math.min(duration,range[1]+offset);assert(range[1]>range[0]);}
    diag.phase('full-decode');command(process.env.FFMPEG_PATH,['-v','error','-xerror','-threads','1','-i',mp4,'-f','null','-']);
    info.sourceSha256=crypto.createHash('sha256').update(fs.readFileSync(mp4)).digest('hex');info.recordingMp4='autopilot-one-step.mp4';
    info.mp4Verified={codec:'h264',width:1920,height:1080,fps:30,duration,frames:Number(v.nb_read_frames),fullDecode:true};info.complete=true;
    fs.writeFileSync(path.join(pub,'capture.json'),JSON.stringify(info,null,2));
   }
  }catch{diag.fail();throw Error('AI_MEDIA_STOPPED');}
  finally{try{fs.rmSync(priv,{recursive:true,force:true});report.privateCleanup='SUCCEEDED';persist();}catch{report.privateCleanup='FAILED';diag.fail();throw Error('AI_CLEANUP_STOPPED');}}
 }
 report.status='SUCCEEDED';diag.phase('complete');console.log('PASS: one fresh AI step persisted and recorded; no repair actions.');
}
module.exports={makePolicy,validateEnvironment,validateFresh,validatePersisted,unchangedIdentity,MODEL};
if(require.main===module)run().catch(()=>{console.error('AI_CAPTURE_STOPPED: sanitized report only; reconcile read-only before any further action. No retry.');process.exitCode=1;});
