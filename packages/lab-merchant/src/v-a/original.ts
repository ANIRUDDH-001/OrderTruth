/**
 * V-A original (REF-BUG-1, as src/merchant/reference-merchant.ts): "already ordered?" is a read, then an await, then an
 * insert, with no unique key on intent_id. Two calls whose checks both finish before either insert create two orders.
 */
import { need, type Handler, type MerchantDeps, type HandlerInput, type Path } from "../types.ts";

async function placeOrder(d: MerchantDeps, i: HandlerInput, path: Path) {
  const capture = need(d.capability, "capability");
  const existing = (await d.pool.query<{ id: string }>("SELECT id FROM shop.orders WHERE intent_id = $1 ORDER BY created_at LIMIT 1", [i.intentId])).rows[0];
  if (existing) return { ok: true as const, orderId: existing.id, created: false };
  await d.afterCheck();
  const id = (await d.pool.query<{ id: string }>(`INSERT INTO shop.orders (intent_id, paypal_order_id, capture_id, amount_minor, currency, created_by_path)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [i.intentId, capture.paypalOrderId, capture.captureId, capture.amountMinor, capture.currency, path])).rows[0]!.id;
  return { ok: true as const, orderId: id, created: true };
}
export const handleCheckoutReturn: Handler = (d, i) => placeOrder(d, i, "checkout_return");
export const handleCaptureWebhook: Handler = (d, i) => placeOrder(d, i, "webhook");
