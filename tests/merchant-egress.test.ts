import {expect,it} from 'vitest';
import {prepareMerchantEvidenceEgress,prepareEvidenceEgress} from '../src/ai/evidence-egress.ts';
import type {InvestigationEvidence} from '../src/ai/investigation.ts';
const payment:InvestigationEvidence={id:'private-provider-evidence',source:'PAYPAL_SANDBOX_OBSERVATION',observedAt:'2026-10-21T14:14:17.000Z',facts:{orderStatus:'COMPLETED',purchaseUnits:[{amount:{currency_code:'USD',value:'12345.67'},captures:[{status:'COMPLETED',amount:{currency_code:'USD',value:'12345.67'}}]}]}};
const merchant:InvestigationEvidence={id:'private-merchant-evidence',source:'CONTROLLED_MERCHANT_STATE',observedAt:'2026-11-08T01:02:03.000Z',facts:{activeOrders:1,orders:[{id:'private-merchant-order',status:'placed',amountMinor:1234567,currency:'USD'}],providerMutation:false}};
it('keeps all provider facts private while projecting only controlled merchant relations',()=>{
 const result=prepareMerchantEvidenceEgress([payment,merchant]);
 const payload=JSON.parse(result.payload);
 expect(payload.evidence).toHaveLength(1);expect(payload.evidence[0].source).toBe('CONTROLLED_MERCHANT_STATE');
 expect(payload.evidence[0].facts.activeOrders).toBe(1);
 for(const value of ['PAYPAL_SANDBOX_OBSERVATION','COMPLETED','USD','12345.67','1234567','private-provider-evidence','private-merchant-evidence','private-merchant-order','2026-10-21','2026-11-08'])expect(result.payload).not.toContain(value);
 expect([...result.citationMap.values()]).toEqual(['private-merchant-evidence']);
 expect(()=>prepareEvidenceEgress([payment,merchant])).toThrow('AI_EGRESS_REJECTED');
});
it('validates all private records before omitting provider observations',()=>{
 expect(()=>prepareMerchantEvidenceEgress([{...payment,facts:{...payment.facts,email:'synthetic@example.test'}},merchant])).toThrow('AI_EGRESS_REJECTED');
 expect(()=>prepareMerchantEvidenceEgress([payment])).toThrow('AI_EGRESS_REJECTED');
 expect(()=>prepareMerchantEvidenceEgress([payment,{...merchant,id:payment.id}])).toThrow('AI_EGRESS_REJECTED');
});
it('issues unrelated citation and order references on every request',()=>{
 const first=prepareMerchantEvidenceEgress([payment,merchant]),second=prepareMerchantEvidenceEgress([payment,merchant]);
 expect(first.payload).not.toBe(second.payload);
 expect([...first.citationMap.values()]).toEqual([...second.citationMap.values()]);
});
