/** The V-A trusted integration configuration (spec §5.3a). Trusted and manifest-pinned; the Migration Agent may never change it. */
import { REQUIRED_CREATE_ORDER_RETURNS, type GuardConfig } from "../../../guard/src/config.ts";

const IDENTITY = [...REQUIRED_CREATE_ORDER_RETURNS];
export const V_A_CONFIG: GuardConfig = {
  createOrder: {
    sql: "INSERT INTO shop.orders (intent_id, paypal_order_id, capture_id, amount_minor, currency, created_by_path) VALUES ($1, $2, $3, $4, $5, $6) "
      + "RETURNING id, intent_id, paypal_order_id, capture_id, amount_minor::text AS amount_minor, currency",
    params: ["intent.id", "capture.paypalOrderId", "capture.id", "capture.amountMinor", "capture.currency", "path.id"], returns: IDENTITY },
  orderLocator: {
    sql: "SELECT id, intent_id, paypal_order_id, capture_id, amount_minor::text AS amount_minor, currency FROM shop.orders WHERE id = $1",
    params: ["order.id"], returns: IDENTITY },
  intentLocator: {
    sql: "SELECT id, sku, currency, amount_minor::text AS amount_minor, line_items FROM shop.intents WHERE id = $1",
    params: ["intent.id"], returns: ["id", "sku", "currency", "amount_minor", "line_items"] },
  singleTenantMerchantSchema: true,
  sites: [{ siteId: "checkout_return:order-write", pathId: "checkout_return" }, { siteId: "webhook:order-write", pathId: "webhook" }],
};
