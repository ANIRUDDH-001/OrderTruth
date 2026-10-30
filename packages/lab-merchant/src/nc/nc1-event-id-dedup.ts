/** NC1 (one defect): dedups on the delivery's event ID only. The return and the webhook carry different event IDs, so both order. */
import { need, type Handler, type MerchantDeps, type HandlerInput, type Path } from "../types.ts";

async function placeOrder(d: MerchantDeps, i: HandlerInput, path: Path) {
  const capture = need(d.capability, "capability");
  const fresh = (await d.pool.query("INSERT INTO shop.processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id", [`${path}:${i.observationId}`])).rowCount === 1;
  if (!fresh) {
    const existing = (await d.pool.query<{ id: string }>("SELECT id FROM shop.orders WHERE intent_id = $1 AND created_by_path = $2 LIMIT 1", [i.intentId, path])).rows[0];
    if (existing) return { ok: true as const, orderId: existing.id, created: false };
  }
  await d.afterCheck();
  const id = (await d.pool.query<{ id: string }>(`INSERT INTO shop.orders (intent_id, paypal_order_id, capture_id, amount_minor, currency, created_by_path)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [i.intentId, capture.paypalOrderId, capture.captureId, capture.amountMinor, capture.currency, path])).rows[0]!.id;
  return { ok: true as const, orderId: id, created: true };
}
export const handleCheckoutReturn: Handler = (d, i) => placeOrder(d, i, "checkout_return");
export const handleCaptureWebhook: Handler = (d, i) => placeOrder(d, i, "webhook");
