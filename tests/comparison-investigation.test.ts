import {expect,it} from 'vitest';
import {prepareComparisonContext,validateComparisonSelection} from '../src/ai/comparison-investigation.ts';
import {pilotCases} from '../src/ai/pilot-cases.ts';
it('makes every offered comparison a valid evidence-bound read-only plan',()=>{
 for(const c of pilotCases){
  const context=prepareComparisonContext(c.evidence);
  expect(context.choices).toHaveLength(15);
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
it('retains contradictory timing and identifies exhausted diagnostics independently',()=>{
 const context=prepareComparisonContext(pilotCases[7]!.evidence);
 const choice=context.choices.find(c=>c.mechanisms.includes('OVERLAPPING_HANDLERS')&&c.mechanisms.includes('SEQUENTIAL_DUPLICATE_WRITES'))!;
 expect(choice.status).toBe('EXHAUSTED');
 const result=validateComparisonSelection({comparison:choice.code},context);
 expect(result.ok).toBe(true);if(!result.ok)return;
 expect(result.grounded.hypotheses[0]!.assessment).toBe('WEAKENED');
 expect(result.investigation.hypotheses[0]!.evidenceIds).toContain('synthetic-timing');
 expect(result.investigation.diagnosticReason).toContain('no additional diagnostic');
});
