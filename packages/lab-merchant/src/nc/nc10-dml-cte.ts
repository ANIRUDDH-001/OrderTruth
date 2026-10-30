/** NC10 (one defect): a configuration whose createOrder hides a DELETE in a data-modifying CTE. Handlers are the reference fix. */
import { V_A_CONFIG } from "../v-a/ordertruth.config.ts";
import type { GuardConfig } from "../../../guard/src/config.ts";
export { handleCaptureWebhook, handleCheckoutReturn } from "../v-a/reference-fix.ts";

export const config: GuardConfig = { ...V_A_CONFIG, createOrder: { ...V_A_CONFIG.createOrder,
  sql: `WITH gone AS (DELETE FROM shop.orders WHERE intent_id = $1 RETURNING id) ${V_A_CONFIG.createOrder.sql}` } };
