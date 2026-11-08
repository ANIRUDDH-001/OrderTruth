import { expect,it } from "vitest";
import { prepareGroundedContext,validateGroundedWirePlan,validateGroundedProjection } from "../src/ai/grounded-investigation.ts";
import type { InvestigationEvidence } from "../src/ai/investigation.ts";
const at="2026-11-08T00:00:00.000Z";
const evidence=(suffix:string):InvestigationEvidence[]=>[{id:`merchant-${suffix}`,source:"CONTROLLED_MERCHANT_STATE",observedAt:at,facts:{activeOrders:2,orders:[0,1].map(i=>({id:`order-${suffix}-${i}`,status:"placed",amountMinor:100,currency:"USD"})),providerMutation:false}}];
const plan=(index:unknown)=>({hypotheses:[{mechanism:"KEY_SCOPE_MISMATCH",evidenceFactIndexes:[index]},{mechanism:"OVERLAPPING_HANDLERS",evidenceFactIndexes:[index]}],nextDiagnostic:"HANDLER_TIMING",compareMechanisms:["KEY_SCOPE_MISMATCH","OVERLAPPING_HANDLERS"]});
it.each([-1,0.5,"0",100,NaN])("rejects invalid wire index %s without coercion",index=>{
 const context=prepareGroundedContext(evidence("a"));
 expect(validateGroundedWirePlan(plan(index),context)).toEqual({ok:false,error:"INVALID_SCHEMA"});
});
it("rejects schema-valid indexes outside this request's catalog",()=>{
 const context=prepareGroundedContext(evidence("a"));
 expect(validateGroundedWirePlan(plan(99),context)).toEqual({ok:false,error:"INVALID_EVIDENCE_INDEX"});
});
it("maps concurrent request indexes only through their own frozen catalogs",async()=>{
 const contexts=[prepareGroundedContext(evidence("a")),prepareGroundedContext(evidence("b"))];
 expect(contexts.every(c=>Object.isFrozen(c.facts)&&c.facts.every(Object.isFrozen))).toBe(true);
 const results=await Promise.all(contexts.map(async c=>validateGroundedWirePlan(plan(0),c)));
 for(const [i,result] of results.entries()){
  expect(result.ok).toBe(true);if(!result.ok)continue;
  expect(result.investigation.hypotheses[0]!.evidenceIds).toEqual([`merchant-${i===0?"a":"b"}`]);
  expect(validateGroundedProjection(result.investigation,evidence(i===0?"a":"b")).ok).toBe(true);
  expect(JSON.stringify(result.investigation)).not.toContain("evidenceFactIndexes");
 }
 expect(contexts[0]!.facts[0]!.id).not.toBe(contexts[1]!.facts[0]!.id);
});
it("numeric codec still includes contradictions omitted by the model",()=>{
 const input=evidence("a");input.push({id:"timing-a",source:"MERCHANT_DIAGNOSTIC",observedAt:at,facts:{diagnostic:"HANDLER_TIMING",clockPrecision:"MILLISECOND",entries:[
  {handler:"capture_return",startedAt:at,finishedAt:"2026-11-08T00:00:00.010Z",durationMs:10,merchantOrderId:"order-a-0"},
  {handler:"webhook_capture_completed",startedAt:"2026-11-08T00:00:01.000Z",finishedAt:"2026-11-08T00:00:01.010Z",durationMs:10,merchantOrderId:"order-a-1"}],note:"Recorded intervals describe controlled handlers; they do not establish PayPal concurrency."}});
 const base=plan(0),context=prepareGroundedContext(input);
 const result=validateGroundedWirePlan({...base,hypotheses:[base.hypotheses[1],{mechanism:"SEQUENTIAL_DUPLICATE_WRITES",evidenceFactIndexes:[0]}],compareMechanisms:["OVERLAPPING_HANDLERS","SEQUENTIAL_DUPLICATE_WRITES"]},context);
 expect(result.ok).toBe(true);if(!result.ok)return;
 expect(result.grounded.hypotheses[0]!.assessment).toBe("WEAKENED");
 expect(result.investigation.hypotheses[0]!.evidenceIds).toContain("timing-a");
});
