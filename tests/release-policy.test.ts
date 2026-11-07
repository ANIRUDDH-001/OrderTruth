import {expect,it} from "vitest";
import {requireGreenChecks,requireV9Drain} from "../scripts/release-policy.ts";
it("requires the latest attempt of every CI gate, not an old green result",()=>{
 const checks=['offline','postgres','v3-postgres'].map((name,id)=>({id:id+1,name,status:'completed',conclusion:'success',started_at:'2026-11-07T00:00:00Z'}));
 expect(()=>requireGreenChecks(checks)).not.toThrow();
 expect(()=>requireGreenChecks(checks.slice(1))).toThrow();
 expect(()=>requireGreenChecks([...checks,{...checks[0]!,id:4,conclusion:'failure',started_at:'2026-11-07T01:00:00Z'}])).toThrow();
 expect(()=>requireGreenChecks([...checks,{...checks[0]!,id:5,status:'queued',conclusion:null,started_at:null}])).toThrow();
});
it("refuses non-V9 schemas, pending captures, webhook obligations or transactions",()=>{
 const safe={versions:[1,2,3,4,5,6,7,8,9],pendingCaptures:0,pendingWebhooks:0,activeTransactions:0};
 expect(()=>requireV9Drain(safe)).not.toThrow();
 for(const changed of [{versions:[1,2,3,4,5,6,7,8]},{pendingCaptures:1},{pendingWebhooks:1},{activeTransactions:1}])expect(()=>requireV9Drain({...safe,...changed})).toThrow();
});
