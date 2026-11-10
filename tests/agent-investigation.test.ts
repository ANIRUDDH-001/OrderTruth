import {expect,it} from 'vitest';
import {AGENT_POLICY,agentResponseSchema,isConcluded,prepareAgentContext,validateAgentStep} from '../src/ai/agent-investigation.ts';
import {validateGroundedProjection} from '../src/ai/grounded-investigation.ts';
import {diagnosticKinds} from '../src/ai/investigation.ts';
import {pilotCases} from '../src/ai/pilot-cases.ts';

const evidenceOf=(id:string)=>pilotCases.find(c=>c.id===id)!.evidence;
it('makes every offered action a valid evidence-bound read-only step',()=>{
 for(const c of pilotCases){
  const context=prepareAgentContext(c.evidence);
  expect(context.choices.length).toBeLessThanOrEqual(10);
  for(const choice of context.choices){
   expect(choice.checks.length>0,`${c.id}/${choice.code}`).not.toBe(choice.settled!==null);
   for(const action of choice.settled?['CONCLUDE'] as const:choice.checks){
    const step=validateAgentStep({comparison:choice.code,action},context);
    expect(step.ok,`${c.id}/${choice.code}/${action}`).toBe(true);if(!step.ok)continue;
    expect(isConcluded(step.investigation)).toBe(action==='CONCLUDE');
    if(action!=='CONCLUDE')expect(step.investigation.nextDiagnostic).toBe(action);
    expect(validateGroundedProjection(step.investigation,c.evidence).ok).toBe(true);
   }
  }
 }
});
it('offers nothing when the merchant record is not a plain duplicate',()=>{
 expect(prepareAgentContext(evidenceOf('P09')).choices).toHaveLength(0);
 expect(prepareAgentContext(evidenceOf('P10')).choices).toHaveLength(0);
});
it('rejects a check that is recorded, irrelevant to the pair, or not offered',()=>{
 const context=prepareAgentContext(evidenceOf('P02'));
 const timingPair=context.choices.find(c=>c.mechanisms.includes('OVERLAPPING_HANDLERS')&&c.mechanisms.includes('SEQUENTIAL_DUPLICATE_WRITES'))!;
 expect(validateAgentStep({comparison:timingPair.code,action:'MERCHANT_WRITE_OUTCOMES'},context)).toEqual({ok:false,error:'IRRELEVANT_DIAGNOSTIC'});
 const keyPair=context.choices.find(c=>c.mechanisms.includes('KEY_SCOPE_MISMATCH')&&c.mechanisms.includes('OVERLAPPING_HANDLERS'))!;
 expect(validateAgentStep({comparison:keyPair.code,action:'IDEMPOTENCY_KEYS'},context)).toEqual({ok:false,error:'DIAGNOSTIC_ALREADY_PERFORMED'});
 // Unknown never widens the menu to every remaining check.
 const unknownPair=prepareAgentContext(evidenceOf('P01')).choices.find(c=>c.mechanisms.includes('KEY_SCOPE_MISMATCH')&&c.mechanisms.includes('UNKNOWN_CAUSE'))!;
 expect(unknownPair.checks).toEqual(['IDEMPOTENCY_KEYS']);
 expect(validateAgentStep({comparison:unknownPair.code,action:'HANDLER_TIMING'},prepareAgentContext(evidenceOf('P01')))).toEqual({ok:false,error:'IRRELEVANT_DIAGNOSTIC'});
 expect(validateAgentStep({comparison:'E',action:'HANDLER_TIMING'},context)).toEqual({ok:false,error:'INVALID_COMPARISON'});
});
it('refuses to conclude while a separating check is still unrecorded',()=>{
 for(const id of ['P01','P02']){
  const context=prepareAgentContext(evidenceOf(id));
  for(const choice of context.choices)expect(validateAgentStep({comparison:choice.code,action:'CONCLUDE'},context)).toEqual({ok:false,error:'PREMATURE_CONCLUSION'});
 }
});
it('lets one recorded check settle only the pair it separates',()=>{
 const context=prepareAgentContext(evidenceOf('P04'));
 const settled=context.choices.filter(c=>c.settled);
 expect(settled.map(c=>[...c.mechanisms])).toEqual([['OVERLAPPING_HANDLERS','SEQUENTIAL_DUPLICATE_WRITES']]);
 const step=validateAgentStep({comparison:settled[0]!.code,action:'CONCLUDE'},context);
 expect(step.ok).toBe(true);if(!step.ok)return;
 expect(step.grounded.diagnostic.status).toBe('EXHAUSTED');
 expect(step.grounded.hypotheses.map(h=>h.assessment)).toEqual(['WEAKENED','COMPATIBLE']);
});
it('leaves only conclusions once all three checks are recorded',()=>{
 const context=prepareAgentContext(evidenceOf('P08'));
 expect(context.choices).toHaveLength(10);
 expect(context.choices.every(c=>c.settled&&!c.checks.length)).toBe(true);
 for(const kind of diagnosticKinds)expect(validateAgentStep({comparison:context.choices[0]!.code,action:kind},context)).toEqual({ok:false,error:'DIAGNOSTIC_ALREADY_PERFORMED'});
});
it('rejects prose, extra authority and unknown values in the model step',()=>{
 const context=prepareAgentContext(evidenceOf('P01'));
 const code=context.choices[0]!.code,action=context.choices[0]!.checks[0]!;
 for(const value of [{comparison:code},{action},{comparison:'P',action},{comparison:code,action:'REFUND'},{comparison:code,action,refund:true},
  {comparison:code,action,summary:'The payment failed.'},{comparison:code,action:[action]},null,'A'])expect(validateAgentStep(value,context)).toEqual({ok:false,error:'INVALID_SCHEMA'});
});
it('sends a closed menu without private identifiers or model-writable text fields',()=>{
 const context=prepareAgentContext(evidenceOf('P08')),payload=JSON.parse(context.payload);
 expect(payload.policy).toBe(AGENT_POLICY);
 expect(payload.recordedChecks.sort()).toEqual([...diagnosticKinds].sort());
 expect(payload.comparisonChoices.every((c:{actions:string[]})=>c.actions.join()==='CONCLUDE')).toBe(true);
 for(const id of ['synthetic-payment','synthetic-merchant','synthetic-keys','synthetic-order-0'])expect(context.payload).not.toContain(id);
 const schema=agentResponseSchema() as {additionalProperties:boolean;required:string[];properties:Record<string,{enum:string[]}>};
 expect(schema.additionalProperties).toBe(false);expect(schema.required.sort()).toEqual(['action','comparison']);
 expect(schema.properties.action!.enum).toEqual([...diagnosticKinds,'CONCLUDE']);
 expect(Buffer.byteLength(context.payload)).toBeLessThan(4500);
});
