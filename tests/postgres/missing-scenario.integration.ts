import {randomBytes} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createPostgresPool} from '../../src/db/postgres.ts';
import {migratePostgres} from '../../src/db/postgres-migrate.ts';
import {PostgresCheckoutStore} from '../../src/db/postgres-checkout.ts';
import {PostgresScenarioStore} from '../../src/merchant/postgres-scenarios.ts';
import {PostgresRecoveryService} from '../../src/merchant/postgres-recovery.ts';
import {env} from './local-db.ts';
const pool=createPostgresPool(env.DATABASE_URL!),schema=`qual_${randomBytes(10).toString('hex')}`;
const checkout=new PostgresCheckoutStore(pool,schema),scenarios=new PostgresScenarioStore(pool,schema);
beforeAll(async()=>{await migratePostgres(pool,schema);for(const id of ['synthetic_missing_a','synthetic_missing_b'])await pool.query(`INSERT INTO ${schema}.ot_auth_user(id,name,email,"emailVerified","isAnonymous") VALUES($1,'Synthetic qualification',$2,false,true)`,[id,`${id}@example.test`]);});
afterAll(async()=>{await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end();});
async function missing(){
 const suffix=randomBytes(8).toString('hex').toUpperCase(),created=await checkout.createCheckout(`synthetic-missing-${suffix}`),order=`ORDER${suffix}`;
 await checkout.attachOrder(created.attempt.id,order);
 await checkout.recordReadback(created.attempt.id,{id:order,status:'COMPLETED',intent:'CAPTURE',purchase_units:[{custom_id:created.intent.id,amount:{currency_code:'USD',value:'1.00'},payments:{captures:[{id:`CAPTURE${suffix}`,status:'COMPLETED',amount:{currency_code:'USD',value:'1.00'}}]}}]},'SYNTHETIC_QUALIFICATION');
 const run=await scenarios.createQualification('synthetic_missing_a',created.attempt.id,undefined,'MISSING');
 const current=await scenarios.get('synthetic_missing_a',run.id),born=Date.parse(run.created_at);
 const service=(now:number)=>new PostgresRecoveryService(pool,schema,{runId:run.id,userId:'synthetic_missing_a'},{now:()=>now,missingOrderGraceMs:300000});
 return {...created,order,run,current,born,service};
}
it('keeps zero-order grace distinct from a missing-order finding without provider or repair actions',async()=>{
 const f=await missing();expect(f.current.orders).toEqual([]);expect(f.current.caseKind).toBe('MISSING');
 const early=await f.service(f.born+299999).check(f.current.organizationId,f.current.intentId);
 expect(early).toMatchObject({result:'OUT_OF_SCOPE',incidentId:null,recoverySupported:false});
 expect((await pool.query(`SELECT count(*)::int n FROM ${schema}.repair_plans`)).rows[0].n).toBe(0);
 await expect(scenarios.injectDuplicate('synthetic_missing_a',f.run.id)).rejects.toThrow(/read.only|baseline|missing/i);
});
it('opens one evidence-linked missing incident after grace under concurrency and refuses duplicate repair',async()=>{
 const f=await missing(),service=f.service(f.born+300001);
 const results=await Promise.all([service.check(f.current.organizationId,f.current.intentId),service.check(f.current.organizationId,f.current.intentId)]);
 expect(results[0]).toMatchObject({result:'VIOLATED',condition:'MISSING_MERCHANT_ORDER',recoverySupported:false});expect(results[0].incidentId).toBeTruthy();expect(results[0].incidentId).toBe(results[1].incidentId);
 const incident=(await pool.query(`SELECT incident_class FROM ${schema}.incidents WHERE id=$1`,[results[0].incidentId])).rows[0];expect(incident.incident_class).toBe('MISSING_MERCHANT_ORDER');
 await expect(service.plan(f.current.organizationId,results[0].incidentId!,'synthetic-operator')).rejects.toThrow(/eligible|read.only|missing/i);
 await expect(scenarios.get('synthetic_missing_b',f.run.id)).rejects.toThrow(/not found/i);
 const state=await scenarios.get('synthetic_missing_a',f.run.id);expect(state.latestCheck).toMatchObject({result:'VIOLATED',activeOrderCount:0,incidentClass:'MISSING_MERCHANT_ORDER'});
});
it('refuses a missing-order accusation after a newer contradictory provider observation',async()=>{
 const f=await missing();await checkout.recordReadback(f.attempt.id,{id:f.order,status:'CREATED',intent:'CAPTURE',purchase_units:[{custom_id:f.intent.id,amount:{currency_code:'USD',value:'1.00'}}]},'SYNTHETIC_QUALIFICATION');
 const result=await f.service(f.born+300001).check(f.current.organizationId,f.current.intentId);expect(result.result).toBe('NOT_ELIGIBLE');expect(result.incidentId).toBeNull();
});
it('preserves the operation kind across repeats and rejects a changed kind without creating another case',async()=>{
 const f=await missing();const op=(await pool.query(`SELECT operation_id FROM ${schema}.scenario_operations WHERE run_id=$1`,[f.run.id])).rows[0].operation_id;
 expect((await scenarios.createQualification('synthetic_missing_a',f.attempt.id,op,'MISSING')).id).toBe(f.run.id);
 await expect(scenarios.createQualification('synthetic_missing_a',f.attempt.id,op,'DUPLICATE')).rejects.toMatchObject({code:'OPERATION_KIND_MISMATCH'});
 await expect(scenarios.lookupOperation('synthetic_missing_a',op,'DUPLICATE')).rejects.toMatchObject({code:'OPERATION_KIND_MISMATCH'});
 expect((await scenarios.lookupOperation('synthetic_missing_a',op,'MISSING'))?.run.id).toBe(f.run.id);
});
