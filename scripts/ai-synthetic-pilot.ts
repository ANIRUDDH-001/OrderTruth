import {existsSync,mkdirSync,readFileSync,writeFileSync,openSync,closeSync,unlinkSync,renameSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {canonical,sha256} from '../src/domain/canonical.ts';
import {pilotCases} from '../src/ai/pilot-cases.ts';
import {prepareGroundedContext} from '../src/ai/grounded-investigation.ts';
import {promptRulesControl} from '../src/ai/investigator-eval/control.ts';
import {callPrivateInvestigator} from '../src/ai/private-investigator.ts';
import {callGroqInvestigator} from '../src/ai/groq-investigator.ts';

const folder=resolve('.work/ai-pilot-phase7-v4');mkdirSync(folder,{recursive:true});
const priorPath=resolve('.work/ai-pilot-total-allowance.json');
const prior: {attempts:{groq:number;gemini:number};lastAttempt:number}=JSON.parse(readFileSync(priorPath,'utf8'));
if(existsSync(resolve('.work/ai-pilot-phase7-v2/running.lock'))||existsSync(resolve('.work/pilot-error-probe.lock'))||prior.attempts.groq!==4||prior.attempts.gemini!==5)throw Error('Unexpected prior pilot; do not reset an allowance');
const sourceFiles=['src/ai/pilot-cases.ts','src/ai/comparison-investigation.ts','src/ai/grounded-investigation.ts','src/ai/evidence-egress.ts','src/ai/private-investigator.ts','src/ai/groq-investigator.ts','src/ai/provider-transport.ts','src/ai/investigator-eval/control.ts','scripts/ai-synthetic-pilot.ts'];
const sourceIdentity=Object.fromEntries(sourceFiles.map(path=>[path,sha256(readFileSync(resolve(path),'utf8'))]));
const protocol={version:4,sourceIdentity,predecessor:{allowanceSha256:sha256(readFileSync(priorPath,'utf8')),attempts:prior.attempts,reason:'By-construction comparison selection; no failed case is retried. All earlier failures remain preserved.'},syntheticOnly:true,cases:pilotCases.length,maxPerProvider:10,pilotStopPerProvider:8,reservedForBrowserPerProvider:2,globalSpacingMs:65000,retries:0,failover:false,
 providers:{groq:'openai/gpt-oss-120b',gemini:'gemini-3.5-flash-lite'},
 rubric:['validated output','correct diagnostic distinction','contradictory evidence exposed','uncertainty preserved','no financial fabrication/action instructions','incremental utility against promptRulesControl','latency and actual token metadata'],
 limitation:'Developer-authored pilot. Not independently blinded holdouts; no superiority claim from schema success.'};
for(const c of pilotCases){if(c.evidence.some(e=>e.source==='PAYPAL_SANDBOX_OBSERVATION'))throw Error('Synthetic pilot only');prepareGroundedContext(c.evidence);}
const digest=sha256(canonical({protocol,cases:pilotCases}));
const manifest={...protocol,digest,cases:pilotCases.map(c=>({...c,baseline:promptRulesControl(c.evidence)}))};
const manifestPath=resolve(folder,'protocol.json');
if(existsSync(manifestPath)&&JSON.parse(readFileSync(manifestPath,'utf8')).digest!==digest){
 if(process.argv.includes('--run')||existsSync(resolve(folder,'state.json')))throw Error('Pilot protocol changed; do not continue an existing evaluation');
 renameSync(manifestPath,resolve(folder,`preflight-protocol-${Date.now()}.json`));
}
if(!existsSync(manifestPath))writeFileSync(manifestPath,JSON.stringify(manifest,null,2),{flag:'wx'});
if(!process.argv.includes('--run')){console.log(JSON.stringify({stage:'PREPARED',digest,cases:pilotCases.length,providerCalls:0}));process.exit(0);}
if(!process.argv.includes('--owner-confirmed-free-only')||!process.argv.includes('--continue-reviewed-contract'))throw Error('Verified owner free-only condition and explicitly reviewed contract continuation required');
const envIndex=process.argv.indexOf('--private-env');if(envIndex<0||!process.argv[envIndex+1])throw Error('Private server environment path required');
const privateEnv=parseEnv(readFileSync(resolve(process.argv[envIndex+1]!),'utf8'));
if(!privateEnv.GROQ_API_KEY?.trim()||!privateEnv.GEMINI_API_KEY?.trim())throw Error('Both dedicated private provider keys required; no calls made');
const lock=resolve('.work/ai-pilot-account.lock');const fd=openSync(lock,'wx');closeSync(fd);
type State={digest:string;attempts:{groq:number;gemini:number};lastAttempt:number;stopped:Partial<Record<'groq'|'gemini',string>>};
const statePath=resolve(folder,'state.json');
const state:State=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):{digest,attempts:{...prior.attempts},lastAttempt:prior.lastAttempt,stopped:{}};
if(state.digest!==digest||Object.values(state.attempts).some(n=>!Number.isInteger(n)||n<0||n>10)){unlinkSync(lock);throw Error('Invalid durable pilot allowance');}
const deadline=Date.now()+26*60_000;
try{
 for(let index=0;index<protocol.pilotStopPerProvider;index++)for(const provider of ['groq','gemini'] as const){
  if(state.stopped[provider]||index<state.attempts[provider])continue;
  const wait=protocol.globalSpacingMs-(Date.now()-state.lastAttempt);if(wait>0)await delay(wait);
  if(Date.now()>deadline)throw Error('Bounded pilot deadline reached');
  const c=pilotCases[index]!;
  const guardedFetch:typeof fetch=async(url,init)=>{
   const expected=provider==='groq'?'https://api.groq.com/openai/v1/chat/completions':`https://generativelanguage.googleapis.com/v1beta/models/${protocol.providers.gemini}:generateContent`;
   if(String(url)!==expected||init?.redirect!=='error'||init?.method!=='POST')throw Error('Pilot transport boundary rejected');
   if(state.attempts[provider]>=protocol.pilotStopPerProvider||Date.now()-state.lastAttempt<protocol.globalSpacingMs)throw Error('Pilot durable allowance rejected');
   // Reserve BEFORE the request; interruption never refunds an uncertain call.
   state.attempts[provider]++;state.lastAttempt=Date.now();writeFileSync(statePath,JSON.stringify(state,null,2));
   writeFileSync(priorPath,JSON.stringify({attempts:state.attempts,lastAttempt:state.lastAttempt,evaluationDigest:digest},null,2));
   return fetch(url,init);
  };
  const result=await (provider==='groq'?callGroqInvestigator:callPrivateInvestigator)({apiKey:provider==='groq'?privateEnv.GROQ_API_KEY!:privateEnv.GEMINI_API_KEY!,model:protocol.providers[provider],evidence:c.evidence,fetchImpl:guardedFetch});
  const record={caseId:c.id,provider,model:protocol.providers[provider],digest,at:new Date().toISOString(),...result};
  writeFileSync(resolve(folder,`${provider}-${c.id}.json`),JSON.stringify(record,null,2),{flag:'wx'});
  if(!result.ok){state.stopped[provider]=result.error??'UNKNOWN_FAILURE';writeFileSync(statePath,JSON.stringify(state,null,2));}
  console.log(JSON.stringify({stage:'RESULT',caseId:c.id,provider,ok:result.ok,error:result.error,httpStatus:result.httpStatus,latencyMs:result.latencyMs,usage:result.usage,attempts:state.attempts[provider]}));
 }
 console.log(JSON.stringify({stage:'COMPLETE',digest,attempts:state.attempts,stopped:state.stopped}));
}finally{unlinkSync(lock);}
