// Ordinary-host entry point. No application source edits, provider APIs or credential access.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const readline=require('node:readline/promises');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||'');
if(process.env.CI && !process.argv.includes('--policy-self-test')) throw Error('Protected CI stages are not authorized');
const {chromium}=require('playwright');
assert(out.startsWith(root+path.sep),'Output must remain in video workspace');
const rl=readline.createInterface({input:process.stdin,output:process.stdout});
const info={complete:false,shots:{},approvals:[],networkWrites:[],aiResponses:[]};
let browser,context,page,epoch,scenario,receipt,runId,mode='read',budget=0,aiCount=0,aiStopped=false;
const pending=new Set(),used=new Set();
const now=()=>Math.max(0,(Date.now()-epoch)/1000);
async function question(text){return rl.question(text,{signal:AbortSignal.timeout(180000)});}
async function permit(phrase,message){console.log('\n'+message);assert.equal((await question('Type '+phrase+' to authorize, or anything else to stop (3 minute limit): ')).trim(),phrase,'Owner declined; no further actions');info.approvals.push({scope:phrase,at:new Date().toISOString()});}
async function hold(seconds=3){const start=now();await page.waitForTimeout(seconds*1000);return [start,now()];}
async function show(selector){const loc=page.locator(selector);assert.equal(await loc.count(),1,'Expected one visible panel: '+selector);await loc.scrollIntoViewIfNeeded();await page.waitForTimeout(500);}
async function click(name){const loc=page.getByRole('button',{name,exact:true});assert.equal(await loc.count(),1,'UI control changed: '+name);assert(await loc.isVisible()&&await loc.isEnabled(),'Control unavailable: '+name);await loc.click();}
async function waitUntil(check,label,ms=95000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await page.waitForTimeout(400);}throw Error('Timed out: '+label+'. No automatic POST replay.');}
function recordResponse(response){const p=(async()=>{
 const u=new URL(response.url());if(!['https://order-truth.vercel.app','https://ordertruth.onrender.com'].includes(u.origin)||!u.pathname.startsWith('/api/'))return;
 if(!response.ok())return;
 let d;try{d=await response.json();}catch{return;}
 if(/^\/api\/scenarios\/[A-Za-z0-9_-]+$/.test(u.pathname)&&d?.run?.id){scenario=d;runId=d.run.id;}
 if(/\/receipts\//.test(u.pathname)&&d?.receipt)receipt=d;
 if(u.pathname.endsWith('/autopilot')){
  info.aiResponses.push({at:now(),status:d.status,freshModelExecution:d.freshModelExecution,concluded:d.concluded,model:d.model,hasDecision:!!d.investigation});
  if(d.status==='UNAVAILABLE')aiStopped=true;
 }
 })();pending.add(p);p.finally(()=>pending.delete(p));}
function active(){return scenario?.orders?.filter(x=>x.effective_status==='placed').length;}
function validReceipt(r){return r?.verifiedCurrent===true&&r.receipt?.outcome==='SUCCEEDED'&&r.current?.activeOrders===1&&r.current.matchingKeeper===1&&r.current.providerUnchanged===true&&r.receipt.provider_before_sha256===r.receipt.provider_after_sha256;}
function authorizeRequest(url,method,body){
 const u=new URL(url),p=u.pathname;
 if(!['https://order-truth.vercel.app','https://ordertruth.onrender.com'].includes(u.origin))return false;
 if(['GET','HEAD'].includes(method))return true;
 if(method!=='POST'||!body||typeof body!=='object'||Array.isArray(body))return false;
 const empty=Object.keys(body).length===0,base=runId?'/api/scenarios/'+encodeURIComponent(runId):null;
 let allowed=false;
 if(mode==='case'&&p==='/api/auth/sign-in/anonymous'&&empty&&!used.has(p)){allowed=true;used.add(p);}
 if(mode==='case'&&p==='/api/scenarios'&&!used.has(p)&&Object.keys(body).length===1&&typeof body.operationId==='string'&&/^[a-f0-9-]{36}$/i.test(body.operationId)){allowed=true;used.add(p);}
 for(const [phase,action] of [['duplicate','duplicate'],['detect','check'],['plan','plan']])
  if(base&&mode===phase&&p===base+'/'+action&&empty&&!used.has(p)){allowed=true;used.add(p);}
 if(base&&mode==='ai'&&p===base+'/autopilot'&&empty&&!aiStopped&&aiCount<budget){allowed=true;aiCount++;}
 if(base&&['approve','execute'].includes(mode)&&p===base+'/'+mode&&!used.has(p)){
  const plan=info.reviewedPlan,keys=Object.keys(body).sort().join(',');
  allowed=!!plan&&body.planId===plan.id&&Date.parse(plan.expiresAt)>Date.now()&&
   (mode==='approve'?keys==='planId,planSha256'&&body.planSha256===plan.sha256:keys==='planId');
  if(allowed)used.add(p);
 }
 return allowed;
}
if(process.argv.includes('--policy-self-test')){
 const front='https://order-truth.vercel.app',base=front+'/api/scenarios/test-run';runId='test-run';
 assert(!authorizeRequest('https://api-m.paypal.com/v2/payments','POST',{}));
 assert(!authorizeRequest(front+'/api/scenarios','POST',{operationId:'00000000-0000-0000-0000-000000000000'}));
 mode='case';assert(authorizeRequest(front+'/api/auth/sign-in/anonymous','POST',{}));assert(!authorizeRequest(front+'/api/auth/sign-in/anonymous','POST',{}));
 assert(!authorizeRequest(front+'/api/scenarios','POST',{operationId:'00000000-0000-0000-0000-000000000000',caseKind:'MISSING'}));
 assert(authorizeRequest(front+'/api/scenarios','POST',{operationId:'00000000-0000-0000-0000-000000000000'}));assert(!authorizeRequest(front+'/api/scenarios','POST',{operationId:'00000000-0000-0000-0000-000000000000'}));
 mode='duplicate';assert(authorizeRequest(base+'/duplicate','POST',{}));assert(!authorizeRequest(base+'/duplicate','POST',{}));assert(!authorizeRequest(base+'/execute','POST',{}));
 mode='ai';budget=2;assert(authorizeRequest(base+'/autopilot','POST',{}));assert(authorizeRequest(base+'/autopilot','POST',{}));assert(!authorizeRequest(base+'/autopilot','POST',{}));aiStopped=true;aiCount=0;assert(!authorizeRequest(base+'/autopilot','POST',{}));
 info.reviewedPlan={id:'exact-plan',sha256:'exact-hash',expiresAt:new Date(Date.now()+60000).toISOString()};mode='approve';
 assert(!authorizeRequest(base+'/approve','POST',{planId:'different',planSha256:'exact-hash'}));assert(!authorizeRequest(base+'/approve','POST',{planId:'exact-plan',planSha256:'wrong'}));
 assert(authorizeRequest(base+'/approve','POST',{planId:'exact-plan',planSha256:'exact-hash'}));assert(!authorizeRequest(base+'/approve','POST',{planId:'exact-plan',planSha256:'exact-hash'}));
 mode='execute';info.reviewedPlan.expiresAt=new Date(0).toISOString();assert(!authorizeRequest(base+'/execute','POST',{planId:'exact-plan'}));info.reviewedPlan.expiresAt=new Date(Date.now()+60000).toISOString();assert(authorizeRequest(base+'/execute','POST',{planId:'exact-plan'}));assert(!authorizeRequest(base+'/execute','POST',{planId:'exact-plan'}));
 console.log('POLICY PASS: unapproved/financial writes, changed scopes, retries, quota overflow and stale/wrong repair identities refused. No browser or network started.');rl.close();process.exit(0);
}
(async()=>{
 try{
  fs.mkdirSync(out,{recursive:true});
  if(process.env.CI && !process.argv.includes('--policy-self-test')) throw Error('Protected CI stages are not authorized');
  browser=await chromium.launch({headless:true,chromiumSandbox:true,timeout:30000,args:['--disable-gpu','--renderer-process-limit=1']});
  context=await browser.newContext({viewport:{width:1536,height:864},deviceScaleFactor:1.25,recordVideo:{dir:out,size:{width:1920,height:1080}},serviceWorkers:'block'});
  await context.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url()),p=u.pathname;let body=null;
   if(req.method()==='POST'){try{body=req.postDataJSON();}catch{return route.abort();}}
   const allowed=authorizeRequest(req.url(),req.method(),body);
   if(!allowed){console.log('BLOCKED unapproved request: '+req.method()+' '+p);return route.abort();}
   if(req.method()==='POST')info.networkWrites.push({path:p,at:new Date().toISOString()});return route.continue();
  });
  epoch=Date.now();page=await context.newPage();page.on('response',recordResponse);
  await page.goto('https://order-truth.vercel.app/',{waitUntil:'domcontentloaded',timeout:60000});
  await waitUntil(()=>page.getByRole('button',{name:'Inspect a payment outcome',exact:true}).isEnabled().catch(()=>false),'landing availability');
  info.landing=await hold(4);
  await permit('CREATE ONE CASE','Authorize ONE anonymous guest session and ONE isolated duplicate-scenario case, using existing stored Sandbox evidence. No new payment. No retry on uncertain outcome.');
  mode='case';await click('Inspect a payment outcome');
  await waitUntil(()=>!!scenario?.run?.id,'case readback');mode='read';
  assert.equal(scenario.run.label,'CONTROLLED_MERCHANT_SCENARIO');assert.equal(scenario.paymentReference?.provenance,'PAYPAL_SANDBOX_GET');
  assert.equal(scenario.paymentReference?.recordedCapture?.status,'COMPLETED','No completed genuine stored Sandbox observation');assert.equal(active(),1);
  info.caseId=runId;info.observation={evidenceSeq:scenario.paymentReference.evidenceSeq,observedAt:scenario.paymentReference.observedAt};
  await show('.provenance');info.shots.S04=[await hold(18)];
  await show('.merchant-panel');const initial=await hold(3);
  await permit('INTRODUCE ONE DUPLICATE','Authorize ONE clearly labelled merchant-side duplicate in case '+runId+', followed by deterministic anomaly detection. No PayPal request.');
  mode='duplicate';const dupStart=now();await click('Introduce duplicate');await waitUntil(()=>active()===2,'two active merchant orders');mode='read';const dupResult=await hold(3);
  mode='detect';const detectStart=now();await click('Detect anomaly');await waitUntil(()=>scenario?.latestCheck?.activeOrderCount===2&&scenario.latestCheck.result==='VIOLATED','deterministic duplicate finding');mode='read';
  await show('.merchant-panel');const detected=await hold(4);const cold=await hold(12);
  info.shots.S01=[cold];info.shots.S02=[ [cold[0],cold[0]+7] ];
  info.shots.S05=[initial,[dupStart,Math.min(dupStart+1.5,dupResult[0])],dupResult,[detectStart,Math.min(detectStart+1.5,detected[0])],detected];
  console.log('\nAutopilot may issue several requests from one activation. No free quota is inferred from a button or account plan.');
  const b=Number((await question('Enter your CONFIRMED remaining zero-cost model-request allowance for this recording (1-5), or 0 to stop: ')).trim());
  assert(Number.isInteger(b)&&b>=1&&b<=5,'Confirmed free quota required; no AI request sent');budget=b;
  await permit('RUN AUTOPILOT '+budget,'Authorize one Autopilot activation in this case, capped at '+budget+' HTTP requests within your confirmed free allowance. Stop on unavailable status; no paid fallback, quota bypass or second activation.');
  await show('#autopilot-trace');mode='ai';const aiStart=now();await click('Investigate with Autopilot');
  await waitUntil(async()=>{
   const body=await page.locator('body').innerText();
   return (info.aiResponses.length>0&&(await page.locator('main').getAttribute('aria-busy'))!=='true')&&!(await page.getByRole('button',{name:'Investigate with Autopilot',exact:true}).isEnabled().catch(()=>false))&&
    (body.includes('Investigation complete')||body.includes('Autopilot paused')||body.includes('Continue Autopilot')||aiStopped);
  },'Autopilot settled state',210000);mode='read';
  await Promise.allSettled([...pending]);
  const decisions=info.aiResponses.filter(r=>r.hasDecision&&['FRESH','CACHED'].includes(r.status));
  assert(decisions.length>=2,'Fewer than two genuine recorded model decisions: preserve raw footage; planned AI sequence cannot be asserted');
  assert(decisions.some(r=>r.freshModelExecution===true),'No confirmed fresh model execution in this take');
  await show('#autopilot-trace');const firstTrace=await hold(10);
  info.shots.S06=[[aiStart,Math.min(aiStart+3,firstTrace[0])],firstTrace];
  const rows=page.locator('#autopilot-trace li');assert(await rows.count()>=2,'Two visible recorded model/server steps required');
  await rows.nth(0).scrollIntoViewIfNeeded();const step1=await hold(10);await rows.nth(1).scrollIntoViewIfNeeded();const step2=await hold(14);info.shots.S07=[step1,step2];
  info.paused=!decisions.some(r=>r.concluded===true);await show('#autopilot-trace');info.shots.S08=[await hold(12)];
  await permit('PREPARE EXACT PLAN','Authorize creating ONE merchant-only Keep/Void proposal for this case. This does not approve or execute it.');
  mode='plan';await click('Review exact repair plan');await waitUntil(()=>!!scenario?.latestPlan?.id,'exact proposal readback');mode='read';
  const plan=scenario.latestPlan,voids=JSON.parse(plan.void_order_ids_json);assert.equal(voids.length,1);assert.notEqual(voids[0],plan.keep_order_id);
  info.reviewedPlan={id:plan.id,sha256:plan.plan_sha256,keep:plan.keep_order_id,voids,expiresAt:plan.expires_at};
  await show('.recovery-panel');const detail=page.getByText('Exact plan identity and order changes',{exact:true});if(await detail.count()===1)await detail.click();
  const planHold=await hold(6);await page.screenshot({path:path.join(out,'exact-plan-for-owner.png')});
  console.log('\nACTUAL DISPLAYED PROPOSAL\n'+await page.locator('.recovery-panel').innerText());
  console.log(JSON.stringify(info.reviewedPlan,null,2));
  await permit('REPAIR '+plan.id,'Separate authorization: KEEP '+plan.keep_order_id+'; VOID '+voids.join(', ')+' in the merchant database only. Approve this exact plan, then execute it once. No PayPal write.');
  assert(Date.parse(plan.expires_at)>Date.now()+10000,'Proposal expired/too close to expiry; no approval or execution sent');
  mode='approve';const approveStart=now();await click('Approve this exact merchant-only plan');await waitUntil(()=>scenario?.latestPlan?.id===plan.id&&scenario.latestPlan.approved===true,'approved exact proposal');mode='read';const approvedHold=await hold(3);
  mode='execute';const executeStart=now();await click('Execute approved local repair');await waitUntil(()=>validReceipt(receipt),'verified persisted receipt');mode='read';
  await show('.recovery-panel');const executedHold=await hold(5);info.shots.S09=[planHold,[approveStart,Math.min(approveStart+1.5,approvedHold[0])],approvedHold,[executeStart,Math.min(executeStart+1.5,executedHold[0])],executedHold];
  const receiptId=receipt.receipt.execution_id,receiptBefore=await hold(4),reloadStart=now();receipt=null;
  await page.reload({waitUntil:'domcontentloaded',timeout:60000});await waitUntil(()=>validReceipt(receipt),'same receipt after refresh');assert.equal(receipt.receipt.execution_id,receiptId,'Receipt identity changed');assert.equal(scenario.run.id,runId);
  await show('.recovery-panel');const restored=await hold(12);info.shots.S10=[receiptBefore,[reloadStart,Math.min(reloadStart+2,restored[0])],restored];
  info.receipt={id:receiptId,verifiedCurrent:true,activeOrders:1,matchingKeeper:1,providerUnchanged:true};info.complete=true;
 }catch(e){info.error=e.message;console.error('\nCAPTURE STOPPED: '+e.message);process.exitCode=1;}
 finally{
  mode='read';rl.close();if(page){info.captureEnd=now();const video=page.video();if(context)await context.close().catch(()=>{});context=null;if(video){info.webm=path.join(out,'product-raw.webm');await video.saveAs(info.webm).catch(e=>{info.complete=false;info.error=e.message;});}}
  if(context)await context.close().catch(()=>{});
  if(browser){try{await browser.close();info.browserClosed=true;}catch(e){info.browserClosed=false;info.complete=false;info.error='Recording browser cleanup failed: '+e.message;process.exitCode=1;}}
  fs.writeFileSync(path.join(out,'capture.json'),JSON.stringify(info,null,2));
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
