import {expect,it} from 'vitest';
import {evidenceLabel,hasNewDiagnostics} from '../web/judge/investigation-labels.ts';
import type {InvestigationEvidence} from '../src/ai/investigation.ts';
const merchant:InvestigationEvidence={id:'private-merchant-id',source:'CONTROLLED_MERCHANT_STATE',observedAt:'2026-11-08T00:00:00.000Z',facts:{}};
const diagnostic:InvestigationEvidence={id:'private-diagnostic-id',source:'MERCHANT_DIAGNOSTIC',observedAt:merchant.observedAt,facts:{diagnostic:'HANDLER_TIMING'}};
it('names the actual evidence source without exposing identifiers or inventing a missing citation',()=>{
 expect(evidenceLabel(merchant.id,[merchant])).toBe('Merchant order records');
 expect(evidenceLabel(diagnostic.id,[diagnostic])).toBe('Handler timing check');
 expect(evidenceLabel('unknown',[merchant])).toBe('Evidence reference unavailable');
});
it('distinguishes newly persisted diagnostics from the snapshot already analyzed',()=>{
 expect(hasNewDiagnostics([merchant],[diagnostic])).toBe(true);
 expect(hasNewDiagnostics([merchant,diagnostic],[diagnostic])).toBe(false);
 expect(hasNewDiagnostics([merchant],[])).toBe(false);
});
