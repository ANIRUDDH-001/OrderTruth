export type OwnerOutcome={kind:'verified'|'pending'|'approval'|'review';heading:string;detail:string;canStartAnother:boolean};
/** SDK presentation events do not override an authoritative or uncertain
 * payment outcome, even after the capture callback has finished. */
export function mayApplyPresentationEvent(previous:OwnerOutcome|null,captureBusy:boolean):boolean{
 return !captureBusy&&(!previous||previous.kind==='approval');
}
/** This reference checkout is USD1.00. Malformed or contradictory responses
 * never become a green receipt, even when their top-level state says captured. */
export function ownerOutcome(raw:unknown):OwnerOutcome{
 const value=raw&&typeof raw==='object'?raw as Record<string,unknown>:{};
 const amount=value.amount&&typeof value.amount==='object'?value.amount as Record<string,unknown>:{};
 // The store preserves accepted capture fields after a contradictory newer
 // observation. Require its positive verdict too; unfamiliar reasons fail closed.
 const positiveVerdict=Array.isArray(value.reasons)&&value.reasons.length===1&&value.reasons[0]==='capture COMPLETED; amount, currency and order id match intent';
 if(value.state==='captured'&&positiveVerdict&&value.captureStatus==='COMPLETED'&&typeof value.captureId==='string'&&/^[A-Za-z0-9]{1,64}$/.test(value.captureId)&&amount.currency==='USD'&&amount.value==='1.00')return {
  kind:'verified',heading:'Sandbox payment verified',detail:'The server verified a completed USD1.00 capture against authoritative PayPal readback. This is Sandbox evidence, not real money.',canStartAnother:true};
 if(['pending','uncertain','capture_in_progress'].includes(String(value.state)))return {kind:'pending',heading:'Payment outcome needs confirmation',detail:'Do not pay again. Recheck PayPal evidence before deciding what happened; a timeout or interruption does not prove rollback.',canStartAnother:false};
 if(['created','awaiting_buyer_approval','approved'].includes(String(value.state)))return {kind:'approval',heading:value.state==='approved'?'Buyer approval recorded':'Buyer approval is still needed',detail:'This state does not establish a completed capture. Continue only through the same Sandbox checkout.',canStartAnother:false};
 return {kind:'review',heading:'Payment evidence needs review',detail:'A completed matching capture is not established by this response. Keep this checkout and recheck its evidence before paying again.',canStartAnother:false};
}
