/** NC6 (one defect): always presents the SYN-CAP-1 capability, whatever the intent. */
import { fromGuard, need, type Handler, type MerchantDeps, type HandlerInput, type Path } from "../types.ts";

async function placeOrder(d: MerchantDeps, i: HandlerInput, path: Path) {
  await d.afterCheck();
  const capture = await need(d.issue, "issue")("SYN-OBS-1");
  return fromGuard(await need(d.guard, "guard").createOrderOnce({ capture, intentId: i.intentId, pathId: path, siteId: `${path}:order-write` }));
}
export const handleCheckoutReturn: Handler = (d, i) => placeOrder(d, i, "checkout_return");
export const handleCaptureWebhook: Handler = (d, i) => placeOrder(d, i, "webhook");
