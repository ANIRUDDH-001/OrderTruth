/** NC2 (one defect): reports success and never writes an order. */
import type { Handler } from "../types.ts";

const suppress: Handler = async () => ({ ok: true, orderId: "nc2-no-order", created: true });
export const handleCheckoutReturn: Handler = suppress;
export const handleCaptureWebhook: Handler = suppress;
