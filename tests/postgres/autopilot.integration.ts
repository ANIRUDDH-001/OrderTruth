import {randomBytes} from 'node:crypto';
import {beforeAll,afterAll,afterEach,expect,it,vi} from 'vitest';
import {createPostgresPool} from '../../src/db/postgres.ts';
import {migratePostgres} from '../../src/db/postgres-migrate.ts';
import {PostgresCheckoutStore} from '../../src/db/postgres-checkout.ts';
import {PostgresScenarioStore} from '../../src/merchant/postgres-scenarios.ts';
import {PostgresInvestigationStore} from '../../src/ai/postgres-investigation.ts';
import {PostgresInvestigationService} from '../../src/ai/postgres-investigation-service.ts';
import {prepareAgentContext,validateAgentStep} from '../../src/ai/agent-investigation.ts';
import type {InvestigationEvidence,InvestigationCall} from '../../src/ai/investigation.ts';
import {env} from './local-db.ts';
const pool=createPostgresPool(env.DATABASE_URL!),schema=`qual_${randomBytes(10).toString('hex')}`;
const scenarios=new PostgresScenarioStore(pool,schema),checkout=new PostgresCheckoutStore(pool,schema);
const usage={promptTokens:400,outputTokens:20,totalTokens:420};
const failed=(error:string):InvestigationCall=>({ok:false,result:null,error,usage,latencyMs:1,httpStatus:429});
beforeAll(()=>migratePostgres(pool,schema));
afterEach(()=>vi.restoreAllMocks());
afterAll(async()=>{await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end();});
async function fixture(){
 const user='synthetic_'+randomBytes(8).toString('hex');
 await pool.query(`INSERT INTO ${schema}.ot_auth_user(id,name,email,"emailVerified","isAnonymous") VALUES($1,'Synthetic',$2,false,true)`,[user,user+'@example.invalid']);
 const suffix=randomBytes(8).toString('hex').toUpperCase(),{intent,attempt}=await checkout.createCheckout('synthetic-'+suffix);
 await checkout.attachOrder(attempt.id,'ORDER'+suffix);
 await checkout.recordReadback(attempt.id,{id:'ORDER'+suffix,status:'COMPLETED',intent:'CAPTURE',purchase_units:[{custom_id:intent.id,amount:{currency_code:'USD',value:'1.00'},payments:{captures:[{id:'CAPTURE'+suffix,status:'COMPLETED',amount:{currency_code:'USD',value:'1.00'}}]}}]},'SYNTHETIC_QUALIFICATION');
 const run=await scenarios.createQualification(user,attempt.id);await scenarios.injectDuplicate(user,run.id);
 return {user,run:run.id};
}
function choose(evidence:readonly InvestigationEvidence[]):InvestigationCall{
 const ctx=prepareAgentContext(evidence),choice=ctx.choices.find(c=>c.checks.length)??ctx.choices.find(c=>c.settled)!;
 const result=validateAgentStep({comparison:choice.code,action:choice.settled?'CONCLUDE':choice.checks[0]},ctx);
 if(!result.ok)throw Error(result.error);
 return {ok:true,result:result.investigation,error:null,usage,latencyMs:1,httpStatus:200};
}
function service(inferAgent:(e:readonly InvestigationEvidence[])=>Promise<InvestigationCall>=async e=>choose(e),limit=9){return new PostgresInvestigationService(pool,schema,{model:'synthetic-'+randomBytes(5).toString('hex'),dailyLimit:200,userDailyLimit:limit,minIntervalMs:0,infer:inferAgent,inferAgent});}
const diagnostics=async(run:string)=>(await pool.query(`SELECT kind FROM ${schema}.scenario_diagnostics WHERE run_id=$1`,[run])).rows;
it('persists three distinct checks then conclusion; restart reads trace and conclusion is cached',async()=>{
 const f=await fixture(),infer=vi.fn(async(e:readonly InvestigationEvidence[])=>choose(e)),svc=service(infer);
 for(let i=0;i<4;i++){const r=await svc.step(f.user,f.run);expect(r.status).toBe('FRESH');expect(r.concluded).toBe(i===3);}
 expect(infer).toHaveBeenCalledTimes(4);expect(await diagnostics(f.run)).toHaveLength(3);
 const trace=await svc.trace(f.user,f.run);expect(trace.steps).toHaveLength(4);expect(trace.concluded).toBe(true);
 expect(trace.steps.map(s=>s.evidence.filter(e=>e.source==='MERCHANT_DIAGNOSTIC').length)).toEqual([0,1,2,3]);
 expect((await svc.step(f.user,f.run)).status).toBe('CACHED');expect(infer).toHaveBeenCalledTimes(4);
 expect(await service().trace(f.user,f.run)).toEqual(trace);
});
it('resumes a saved choice after interrupted diagnostic without another inference',async()=>{
 const f=await fixture(),infer=vi.fn(async(e:readonly InvestigationEvidence[])=>choose(e)),svc=service(infer);
 const fault=vi.spyOn(PostgresInvestigationStore.prototype,'diagnostic').mockRejectedValueOnce(Error('synthetic interrupted'));
 await expect(svc.step(f.user,f.run)).rejects.toThrow('synthetic interrupted');expect(await diagnostics(f.run)).toHaveLength(0);
 fault.mockRestore();expect((await svc.step(f.user,f.run)).status).toBe('CACHED');expect(infer).toHaveBeenCalledTimes(1);expect(await diagnostics(f.run)).toHaveLength(1);
});
it('rejects invalid inference without writing a diagnostic',async()=>{
 const f=await fixture(),svc=service(async()=>failed('INVALID_SCHEMA'));
 expect((await svc.step(f.user,f.run)).reason).toBe('INVALID_SCHEMA');expect(await diagnostics(f.run)).toHaveLength(0);expect((await svc.trace(f.user,f.run)).steps).toEqual([]);
});
it('retains prior steps on provider 429 and opens circuit without another call',async()=>{
 const f=await fixture();let calls=0;const svc=service(async e=>++calls===1?choose(e):failed('QUOTA_OR_RATE_LIMIT'));
 await svc.step(f.user,f.run);expect((await svc.step(f.user,f.run)).reason).toBe('QUOTA_OR_RATE_LIMIT');
 expect((await svc.step(f.user,f.run)).reason).toBe('PROVIDER_CIRCUIT_OPEN');expect(calls).toBe(2);expect((await svc.trace(f.user,f.run)).steps).toHaveLength(1);
});
it('refuses foreign sessions before inference or trace disclosure',async()=>{
 const f=await fixture(),infer=vi.fn(async(e:readonly InvestigationEvidence[])=>choose(e)),svc=service(infer);
 await expect(svc.step('foreign',f.run)).rejects.toThrow('not found');await expect(svc.trace('foreign',f.run)).rejects.toThrow('not found');expect(infer).not.toHaveBeenCalled();
});
it('stops at session allowance mid-run and preserves prior evidence',async()=>{
 const f=await fixture(),svc=service(undefined,1);await svc.step(f.user,f.run);
 expect((await svc.step(f.user,f.run)).reason).toBe('SESSION_DAILY_BUDGET');expect(await diagnostics(f.run)).toHaveLength(1);
});
it('serializes concurrent inference requests with one busy response',async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 const svc=service(async e=>{entered();await gate;return choose(e);});const first=svc.step(f.user,f.run);await ready;
 try{expect((await svc.step(f.user,f.run)).reason).toBe('AI_BUSY');}finally{release();}expect((await first).status).toBe('FRESH');expect(await diagnostics(f.run)).toHaveLength(1);
});
it('returns baseline without inference when agent adapter is absent',async()=>{
 const f=await fixture(),svc=new PostgresInvestigationService(pool,schema,{model:'synthetic',dailyLimit:200,userDailyLimit:9,minIntervalMs:0,infer:async()=>failed('UNEXPECTED')});
 expect(await svc.step(f.user,f.run)).toMatchObject({status:'UNAVAILABLE',reason:'AI_NOT_CONFIGURED',executed:null,concluded:false,baseline:{nextDiagnostic:'IDEMPOTENCY_KEYS'}});
});

it('retains comparison history when later Autopilot steps exist',async()=>{
 const f=await fixture();const {prepareComparisonContext,validateComparisonSelection}=await import('../../src/ai/comparison-investigation.ts');
 const svc=new PostgresInvestigationService(pool,schema,{model:'synthetic-history',dailyLimit:200,userDailyLimit:9,minIntervalMs:0,inferAgent:async e=>choose(e),infer:async e=>{
  const ctx=prepareComparisonContext(e),answer=validateComparisonSelection({comparison:'A'},ctx);if(!answer.ok)throw Error(answer.error);return {ok:true,result:answer.investigation,error:null,usage,latencyMs:1,httpStatus:200};
 }});
 const comparison=await svc.investigate(f.user,f.run);await svc.step(f.user,f.run);
 expect((await svc.history(f.user,f.run))?.snapshotSha256).toBe(comparison.snapshotSha256);
});
