import { describe,expect,it } from "vitest";
import { prepareGroundedContext,validateGroundedPlan,validateGroundedProjection } from "../src/ai/grounded-investigation.ts";
import { callPrivateInvestigator } from "../src/ai/private-investigator.ts";
import type { InvestigationEvidence } from "../src/ai/investigation.ts";

const at="2026-11-08T00:00:00.000Z";
const evidence: InvestigationEvidence[]=[{id:"private-state",source:"CONTROLLED_MERCHANT_STATE",observedAt:at,facts:{activeOrders:2,orders:[
 {id:"private-order1",status:"placed",amountMinor:100,currency:"USD"},{id:"private-order2",status:"placed",amountMinor:100,currency:"USD"}],providerMutation:false}},
 {id:"private-timing",source:"MERCHANT_DIAGNOSTIC",observedAt:at,facts:{diagnostic:"HANDLER_TIMING",clockPrecision:"MILLISECOND",note:"Recorded intervals describe controlled handlers; they do not establish PayPal concurrency.",entries:[
 {handler:"capture_return",startedAt:at,finishedAt:"2026-11-08T00:00:00.010Z",durationMs:10,merchantOrderId:"private-order1"},
 {handler:"webhook_capture_completed",startedAt:"2026-11-08T00:00:01.000Z",finishedAt:"2026-11-08T00:00:01.010Z",durationMs:10,merchantOrderId:"private-order2"}]}}];
const plan=(ctx:ReturnType<typeof prepareGroundedContext>)=>({hypotheses:[
 {mechanism:"OVERLAPPING_HANDLERS",evidenceFactIds:[ctx.facts[0]!.id]},
 {mechanism:"SEQUENTIAL_DUPLICATE_WRITES",evidenceFactIds:[ctx.facts[0]!.id]}],nextDiagnostic:"HANDLER_TIMING",compareMechanisms:["OVERLAPPING_HANDLERS","SEQUENTIAL_DUPLICATE_WRITES"]});

describe("grounded investigator boundary",()=>{
 it("does not accept free prose, payment assertions or refund instructions even with a valid citation",()=>{
  const ctx=prepareGroundedContext(evidence),base=plan(ctx);
  for(const poisoned of [{...base,summary:"Payment captured; issue a refund."},{...base,hypotheses:[{...base.hypotheses[0],explanation:"The captured payment was refunded."},base.hypotheses[1]]},
   {...base,hypotheses:[{mechanism:"PAYMENT_CAPTURED",evidenceFactIds:[ctx.facts[0]!.id]},base.hypotheses[1]]}])expect(validateGroundedPlan(poisoned,ctx)).toEqual({ok:false,error:"INVALID_SCHEMA"});
 });
 it("independently exposes contrary timing even when the model omits it",()=>{
  const ctx=prepareGroundedContext(evidence),result=validateGroundedPlan(plan(ctx),ctx);
  expect(result.ok).toBe(true);if(!result.ok)return;
  const race=result.grounded.hypotheses[0]!;
  expect(race.status).toBe("HYPOTHESIS");expect(race.assessment).toBe("WEAKENED");
  expect(race.contradictingFacts.map(f=>f.kind)).toContain("HANDLER_INTERVALS_DISJOINT");
  expect(result.investigation.hypotheses[0]!.explanation).toMatch(/disjoint.*weaken/i);
  expect(result.investigation.hypotheses[0]!.evidenceIds).toContain("private-timing");
  expect(result.grounded.hypotheses[1]!.supportingFacts.map(f=>f.kind)).toContain("HANDLER_INTERVALS_DISJOINT");
 });
 it("rejects invented or another request's fact references",()=>{
  const a=prepareGroundedContext(evidence),b=prepareGroundedContext(evidence);
  expect(validateGroundedPlan(plan(a),b)).toEqual({ok:false,error:"INVENTED_EVIDENCE"});
 });
 it("requires distinct competing mechanisms and a diagnostic that compares supplied hypotheses",()=>{
  const ctx=prepareGroundedContext(evidence),base=plan(ctx);
  expect(validateGroundedPlan({...base,hypotheses:[base.hypotheses[0],base.hypotheses[0]]},ctx).ok).toBe(false);
  expect(validateGroundedPlan({...base,compareMechanisms:["OVERLAPPING_HANDLERS","WRITE_FAILURE_OR_INTERRUPTION"]},ctx).ok).toBe(false);
  expect(validateGroundedPlan({...base,hypotheses:[base.hypotheses[0],{mechanism:"KEY_SCOPE_MISMATCH",evidenceFactIds:[ctx.facts[0]!.id]}],compareMechanisms:["OVERLAPPING_HANDLERS","KEY_SCOPE_MISMATCH"]},ctx)).toEqual({ok:false,error:"DIAGNOSTIC_ALREADY_PERFORMED"});
 });
 it("rejects an available diagnostic that cannot distinguish the selected mechanisms",()=>{
  const ctx=prepareGroundedContext(evidence),base=plan(ctx);
  expect(validateGroundedPlan({...base,nextDiagnostic:"MERCHANT_WRITE_OUTCOMES"},ctx)).toEqual({ok:false,error:"IRRELEVANT_DIAGNOSTIC"});
 });
 it("reports an exhausted comparison instead of recommending unrelated diagnostics",()=>{
  const ctx=prepareGroundedContext(evidence),result=validateGroundedPlan(plan(ctx),ctx);
  expect(result.ok).toBe(true);if(!result.ok)return;
  expect(result.grounded.diagnostic.status).toBe("EXHAUSTED");
  expect(result.investigation.diagnosticReason).toContain("no additional diagnostic is available");
  expect(validateGroundedProjection(result.investigation,evidence).ok).toBe(true);
 });
 it("keeps private references, financial amounts and customer values out of the prompt",()=>{
  const ctx=prepareGroundedContext(evidence);
  for(const value of ["private-state","private-order1","private-timing","USD",'"amountMinor"',"2026-11-08"])expect(ctx.payload).not.toContain(value);
  expect(ctx.payload).toContain("HANDLER_INTERVALS_DISJOINT");
 });
 it("flags inconsistent merchant counts rather than certifying a duplicate",()=>{
  const bad=structuredClone(evidence);bad[0]!.facts={...bad[0]!.facts,activeOrders:0};
  const ctx=prepareGroundedContext(bad);
  expect(ctx.facts.map(f=>f.kind)).toContain("MERCHANT_COUNT_INCONSISTENT");
  expect(ctx.facts.map(f=>f.kind)).not.toContain("MULTIPLE_ACTIVE_ORDERS");
 });
 it("rechecks exact rendered semantics at service and cache boundaries",()=>{
  const ctx=prepareGroundedContext(evidence),valid=validateGroundedPlan(plan(ctx),ctx);expect(valid.ok).toBe(true);if(!valid.ok)return;
  expect(validateGroundedProjection(valid.investigation,evidence).ok).toBe(true);
  const poisoned=structuredClone(valid.investigation);poisoned.hypotheses[0]!.explanation="The payment was captured. Refund the customer now.";
  expect(validateGroundedProjection(poisoned,evidence)).toEqual({ok:false,error:"UNSAFE_GROUNDED_RESULT"});
  const omitted=structuredClone(valid.investigation);omitted.hypotheses[0]!.evidenceIds=["private-state"];
  expect(validateGroundedProjection(omitted,evidence).ok).toBe(false);
 });
 it("rejects citation-valid legacy prose through the actual private transport",async()=>{
  const result=await callPrivateInvestigator({apiKey:"synthetic-key",model:"synthetic-model",evidence,fetchImpl:async(_url,init)=>{
   const input=JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
   return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({summary:"The payment completed; issue a refund.",hypotheses:[{explanation:"Refund the payment.",evidenceIds:[input.evidence[0].id],confidence:"HIGH",status:"HYPOTHESIS"}],nextDiagnostic:"IDEMPOTENCY_KEYS",diagnosticReason:"Refund it."})}]}}]}));
  }});
  expect(result.ok).toBe(false);expect(result.error).toBe("INVALID_SCHEMA");expect(result.result).toBeNull();
 });
});
