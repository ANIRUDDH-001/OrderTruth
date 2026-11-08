/** Explicit loopback-only synthetic qualification using real HTTP, PG and AI. */
import {randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {resolve} from 'node:path';
import {betterAuth} from 'better-auth';
import {loadPostgresConfig} from '../src/config.ts';
import {buildHostedApp} from '../src/server/hosted-app.ts';
import {createPostgresPool} from '../src/db/postgres.ts';
import {PostgresCheckoutStore} from '../src/db/postgres-checkout.ts';
import {PostgresScenarioStore} from '../src/merchant/postgres-scenarios.ts';
import {createSessionAuth} from '../src/server/auth.ts';
import {sessionIdentity} from '../src/server/session-api.ts';
import {assertLocalDatabase} from './qualification-safety.ts';

const args=process.argv.slice(2),providerArg=args[args.indexOf('--provider')+1];
if(process.env.NODE_ENV!=='test'||!args.includes('--synthetic-live-ai')||(providerArg!=='gemini'&&providerArg!=='groq'))throw Error('Explicit synthetic AI test/provider required');
const provider=providerArg;
const privateIndex=args.indexOf('--private-env');if(privateIndex<0||!args[privateIndex+1])throw Error('Private environment path required');
const privateEnv=parseEnv(readFileSync(resolve(args[privateIndex+1]!),'utf8'));
if(privateEnv.PAYPAL_ENV!=='sandbox'||privateEnv.PAYPAL_API_BASE!=='https://api-m.sandbox.paypal.com')throw Error('Sandbox configuration required');
const database=parseEnv(readFileSync('.work/postgres/.env','utf8'));assertLocalDatabase(database.DATABASE_URL!);
const folder=resolve('.work/ai-browser');mkdirSync(folder,{recursive:true});
const markerPath=resolve(folder,'managed.json'),secretPath=resolve(folder,'.env');
const resume=args.includes('--resume');
if(resume!==existsSync(markerPath))throw Error('Use explicit resume for the existing disposable qualification');
if(!resume)writeFileSync(secretPath,`AUTH_SECRET=${randomBytes(32).toString('hex')}\n`,{flag:'wx',mode:0o600});
const authSecret=parseEnv(readFileSync(secretPath,'utf8')).AUTH_SECRET!;
const previous=resume?JSON.parse(readFileSync(markerPath,'utf8')):null;
const schema=previous?.schema??`qual_${randomBytes(10).toString('hex')}`;
if(!/^qual_[a-f0-9]{20}$/.test(schema))throw Error('Owned disposable schema required');
const origin='http://127.0.0.1:3017',model=provider==='gemini'?'gemini-3.5-flash-lite':'openai/gpt-oss-120b';
const config=loadPostgresConfig({DATABASE_URL:database.DATABASE_URL,APP_ORIGIN:origin,AUTH_SECRET:authSecret,
 PAYPAL_ENV:'sandbox',PAYPAL_API_BASE:'https://api-m.sandbox.paypal.com',PAYPAL_CLIENT_ID:'synthetic-browser-client',PAYPAL_CLIENT_SECRET:'synthetic-browser-secret',
 AI_PROVIDER:provider,AI_MODEL:model,GEMINI_API_KEY:privateEnv.GEMINI_API_KEY,GROQ_API_KEY:privateEnv.GROQ_API_KEY,AI_DAILY_LIMIT:'12',AI_USER_DAILY_LIMIT:'3'});
const nativeFetch=globalThis.fetch;
globalThis.fetch=async(url,init)=>{
 const expected=provider==='groq'?'https://api.groq.com/openai/v1/chat/completions':`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
 if(String(url)!==expected||init?.method!=='POST'||init.redirect!=='error')throw Error('Qualification permits only the selected model endpoint');
 const lock=resolve('.work/ai-pilot-account.lock'),allowance=resolve('.work/ai-pilot-total-allowance.json');
 const handle=openSync(lock,'wx');closeSync(handle);
 try{
  const state=JSON.parse(readFileSync(allowance,'utf8'));
  if(state.attempts[provider]>=10||Date.now()-state.lastAttempt<65000)throw Error('Original qualification allowance or spacing reached');
  state.attempts[provider]++;state.lastAttempt=Date.now();state.lastPurpose='localhost-synthetic-browser';
  writeFileSync(allowance,JSON.stringify(state,null,2));
  return await nativeFetch(url,init);
 }finally{unlinkSync(lock);}
};
const app=await buildHostedApp(config,{schema,staticFiles:true,migration:resume?'check':'apply'});
const pool=createPostgresPool(database.DATABASE_URL!);pool.options.options+=` -c search_path=${schema},pg_catalog`;
const auth=createSessionAuth(pool,origin,authSecret);
let attemptId:string;
if(resume){config.ownerIds.add(previous.ownerId);attemptId=previous.attemptId;}
else{
 const bootstrap=betterAuth({...auth.options,emailAndPassword:{...auth.options.emailAndPassword,enabled:true,disableSignUp:false}});
 const owner=await bootstrap.api.signUpEmail({body:{email:'synthetic-owner@example.test',password:'synthetic-browser-only-password',name:'Synthetic qualification owner'}});
 config.ownerIds.add(owner.user.id);
 const checkout=new PostgresCheckoutStore(pool,schema),created=await checkout.createCheckout(`synthetic-ai-${randomBytes(8).toString('hex')}`);
 attemptId=created.attempt.id;await checkout.attachOrder(attemptId,'SYNTHETICAIBROWSERORDER');
 await checkout.recordReadback(attemptId,{id:'SYNTHETICAIBROWSERORDER',status:'COMPLETED',intent:'CAPTURE',purchase_units:[{custom_id:created.intent.id,amount:{currency_code:'USD',value:'1.00'},payments:{captures:[{id:'SYNTHETICAIBROWSERCAPTURE',status:'COMPLETED',amount:{currency_code:'USD',value:'1.00'}}]}}]},'SYNTHETIC_QUALIFICATION');
 writeFileSync(markerPath,JSON.stringify({schema,attemptId,ownerId:owner.user.id,origin,syntheticOnly:true},null,2),{flag:'wx'});
}
const scenarios=new PostgresScenarioStore(pool,schema);
app.get('/qualification/',async(_request,reply)=>reply.type('text/html').send(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Synthetic AI qualification</title><main><h1>Synthetic AI qualification</h1><p>Real local application and PostgreSQL. Only the selected AI provider may be called, within the original shared qualification allowance. All payment evidence is synthetic; PayPal requests are blocked.</p><button id="start">Create a synthetic investigation case</button><p id="status" role="status"></p></main><script>document.querySelector('#start').onclick=async()=>{try{const sign=await fetch('/api/auth/sign-in/anonymous',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});if(!sign.ok)throw Error('Guest entry failed');const r=await fetch('/qualification/new-case',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});if(!r.ok)throw Error('Case creation failed');location.href='/?run='+encodeURIComponent((await r.json()).run);}catch(e){document.querySelector('#status').textContent=e.message;}};</script></html>`));
app.post('/qualification/new-case',async(request,reply)=>{
 if(request.headers.origin!==origin)return reply.code(403).send({error:'Same-origin request required'});
 const identity=await sessionIdentity(auth,request);if(!identity)return reply.code(401).send({error:'Session required'});
 return {run:(await scenarios.createQualification(identity.userId,attemptId)).id};
});
let closing=false;
const timer=setTimeout(()=>{void close();},30*60_000);
async function close(){if(closing)return;closing=true;clearTimeout(timer);await app.close();await pool.end();}
process.once('SIGINT',()=>{void close();});process.once('SIGTERM',()=>{void close();});
await app.listen({host:'127.0.0.1',port:3017});
writeFileSync(resolve(folder,'runtime.json'),JSON.stringify({pid:process.pid,schema,provider,model,origin,startedAt:new Date().toISOString(),boundedMinutes:30},null,2));
console.log(JSON.stringify({stage:'READY',origin,provider,model,syntheticOnly:true,paypalNetwork:'BLOCKED',schemaRetainedForExplicitResume:true}));
