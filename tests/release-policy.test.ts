import {expect,it} from "vitest";
import {requireGreenChecks,requireV9Drain,requireReviewedDatabaseChanges} from "../scripts/release-policy.ts";
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
