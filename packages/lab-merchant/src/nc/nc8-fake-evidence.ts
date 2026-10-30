/** NC8 (one defect): writes an obligation and a "claimed" event that point at an order that does not exist. */
import { randomUUID } from "node:crypto";
import { obligationKeyP1 } from "../../../guard/src/identity.ts";
import { need, type Handler, type MerchantDeps, type HandlerInput, type Path } from "../types.ts";

async function placeOrder(d: MerchantDeps, i: HandlerInput, path: Path) {
  const c = need(d.capability, "capability"), callId = randomUUID(), fakeOrder = `nc8-${randomUUID()}`;
  const key = obligationKeyP1({ paypalEnv: "sandbox", payeeMerchantId: c.payeeMerchantId, captureId: c.captureId, unit: "primary" });
  await d.pool.query(`INSERT INTO ordertruth_guard.obligations (merchant_id, operation_kind, paypal_env, payee_merchant_id, capture_id, intent_id, unit,
      claimed_by_call_id, origin, fingerprint, result_table, result_id, authority, provenance, contract_version, sdk_version, path_id, site_id, build_id)
    VALUES ($1, 'CREATE_ORDER', 'sandbox', $2, $3, $4, 'primary', $5, 'NEW', 'nc8', 'orders', $6, $7, $8, '0.1.0', 'nc8', $9, $10, 'nc8')`,
    [c.merchantId, c.payeeMerchantId, c.captureId, i.intentId, callId, fakeOrder, c.authority, c.provenance, path, `${path}:order-write`]);
  await d.pool.query(`INSERT INTO ordertruth_guard.outbox (event_id, merchant_id, kind, obligation_key, call_id, payload, authority, provenance, contract_version, sdk_version, path_id, build_id)
    VALUES ($1, $2, 'claimed', $3, $4, $5, $6, $7, '0.1.0', 'nc8', $8, 'nc8')`,
    [`nc8-${callId}`, c.merchantId, key, callId, JSON.stringify({ outcome: "CREATED", result: { table: "orders", id: fakeOrder } }), c.authority, c.provenance, path]);
  return { ok: true as const, orderId: fakeOrder, created: true, callId };
}
export const handleCheckoutReturn: Handler = (d, i) => placeOrder(d, i, "checkout_return");
export const handleCaptureWebhook: Handler = (d, i) => placeOrder(d, i, "webhook");
