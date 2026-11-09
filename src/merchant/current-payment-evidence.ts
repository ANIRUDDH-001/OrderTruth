import type {AttemptRow,IntentRow} from '../db/store.ts';
import {evaluateContract,readbackFact,type PaymentFacts,type ReadbackFact} from './contract.ts';
import {parseProviderValue} from '../domain/money.ts';

export type PaymentObservation = {seq:number;evidence_class:string;operation:string;http_status:number|null;created_at:string;summary_json:string};
export function isPaymentObservation(row:PaymentObservation):boolean {
  return row.evidence_class==='PAYPAL_API_READBACK'||(row.evidence_class==='PAYPAL_API_RESPONSE'&&['readback','readback_error','webhook_readback'].includes(row.operation));
}

export function providerObservation(row:PaymentObservation|undefined) {
  if(row?.evidence_class!=='PAYPAL_API_READBACK'||row.http_status!==200)return null;
  try {
    const summary=JSON.parse(row.summary_json) as {provenance?:unknown;webhookAgreement?:unknown;intent?:unknown;
      purchase_units?: Array<{amount?:{currency_code?:unknown;value?:unknown}|null}>};
    if(!summary||!(summary.provenance==='PAYPAL_SANDBOX_GET'||summary.provenance==='SYNTHETIC_QUALIFICATION'))return null;
    const fact=readbackFact(row);
    if (!fact.orderId || !fact.orderStatus) return null;
    const amount = Array.isArray(summary.purchase_units) ? summary.purchase_units[0]?.amount : null;
    const total = typeof amount?.currency_code === 'string' && typeof amount.value === 'string'
      ? parseProviderValue(amount.value, amount.currency_code) : null;
    return {fact,total,intentType:summary.intent,provenance:summary.provenance,agrees:summary.webhookAgreement===undefined||summary.webhookAgreement==='AGREES'};
  }catch{return null;}
}

/** A failed, refused or malformed latest observation must not select an older capture. */
export function completedObservation(row:PaymentObservation|undefined) {
  const observation = providerObservation(row);
  return observation?.agrees && observation.fact.orderStatus === 'COMPLETED' ? observation : null;
}

export function capturedPaymentFacts(intent:IntentRow,attempt:AttemptRow,readbacks:ReadbackFact[]=[]):PaymentFacts {
  return {intentId:intent.id,intentSku:intent.sku,intentCurrency:intent.currency,intentMinor:intent.amount_minor,
    attemptId:attempt.id,attemptState:attempt.state,paypalOrderId:attempt.paypal_order_id,captureId:attempt.capture_id,
    captureStatus:attempt.capture_status,capturedMinor:attempt.captured_minor,capturedCurrency:attempt.captured_currency,readbacks};
}

export function confirmsCapturedPayment(intent:IntentRow, attempt:AttemptRow, observation: NonNullable<ReturnType<typeof providerObservation>>): boolean {
  // A matching capture amount alone cannot override a different order total or intent.
  return observation.agrees && observation.fact.orderStatus === 'COMPLETED'
    && (observation.intentType == null || observation.intentType === 'CAPTURE')
    && observation.total?.minor === intent.amount_minor && observation.total.currency === intent.currency
    && evaluateContract(capturedPaymentFacts(intent,attempt,[observation.fact]),[]).eligible;
}
