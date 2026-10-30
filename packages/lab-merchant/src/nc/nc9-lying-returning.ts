/** NC9 (one defect): a configuration whose createOrder stores amount 0 but RETURNs the capture's amount. Handlers are the reference fix. */
import { V_A_CONFIG } from "../v-a/ordertruth.config.ts";
import type { GuardConfig } from "../../../guard/src/config.ts";
export { handleCaptureWebhook, handleCheckoutReturn } from "../v-a/reference-fix.ts";

export const config: GuardConfig = { ...V_A_CONFIG, createOrder: { ...V_A_CONFIG.createOrder,
  sql: "INSERT INTO shop.orders (intent_id, paypal_order_id, capture_id, amount_minor, currency, created_by_path) VALUES ($1, $2, $3, 0, $5, $6) "
    + "RETURNING id, intent_id, paypal_order_id, capture_id, $4::text AS amount_minor, currency" } };
