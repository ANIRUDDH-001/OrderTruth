import {expect,it} from 'vitest';
import {ownerOutcome,mayApplyPresentationEvent} from '../web/owner-state.ts';
const captured={state:'captured',captureId:'SYNTHETICCAPTURE',captureStatus:'COMPLETED',amount:{currency:'USD',value:'1.00'},reasons:['capture COMPLETED; amount, currency and order id match intent']};
it('requires matching authoritative capture fields before showing a verified payment',()=>{
 expect(ownerOutcome(captured).kind).toBe('verified');
 for(const changed of [{captureId:null},{captureStatus:'PENDING'},{amount:{currency:'EUR',value:'1.00'}},{amount:{currency:'USD',value:'2.00'}},{amount:null}])expect(ownerOutcome({...captured,...changed}).kind).toBe('review');
});
it('retains an accepted capture without painting conflicting newer evidence green',()=>{
 for(const reasons of [['Conflicting provider observation; accepted capture identity retained. Investigation required.'],[],undefined,['unexpected finding']]){
  const outcome=ownerOutcome({...captured,reasons});expect(outcome.kind).toBe('review');expect(outcome.canStartAnother).toBe(false);
 }
});
it('does not let late SDK presentation events replace authoritative outcomes',()=>{
 for(const response of [captured,{...captured,reasons:['Investigation required.']},{state:'pending'},{state:'uncertain'}])expect(mayApplyPresentationEvent(ownerOutcome(response),false)).toBe(false);
 expect(mayApplyPresentationEvent(null,false)).toBe(true);
 expect(mayApplyPresentationEvent(ownerOutcome({state:'awaiting_buyer_approval'}),false)).toBe(true);
 expect(mayApplyPresentationEvent(null,true)).toBe(false);
});
it('does not mistake pending, uncertain, malformed or unknown responses for failure or capture',()=>{
 for(const state of ['pending','uncertain','capture_in_progress']){const outcome=ownerOutcome({state});expect(outcome.kind).toBe('pending');expect(outcome.canStartAnother).toBe(false);}
 for(const response of [null,{},'captured',{state:'new_provider_state'}])expect(ownerOutcome(response).kind).toBe('review');
});
it('keeps preapproval recovery distinct from an uncertain capture',()=>{
 expect(ownerOutcome({state:'awaiting_buyer_approval'}).kind).toBe('approval');
 expect(ownerOutcome({state:'approved'}).kind).toBe('approval');
 expect(ownerOutcome({state:'uncertain'}).detail).toContain('Do not pay again');
});
