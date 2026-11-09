import type {AttemptRow,IntentRow} from '../db/store.ts';
import {readbackFact,type PaymentFacts,type ReadbackFact} from './contract.ts';

export type PaymentObservation = {seq:number;evidence_class:string;operation:string;http_status:number|null;created_at:string;summary_json:string};
export function isPaymentObservation(row:PaymentObservation):boolean {
  return row.evidence_class==='PAYPAL_API_READBACK'||(row.evidence_class==='PAYPAL_API_RESPONSE'&&['readback','readback_error','webhook_readback'].includes(row.operation));
}

/** A failed, refused or malformed latest observation must not select an older capture. */
export function completedObservation(row:PaymentObservation|undefined) {
  if(row?.evidence_class!=='PAYPAL_API_READBACK'||row.http_status!==200)return null;
  try {
    const summary=JSON.parse(row.summary_json) as {provenance?:unknown;webhookAgreement?:unknown};
    if(!summary||!(summary.provenance==='PAYPAL_SANDBOX_GET'||summary.provenance==='SYNTHETIC_QUALIFICATION')
      ||(summary.webhookAgreement!==undefined&&summary.webhookAgreement!=='AGREES'))return null;
    const fact=readbackFact(row);
    return fact.orderStatus==='COMPLETED'?{fact,provenance:summary.provenance}:null;
  }catch{return null;}
}

export function capturedPaymentFacts(intent:IntentRow,attempt:AttemptRow,readbacks:ReadbackFact[]=[]):PaymentFacts {
  return {intentId:intent.id,intentSku:intent.sku,intentCurrency:intent.currency,intentMinor:intent.amount_minor,
    attemptId:attempt.id,attemptState:attempt.state,paypalOrderId:attempt.paypal_order_id,captureId:attempt.capture_id,
    captureStatus:attempt.capture_status,capturedMinor:attempt.captured_minor,capturedCurrency:attempt.captured_currency,readbacks};
}
