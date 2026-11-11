// Adapted from the working host landing recorder. Fresh public page, no clicks or credentials.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
const pins=require('../tool-pins.json');
const publicHeading=/^A successful payment doesn['\u2019]t guarantee the merchant order is correct\.$/;
class CaptureError extends Error {
  constructor(category,check){super(category);this.category=category;this.check=check;}
}
function fail(category,check){throw new CaptureError(category,check);}
function observeSession(page){
  let settled=false,resolveResult;
  const result=new Promise(resolve=>{resolveResult=resolve;});
  function settle(value){if(!settled){settled=true;resolveResult(value);}}
  const matches=request=>request.url()==='https://order-truth.vercel.app/api/session' && request.method()==='GET';
  const onResponse=async response=>{
    if(!matches(response.request()))return;
    const status=response.status();
    if(!response.ok()){settle({category:'session_http_status',status,state:'unavailable'});return;}
    try{
      const session=await response.json(); // Inspect one boolean only; never retain or log session data.
      if(typeof session?.authenticated!=='boolean')settle({category:'session_invalid',status,state:'unconfirmed'});
      else settle({category:session.authenticated?'session_authenticated':null,status,state:session.authenticated?'authenticated':'signed-out'});
    }catch{settle({category:'session_invalid',status,state:'unconfirmed'});}
  };
  const onFailure=request=>{if(matches(request))settle({category:'session_network',status:null,state:'unavailable'});};
  page.on('response',onResponse);page.on('requestfailed',onFailure);
  return {
    async wait(timeoutMs){
      let timer;
      try{return await Promise.race([result,new Promise(resolve=>{
        timer=setTimeout(()=>resolve({category:'session_timeout',status:null,state:'unconfirmed'}),timeoutMs);
      })]);}finally{clearTimeout(timer);}
    },
    dispose(){page.off('response',onResponse);page.off('requestfailed',onFailure);}
  };
}
async function preparePublicPage(page,diagnostics,setPhase,{sessionTimeoutMs=120000}={}){
  // Observe before navigation, but start the separate cold-start wait after the public UI loads.
  const session=observeSession(page);
  try{
    setPhase('public-navigation');
    let response;
    try{response=await page.goto('https://order-truth.vercel.app/',{waitUntil:'domcontentloaded',timeout:60000});}
    catch(error){fail(error.name==='TimeoutError'?'navigation_timeout':'navigation_failure','document');}
    diagnostics.navigationHttpStatus=response?.status()??null;
    if(diagnostics.navigationHttpStatus!==200)fail('navigation_http_status','document');
    if(page.url()!=='https://order-truth.vercel.app/')fail('navigation_failure','unexpected-url');
    if(!/OrderTruth/i.test(await page.title()))fail('ui_missing','page-title');
    setPhase('public-ui');
    try{await page.getByRole('heading',{name:publicHeading}).waitFor({state:'visible',timeout:15000});}
    catch{fail('ui_missing','landing-heading');}
    diagnostics.publicUiVisible=true;
    setPhase('backend-session');
    const state=await session.wait(sessionTimeoutMs);
    diagnostics.sessionHttpStatus=state.status;diagnostics.sessionState=state.state;
    if(state.category)fail(state.category,'signed-out-session');
    setPhase('ready-ui');
    try{await page.getByText('Connection confirmed. Inspect a payment outcome to start your private session.',{exact:true}).waitFor({state:'visible',timeout:15000});}
    catch{fail('ui_missing','ready-notice');}
    if(!/PayPal/i.test(await page.locator('body').innerText()))fail('ui_missing','paypal-context');
    diagnostics.readyUiVisible=true;
  }finally{session.dispose();}
}
function safeDiagnostic(error,phase,diagnostics,browserFailed){
  const category=browserFailed?'browser_failure':error instanceof CaptureError?error.category:
    phase.startsWith('browser')?'browser_failure':phase==='encode'?'encoding_failure':
    phase==='verification'?'verification_failure':'environment_failure';
  return {category,check:error instanceof CaptureError?error.check:null,
    navigationHttpStatus:diagnostics.navigationHttpStatus,sessionHttpStatus:diagnostics.sessionHttpStatus,
    sessionState:diagnostics.sessionState,publicUiVisible:diagnostics.publicUiVisible,readyUiVisible:diagnostics.readyUiVisible};
}
function allowed(url,method){
  try {const u=new URL(url);return u.origin==='https://order-truth.vercel.app' &&
    (!/^\/api(?:\/|$)/.test(u.pathname) || (u.pathname==='/api/session' && !u.search)) &&
    ['GET','HEAD'].includes(method);}catch{return false;}
}
if(require.main!==module){module.exports={allowed,publicHeading,observeSession,preparePublicPage,safeDiagnostic,CaptureError};}
else if(process.argv.includes('--policy-self-test')){
  assert(allowed('https://order-truth.vercel.app/','GET'));
  assert(allowed('https://order-truth.vercel.app/api/session','GET'));
  for(const [url,method] of [['https://order-truth.vercel.app/api/auth/sign-in/anonymous','POST'],
    ['https://order-truth.vercel.app/api/scenarios','GET'],['https://ordertruth.onrender.com/api/scenarios','POST'],
    ['https://api-m.sandbox.paypal.com/','GET'],['https://order-truth.vercel.app.evil.example/','GET'],
    ['https://order-truth.vercel.app/','PUT']]) assert(!allowed(url,method));
  console.log('Read-only route policy PASS');
}else{
  let browser,context,phase='environment',browserFailed=false,closingBrowser=false;
  const diagnostics={navigationHttpStatus:null,sessionHttpStatus:null,sessionState:'unconfirmed',publicUiVisible:false,readyUiVisible:false};
  const run=path.resolve(process.env.STAGE1_OUTPUT||path.join(ROOT,'footage/stage1'));
  const pub=path.join(run,'public'),priv=path.join(run,'private');
  function tool(exe,args){
    const r=spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:2*1024*1024});
    assert.equal(r.status,0,'Tool failed');return r.stdout;
  }
  async function main(){
    assert(!fs.existsSync(run),'Refusing to overwrite existing footage');
    fs.mkdirSync(pub,{recursive:true});fs.mkdirSync(priv,{recursive:true});
    const ff=process.env.FFMPEG_PATH,fp=process.env.FFPROBE_PATH;
    assert(ff&&fp&&fs.existsSync(ff)&&fs.existsSync(fp));
    assert.equal(process.versions.node,pins.node);
    assert.equal(require('playwright/package.json').version,pins.playwright);
    for(const exe of [ff,fp]) assert(tool(exe,['-version']).split('\n')[0].includes('version '+pins.ffmpeg+'-'));
    const {chromium}=require('playwright');
    phase='browser-launch';
    browser=await chromium.launch({headless:true,chromiumSandbox:true,timeout:30000});
    browser.on('disconnected',()=>{if(!closingBrowser)browserFailed=true;});
    assert.equal(browser.version(),pins.chromium);
    context=await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:1,
      serviceWorkers:'block',permissions:[],acceptDownloads:false,
      recordVideo:{dir:priv,size:{width:1920,height:1080}}});
    let blocked=0,writeAttempts=0;
    await context.route('**/*',route=>{
      const req=route.request();if(allowed(req.url(),req.method())) return route.continue();
      blocked++;if(!['GET','HEAD'].includes(req.method()))writeAttempts++;
      return route.abort();
    });
    await context.routeWebSocket('**/*',socket=>socket.close());
    const page=await context.newPage();
    page.on('crash',()=>{browserFailed=true;});
    await preparePublicPage(page,diagnostics,value=>{phase=value;});
    phase='recording';
    await page.waitForTimeout(8000);
    if(browserFailed)fail('browser_failure','recording');
    if(!await page.getByText('Connection confirmed. Inspect a payment outcome to start your private session.',{exact:true}).isVisible()){
      diagnostics.readyUiVisible=false;fail('ui_missing','ready-notice');
    }
    await page.screenshot({path:path.join(pub,'landing.png')});
    assert.equal(writeAttempts,0,'Unexpected mutation attempt');
    const video=page.video();
    phase='browser-close';
    closingBrowser=true;
    await context.close();context=null;
    const webm=path.join(pub,'landing.webm');await video.saveAs(webm);
    await browser.close();browser=null;
    phase='encode';
    const mp4=path.join(pub,'landing.mp4'),smoke=path.join(pub,'smoke-5s.mp4');
    const encoding=['-an','-c:v','libx264','-threads','1','-filter_threads','1','-preset','veryfast',
      '-tune','zerolatency','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart','-n'];
    tool(ff,['-v','error','-xerror','-threads','1','-sseof','-7','-i',webm,'-t','7',
      '-vf','tpad=stop_mode=clone:stop_duration=1,fps=30,scale=1920:1080:flags=lanczos',...encoding,mp4]);
    tool(ff,['-v','error','-xerror','-threads','1','-i',mp4,'-t','5','-vf','fps=30',...encoding,smoke]);
    phase='verification';
    const reports=[];
    for(const [file,seconds,frames] of [[mp4,7,210],[smoke,5,150]]){
      const m=JSON.parse(tool(fp,['-v','error','-count_frames','-show_streams','-show_format','-of','json',file]));
      assert.equal(m.streams.length,1);const s=m.streams[0];
      assert.equal(s.codec_name,'h264');assert.equal(s.width,1920);assert.equal(s.height,1080);
      assert.equal(s.avg_frame_rate,'30/1');assert.equal(s.pix_fmt,'yuv420p');assert.equal(Number(s.nb_read_frames),frames);
      assert(Math.abs(Number(m.format.duration)-seconds)<0.05);
      tool(ff,['-v','error','-xerror','-threads','1','-i',file,'-f','null','-']);
      reports.push({file:path.basename(file),codec:s.codec_name,width:s.width,height:s.height,fps:30,frames,
        duration:Number(m.format.duration),sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex'),decoded:true});
    }
    const names=['landing.webm','landing.mp4','smoke-5s.mp4','landing.png'];
    let bytes=0;for(const name of names)bytes+=fs.statSync(path.join(pub,name)).size;
    assert(bytes<25*1024*1024,'Artifact size budget exceeded');
    fs.writeFileSync(path.join(pub,'qc-public.json'),JSON.stringify({ok:true,stage:1,
      source:'https://order-truth.vercel.app/',readOnly:true,mutatingRequests:writeAttempts,
      sessionReady:true,diagnostics,
      blockedRequests:blocked,browserClosed:true,node:pins.node,playwright:pins.playwright,
      chromium:pins.chromium,ffmpeg:pins.ffmpeg,artifactBytes:bytes,reports},null,2));
    console.log('Stage 1 PASS: genuine landing MP4 and five-second smoke verified.');
  }
  main().catch(error=>{
    // This fixed-schema report intentionally excludes exception messages and browser diagnostics.
    if(fs.existsSync(pub) && !fs.existsSync(path.join(pub,'qc-public.json')))
      fs.writeFileSync(path.join(pub,'qc-public.json'),JSON.stringify({ok:false,stage:1,failedAt:phase,sessionReady:false,
        diagnostic:safeDiagnostic(error,phase,diagnostics,browserFailed),automaticReplay:false},null,2));
    console.error('Stage 1 failed at '+phase+' ('+safeDiagnostic(error,phase,diagnostics,browserFailed).category+'). No protected actions or automatic retries.');process.exitCode=1;
  })
    .finally(async()=>{
      try{closingBrowser=true;if(context)await context.close();if(browser)await browser.close();}
      catch{console.error('Browser cleanup failed');process.exitCode=1;}
    });
}
