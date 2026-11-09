import {expect,it} from 'vitest';
import {prepareComparisonContext,validateComparisonSelection} from '../src/ai/comparison-investigation.ts';
import {pilotCases} from '../src/ai/pilot-cases.ts';
import {deterministicInvestigator} from '../src/ai/investigation.ts';
it('makes every offered comparison a valid evidence-bound read-only plan',()=>{
 for(const c of pilotCases){
  const context=prepareComparisonContext(c.evidence);
  expect(context.choices.length).toBeLessThanOrEqual(15);
  expect(context.choices.every(choice=>choice.status==='AVAILABLE')).toBe(true);
  for(const choice of context.choices){
   const result=validateComparisonSelection({comparison:choice.code},context);
   expect(result.ok,`${c.id}/${choice.code}`).toBe(true);
   if(result.ok){expect(result.investigation.hypotheses).toHaveLength(2);expect(result.investigation.hypotheses.every(h=>h.status==='HYPOTHESIS'&&h.confidence==='LOW')).toBe(true);}
  }
 }
});
it('rejects unsupported selections and additional model-authored instructions',()=>{
 const context=prepareComparisonContext(pilotCases[0]!.evidence);
 for(const value of [{comparison:'P'},{comparison:0},{comparison:'A',refund:true},{comparison:'A',summary:'The payment failed.'}])expect(validateComparisonSelection(value,context).ok).toBe(false);
});
it('omits an exhausted timing comparison and retains contradictory timing for a live comparison',()=>{
 const complete=pilotCases[7]!.evidence;
 expect(prepareComparisonContext(complete).choices).toHaveLength(0);
 const context=prepareComparisonContext(complete.filter(e=>e.facts.diagnostic!=='MERCHANT_WRITE_OUTCOMES'));
 expect(context.choices.some(c=>c.mechanisms.includes('OVERLAPPING_HANDLERS')&&c.mechanisms.includes('SEQUENTIAL_DUPLICATE_WRITES'))).toBe(false);
 const choice=context.choices.find(c=>c.mechanisms.includes('OVERLAPPING_HANDLERS'))!;
 const result=validateComparisonSelection({comparison:choice.code},context);
 expect(result.ok).toBe(true);if(!result.ok)return;
 const i=result.grounded.hypotheses.findIndex(h=>h.mechanism==='OVERLAPPING_HANDLERS');
 expect(result.grounded.hypotheses[i]!.assessment).toBe('WEAKENED');
 expect(result.investigation.hypotheses[i]!.evidenceIds).toContain('synthetic-timing');
 expect(result.grounded.diagnostic.status).toBe('AVAILABLE');
});
it('chooses the check that tests the selected mechanism instead of the baseline default',()=>{
 const evidence=pilotCases[0]!.evidence,context=prepareComparisonContext(evidence);
 const expected={KEY_SCOPE_MISMATCH:'IDEMPOTENCY_KEYS',OVERLAPPING_HANDLERS:'HANDLER_TIMING',MULTIPLE_WRITE_PATHS:'MERCHANT_WRITE_OUTCOMES'};
 let comparisonHits=0,baselineHits=0;
 for(const [mechanism,next] of Object.entries(expected)){
   const choice=context.choices.find(c=>c.mechanisms.some(m=>m===mechanism)&&c.mechanisms.includes('UNKNOWN_CAUSE'))!;
   comparisonHits+=Number(choice?.nextDiagnostic===next);baselineHits+=Number(deterministicInvestigator(evidence).nextDiagnostic===next);
 }
 expect(comparisonHits).toBe(3);expect(baselineHits).toBe(1);
});
