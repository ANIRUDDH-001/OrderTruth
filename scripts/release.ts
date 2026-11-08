import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {basename,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {verifyPublicRelease} from './public-release.ts';
import {requireGreenChecks,requireReviewedDatabaseChanges,requireReleaseServiceConfiguration,releaseStartCommand} from './release-policy.ts';
import {inspectReleaseDatabase} from './release-database.ts';
import {waitForReleaseReadiness} from './release-readiness.ts';

/** V9 code-only release. Uses existing local gh/Render logins; never creates credentials.
 * node --import tsx scripts/release.ts SHA --database-env PRIVATE_ENV [--render PATH] [--plan]
 * Only this operator should advance main. No database migrations, backups or product writes.
 */
const args=process.argv.slice(2),sha=args[0];
const option=(name:string)=>args[args.indexOf(name)+1];
if(!sha||!/^[a-f0-9]{40}$/.test(sha))throw new Error('Full qualified SHA required');
const envFile=args.includes('--database-env')?option('--database-env'):'.env';
const render=args.includes('--render')?option('--render'):(existsSync('.work/tools/render-2.36.0/render.exe')?resolve('.work/tools/render-2.36.0/render.exe'):'render');
if(!envFile||!render)throw new Error('Missing option value');
const service='srv-dbccdgjl550s73d37ao0',workspace='tea-d6qpqrpaae7s739l8qu0',repo='ANIRUDDH-001/OrderTruth',origin='https://order-truth.vercel.app',direct='https://ordertruth.onrender.com';
const childEnv:NodeJS.ProcessEnv={};for(const key of ['SystemRoot','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','HOME','PATH','PATHEXT'])if(process.env[key])childEnv[key]=process.env[key];
childEnv.DO_NOT_TRACK='1';childEnv.RENDER_WORKSPACE=workspace;
const exec=promisify(execFile);
const deadline=Date.now()+20*60_000;let recovering=false;
async function run(command:string,argv:string[]){if(started&&!recovering&&Date.now()>deadline)throw new Error('Maintenance window exceeded');try{return(await exec(command,argv,{env:childEnv,timeout:30000,maxBuffer:2_000_000,windowsHide:true})).stdout.trim();}catch{throw new Error(`Release command failed: ${basename(command)} (credentials and raw stderr withheld)`);}}
const json=async(command:string,argv:string[])=>JSON.parse(await run(command,argv));
const rjson=(argv:string[])=>json(render,[...argv,'--output','json']);
const main=async()=>((await run('git',['ls-remote','origin','refs/heads/main'])).split(/\s+/)[0]);
async function green(){requireGreenChecks((await json('gh',['api',`repos/${repo}/commits/${sha}/check-runs?per_page=100`])).check_runs);}
async function waitGreen(){for(let i=0;i<40;i++){try{await green();return;}catch(error){if(!(error instanceof Error)||!error.message.startsWith('Pending CI gate:'))throw error;await delay(10000);}}throw new Error('CI timeout');}
async function read(url:string){const response=await fetch(url,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error(`Release read failed HTTP${response.status}`);return response.json();}
async function modes(){return read(direct+'/api/release/status');}
async function live(){const deployments=await rjson(['deploys','list',service]);const d=deployments.find((d:{status:string})=>d.status==='live');if(!d?.commit?.id)throw new Error('No source-identified live Render deploy');return d;}
async function deploy(source:string){
 const deployment=await rjson(['deploys','create',service,'--commit',source,'--confirm']);
 if(deployment.commit?.id!==source||!deployment.id)throw new Error('Render deploy identity mismatch');
 console.log(JSON.stringify({stage:'deploy',deployment:deployment.id,sha:source}));
 for(let i=0;i<60;i++){const all=await rjson(['deploys','list',service]);if(all[0]?.id!==deployment.id)throw new Error('Superseding Render deployment');const d=all.find((d:{id:string})=>d.id===deployment.id);if(d?.status==='live')return d;if(['build_failed','update_failed','canceled','deactivated'].includes(d?.status))throw new Error('Render deployment failed');await delay(10000);}
 throw new Error('Render deployment timeout');
}
async function setMode(mode:'hold'|'normal',source:string){
 await rjson(['services','update',service,'--auto-deploy=false','--health-check-path','/api/health','--start-command',releaseStartCommand(mode,args.includes('--qualify-groq')),'--confirm']);
 return deploy(source);
}
async function drain(source:string){
 const oldInstances=await rjson(['services','instances',service]);const oldIds=new Set(oldInstances.map((i:{id:string})=>i.id));const deployment=await setMode('hold',source);
 // 60s routing transition + conservative documented maximum300s shutdown delay.
 // Inventory disappearance alone never grants an early writer-retirement pass.
 const notBefore=Date.now()+360_000;console.log(JSON.stringify({stage:'retirement',notBefore:new Date(notBefore).toISOString(),deployment:deployment.id}));
 while(Date.now()<notBefore)await delay(Math.min(10000,notBefore-Date.now()));
 for(let i=0;i<10;i++){const instances=await rjson(['services','instances',service]);if(!instances.some((i:{id:string})=>oldIds.has(i.id))){const status=await modes();if(status.maintenance&&status.quiescent)return deployment;}await delay(10000);}
 throw new Error('Old instance retirement unverified');
}
async function finish(holdDeployment:string,normalDeployment:string,resumed=false){
 await waitForReleaseReadiness([direct,origin],sha!);
 if(await main()!==sha||(await live()).id!==normalDeployment)throw new Error('Release superseded');
 const frontend=await verifyPublicRelease(origin,sha!);mkdirSync('.work/releases',{recursive:true});
 const record={at:new Date().toISOString(),sourceSha:sha,holdDeployment,normalDeployment,frontend,
  ...(resumed?{preservationChecks:['original closed target-HOLD fingerprint gate passed before the first NORMAL attempt; see original cutover log','resume same-source HOLD fingerprints stable'],originalCutoverLog:'.work/runs/phase7/release-cutover.log'}:{paymentEvidenceAndReceiptsPreserved:true}),
  migration:false,providerCalls:0,modelCalls:0,aiMode:args.includes('--qualify-groq')?'groq-one-reservation-qualification':'disabled',resumedFromVerifiedHold:resumed};
 writeFileSync(`.work/releases/${sha}-${record.at.replace(/[:.]/g,'-')}.json`,JSON.stringify(record,null,2),{flag:'wx'});
 console.log(JSON.stringify({stage:'PASS',...record}));
}
let fallback:string|undefined,started=false;
try{
 const remote=await run('git',['remote','get-url','origin']);if(!['https://github.com/ANIRUDDH-001/OrderTruth.git','git@github.com:ANIRUDDH-001/OrderTruth.git'].includes(remote))throw new Error('Wrong repository');
 if(await run('git',['status','--porcelain','--untracked-files=no']))throw new Error('Tracked worktree must be clean');
 await green();await run('git',['merge-base','--is-ancestor',(await main())!,sha]);
 const services=await rjson(['services']);const config=services.find((s:{service:{id:string}})=>s.service.id===service)?.service;
 requireReleaseServiceConfiguration(config);
 const health=await read(direct+'/api/health');if(health.schemaVersion!==9)throw new Error('Only existing V9 supported');
 const current=await live();fallback=current.commit.id;
 const dbChanges=await run('git',['diff','--name-only',fallback!,sha,'--','src/db']);
 const reviewedChanges=[];
 for(const path of dbChanges.split(/\r?\n/).filter(Boolean))reviewedChanges.push({path,before:await run('git',['rev-parse',`${fallback}:${path}`]),after:await run('git',['rev-parse',`${sha}:${path}`])});
 requireReviewedDatabaseChanges(reviewedChanges);
 console.log(JSON.stringify({stage:'plan',target:sha,current:fallback,main:await main(),schema:9,sequence:['HOLD/drain','private SQL gate','qualified main fast-forward','public frontend verification','exact backend HOLD','preservation gate','NORMAL','readiness/provenance']}));
 if(args.includes('--plan'))process.exit(0);
 if(args.includes('--resume-normal')){
  // Same qualified frontend/backend only. The latest HOLD must have outlived
  // routing transition + maximum shutdown; no writer retirement is shortened.
  const status=await modes(),finished=Date.parse(current.finishedAt??'');
  if(fallback!==sha||await main()!==sha||!status.maintenance||!status.quiescent||status.activeRequests!==0||!Number.isFinite(finished)||Date.now()<finished+360_000)throw new Error('Verified retired same-source HOLD required for resume');
  await verifyPublicRelease(origin,sha);
  const before=await inspectReleaseDatabase(envFile),again=await inspectReleaseDatabase(envFile);
  if(JSON.stringify(before.fingerprints)!==JSON.stringify(again.fingerprints))throw new Error('Stored evidence changed while held');
  mkdirSync('.work/releases',{recursive:true});writeFileSync(`.work/releases/${sha}-resume-baseline-${Date.now()}.json`,JSON.stringify({sourceSha:sha,holdDeployment:current.id,at:new Date().toISOString(),...before},null,2),{flag:'wx'});
  started=true;await waitGreen();
  const latestStatus=await modes();
  if(await main()!==sha||(await live()).id!==current.id||!latestStatus.maintenance||!latestStatus.quiescent||latestStatus.activeRequests!==0)throw new Error('Verified HOLD superseded before resume');
  const active=await setMode('normal',sha);
  await finish(current.id,active.id,true);process.exit(0);
 }
 started=true;await drain(fallback!);const before=await inspectReleaseDatabase(envFile);
 if(await main()!==sha)await run('git',['push','origin',`${sha}:refs/heads/main`]);
 let frontend;for(let i=0;i<40;i++){try{frontend=await verifyPublicRelease(origin,sha);break;}catch{if(await main()!==sha)throw new Error('Main advanced during frontend deployment');await delay(10000);}}
 if(!frontend)throw new Error('Public frontend verification timeout');
 const held=await setMode('hold',sha);if(!(await modes()).maintenance)throw new Error('Target HOLD not closed');fallback=sha;
 const after=await inspectReleaseDatabase(envFile);if(JSON.stringify(before.fingerprints)!==JSON.stringify(after.fingerprints))throw new Error('Stored payment evidence or receipts changed during closed release');
 await waitGreen();if(await main()!==sha)throw new Error('Main advanced before NORMAL');
 const active=await setMode('normal',sha);
 await finish(held.id,active.id);
}catch{
 if(started&&fallback){recovering=true;try{await drain(fallback);console.error('Release failed; compatible V9 HOLD independently verified.');}catch{console.error('Release failed; HOLD could not be fully verified. Immediate operator inspection required.');}}
 else console.error('Release preflight failed; no deployment attempted.');
 process.exitCode=1;
}
