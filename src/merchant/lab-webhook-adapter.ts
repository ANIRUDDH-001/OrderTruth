/**
 * Isolated Phase 2 bridge, deliberately absent from the hosted judge/listener wiring.
 * Its dependencies are trusted local services, never HTTP request fields. A processed
 * event alone is insufficient: the original verified delivery and a matching readback
 * are required. The supplied journal MUST serialize event IDs durably; its transaction/
 * retry contract must account for an uncertain writer commit. Corrected writers must
 * remain capture-idempotent independently of event deduplication.
 */
import type { Handler, HandlerResult, MerchantDeps } from "../../packages/lab-merchant/src/types.ts";
import { verifyCaptureReadback, type OrderReadback } from "../domain/checkout.ts";
import type { Money } from "../domain/money.ts";
import type { EventSummary } from "../webhooks/event.ts";
import type { DeliveryRow, EventRow } from "../webhooks/inbox.ts";
import { eventAgreesWithReadback } from "../webhooks/processor.ts";

export type LabWebhookResult =
  | { outcome: "written"; result: HandlerResult; eventId: string; provenance: "PAYPAL_READBACK" | "MOCK_READBACK" }
  | { outcome: "replay"; eventId: string };

export type LabWebhookDependencies = {
  /** Loads from authenticated intake storage, not from a submitted event body. */
  loadProcessed(eventId: string): Promise<{ event: EventRow; delivery: DeliveryRow } | null>;
  /** Read-only provider GET, or explicitly labelled mock. No financial methods are accepted. */
  readback(orderId: string): Promise<OrderReadback>;
  /** Issues/loads a committed, validated capture capability for exactly this readback. */
  merchantDeps(readback: OrderReadback): Promise<MerchantDeps>;
  /** Atomically excludes concurrent/replayed event IDs; retain successful results across restart. */
  once(eventId: string, write: () => Promise<LabWebhookResult>): Promise<LabWebhookResult>;
  handler: Handler;
};

export function createLabWebhookAdapter(
  scope: {
    paypalEnv: "sandbox";
    apiBase: "https://api-m.sandbox.paypal.com";
    provenance: "PAYPAL_READBACK" | "MOCK_READBACK";
    merchantId: string; payeeMerchantId: string; orderId: string; captureId: string;
    intentId: string; observationId: string; amount: Money;
  },
  deps: LabWebhookDependencies,
) {
  // Snapshot server-owned scope before any asynchronous operation.
  const expected = { ...scope, amount: { ...scope.amount } };
  if (expected.paypalEnv !== "sandbox" || expected.apiBase !== "https://api-m.sandbox.paypal.com") throw new Error("lab webhook: sandbox only");
  if (expected.provenance !== "PAYPAL_READBACK" && expected.provenance !== "MOCK_READBACK") throw new Error("lab webhook: explicit provenance required");
  if (![expected.merchantId, expected.payeeMerchantId, expected.orderId, expected.captureId, expected.intentId, expected.observationId].every((s) => typeof s === "string" && s.trim().length > 0)) throw new Error("lab webhook: incomplete scope");
  if (!Number.isSafeInteger(expected.amount.minor) || expected.amount.minor <= 0) throw new Error("lab webhook: invalid amount");
  return async (eventId: string): Promise<LabWebhookResult> => {
    if (!/^WH-[A-Za-z0-9-]{6,100}$/.test(eventId)) throw new Error("lab webhook: invalid event id");
    return deps.once(eventId, async () => {
      const proof = await deps.loadProcessed(eventId);
      if (!proof || proof.event.event_id !== eventId || proof.event.state !== "processed"
        || proof.delivery.seq !== proof.event.first_delivery_seq || proof.delivery.state !== "verified"
        || proof.delivery.claimed_event_id !== eventId || proof.delivery.reason !== "paypal_postback SUCCESS") throw new Error("lab webhook: verified processing proof required");
      const summary = JSON.parse(proof.event.summary_json) as EventSummary;
      if (summary.id !== eventId || summary.event_type !== "PAYMENT.CAPTURE.COMPLETED"
        || proof.event.event_type !== summary.event_type || summary.resource.status !== "COMPLETED"
        || summary.resource.id !== expected.captureId || summary.resource.order_id !== expected.orderId
        || proof.event.order_id !== expected.orderId
        || (summary.resource.custom_id !== null && summary.resource.custom_id !== expected.intentId)) throw new Error("lab webhook: foreign or ineligible event");
      const raw = await deps.readback(expected.orderId);
      const verdict = verifyCaptureReadback(raw, { orderId: expected.orderId, customId: expected.intentId, amount: expected.amount });
      if (verdict.state !== "captured" || verdict.captureId !== expected.captureId || eventAgreesWithReadback(summary, raw) !== null
        || raw.purchase_units?.[0]?.payee?.merchant_id !== expected.payeeMerchantId) throw new Error("lab webhook: readback mismatch or capture ineligible");
      const merchant = await deps.merchantDeps(raw);
      const c = merchant.capability;
      if (!c || c.paypalEnv !== "sandbox" || c.merchantId !== expected.merchantId || c.payeeMerchantId !== expected.payeeMerchantId
        || c.paypalOrderId !== expected.orderId || c.captureId !== expected.captureId || c.intentId !== expected.intentId
        || c.status !== "COMPLETED" || c.currency !== expected.amount.currency || c.amountMinor !== String(expected.amount.minor)
        || (expected.provenance === "PAYPAL_READBACK" && (c.authority !== "PAYPAL" || c.provenance !== "PAYPAL_READBACK" || c.verificationMethod !== "READBACK"))
        || (expected.provenance === "MOCK_READBACK" && (c.authority !== "TEST" || c.provenance !== "SYNTHETIC_FIXTURE" || c.verificationMethod !== "FIXTURE"))) throw new Error("lab webhook: capability does not match evidence");
      const result = await deps.handler(merchant, { intentId: expected.intentId, observationId: expected.observationId });
      if (!result.ok) throw new Error("lab webhook: merchant writer rejected evidence");
      return { outcome: "written", result, eventId, provenance: expected.provenance };
    });
  };
}
