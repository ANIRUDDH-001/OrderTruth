/** NC3 (one defect): the "already ordered?" claim is keyed on (intent, path), so each path places its own order. */
import { need, type Handler, type MerchantDeps, type HandlerInput, type Path } from "../types.ts";

async function placeOrder(d: MerchantDeps, i: HandlerInput, path: Path) {
  const capture = need(d.capability, "capability");
  const existing = (await d.pool.query<{ id: string }>("SELECT id FROM shop.orders WHERE intent_id = $1 AND created_by_path = $2 LIMIT 1", [i.intentId, path])).rows[0];
  if (existing) return { ok: true as const, orderId: existing.id, created: false };
  await d.afterCheck();
  const id = (await d.pool.query<{ id: string }>(`INSERT INTO shop.orders (intent_id, paypal_order_id, capture_id, amount_minor, currency, created_by_path)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [i.intentId, capture.paypalOrderId, capture.captureId, capture.amountMinor, capture.currency, path])).rows[0]!.id;
  return { ok: true as const, orderId: id, created: true };
}
export const handleCheckoutReturn: Handler = (d, i) => placeOrder(d, i, "checkout_return");
export const handleCaptureWebhook: Handler = (d, i) => placeOrder(d, i, "webhook");
