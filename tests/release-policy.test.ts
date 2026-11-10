import {expect,it} from "vitest";
import {requireGreenChecks,requireV9Drain,requireReviewedDatabaseChanges,requireReleaseServiceConfiguration,releaseStartCommand} from "../scripts/release-policy.ts";
it('enables a one-reservation Groq qualification only in NORMAL; HOLD and default stay disabled',()=>{
 expect(releaseStartCommand('normal',true)).toContain('AI_PROVIDER=groq AI_MODEL=openai/gpt-oss-120b AI_DAILY_LIMIT=1 AI_USER_DAILY_LIMIT=1');
 for(const command of [releaseStartCommand('hold',true),releaseStartCommand('hold'),releaseStartCommand('normal')]){
  expect(command).toContain('AI_PROVIDER=disabled AI_DAILY_LIMIT=0 AI_USER_DAILY_LIMIT=0');expect(command).not.toContain('AI_PROVIDER=groq');
 }
});
it('retains the separately approved bounded rollout only when explicitly selected',()=>{
 expect(releaseStartCommand('normal','approved-rollout')).toContain('AI_DAILY_LIMIT=12 AI_USER_DAILY_LIMIT=3');
 expect(releaseStartCommand('hold','approved-rollout')).toContain('AI_PROVIDER=disabled');
});
it("requires the latest attempt of every CI gate, not an old green result",()=>{
 const checks=['offline','postgres','v3-postgres'].map((name,id)=>({id:id+1,name,status:'completed',conclusion:'success',started_at:'2026-11-07T00:00:00Z'}));
 expect(()=>requireGreenChecks(checks)).not.toThrow();
 expect(()=>requireGreenChecks(checks.slice(1))).toThrow();
 expect(()=>requireGreenChecks([...checks,{...checks[0]!,id:4,conclusion:'failure',started_at:'2026-11-07T01:00:00Z'}])).toThrow();
 expect(()=>requireGreenChecks([...checks,{...checks[0]!,id:5,status:'queued',conclusion:null,started_at:null}])).toThrow();
});
it("permits only the exact reviewed schema-preserving Phase 6 checkout fix",()=>{
 const reviewed={path:'src/db/postgres-checkout.ts',before:'c34fed719ab0ae564d86f583d68f3857405e9ec1',after:'09aafdb195771fd681f3470f8dd702a62158fb4c'};
 expect(()=>requireReviewedDatabaseChanges([])).not.toThrow();
 expect(()=>requireReviewedDatabaseChanges([reviewed])).not.toThrow();
 for(const change of [{...reviewed,path:'src/db/postgres.ts'},{...reviewed,before:'0'.repeat(40)},{...reviewed,after:'1'.repeat(40)},{...reviewed,path:'src/db/migrations/010.sql'}]){
  expect(()=>requireReviewedDatabaseChanges([change])).toThrow(/reviewed/);
 }
 expect(()=>requireReviewedDatabaseChanges([reviewed,{...reviewed,path:'src/db/other.ts'}])).toThrow();
});
it("refuses non-V9 schemas, pending captures, webhook obligations or transactions",()=>{
 const safe={versions:[1,2,3,4,5,6,7,8,9],pendingCaptures:0,pendingWebhooks:0,activeTransactions:0};
 expect(()=>requireV9Drain(safe)).not.toThrow();
 for(const changed of [{versions:[1,2,3,4,5,6,7,8]},{pendingCaptures:1},{pendingWebhooks:1},{activeTransactions:1}])expect(()=>requireV9Drain({...safe,...changed})).toThrow();
});
it("accepts only the owner-confirmed existing compute plans while preserving service safety",()=>{
 const safe={id:'srv-dbccdgjl550s73d37ao0',ownerId:'tea-d6qpqrpaae7s739l8qu0',autoDeploy:'no',serviceDetails:{plan:'0.5c-512mb',numInstances:1,envSpecificDetails:{startCommand:'ORDERTRUTH_RELEASE_MODE=normal AI_PROVIDER=disabled pnpm hosted:start'}}};
 expect(()=>requireReleaseServiceConfiguration(safe)).not.toThrow();
 expect(()=>requireReleaseServiceConfiguration({...safe,serviceDetails:{...safe.serviceDetails,plan:'free'}})).not.toThrow();
 for(const changed of [{...safe,id:'other'},{...safe,ownerId:'other'},{...safe,autoDeploy:'yes'},{...safe,serviceDetails:{...safe.serviceDetails,plan:'unknown'}},{...safe,serviceDetails:{...safe.serviceDetails,numInstances:2}},{...safe,serviceDetails:{...safe.serviceDetails,envSpecificDetails:{startCommand:'ORDERTRUTH_MIGRATION=apply-v9 pnpm hosted:start'}}}]){
  expect(()=>requireReleaseServiceConfiguration(changed)).toThrow(/Unsafe service/);
 }
 expect(()=>requireReleaseServiceConfiguration(undefined)).toThrow();
});

it('enables the authorized Autopilot allowance only in explicit NORMAL rollout',()=>{
 expect(releaseStartCommand('normal','approved-autopilot')).toContain('AI_DAILY_LIMIT=200 AI_USER_DAILY_LIMIT=9');
 expect(releaseStartCommand('hold','approved-autopilot')).toContain('AI_PROVIDER=disabled AI_DAILY_LIMIT=0 AI_USER_DAILY_LIMIT=0');
});
