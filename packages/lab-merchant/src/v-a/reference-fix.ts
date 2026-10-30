/** V-A reference fix (human-written): the same barrier point, then the guard's one claimed obligation per capture. */
import { fromGuard, need, type Handler, type MerchantDeps, type HandlerInput, type Path } from "../types.ts";

export async function placeOrderOnce(d: MerchantDeps, i: HandlerInput, path: Path) {
  await d.afterCheck();
  return fromGuard(await need(d.guard, "guard").createOrderOnce({ capture: need(d.capability, "capability"), intentId: i.intentId, pathId: path, siteId: `${path}:order-write` }));
}
export const handleCheckoutReturn: Handler = (d, i) => placeOrderOnce(d, i, "checkout_return");
export const handleCaptureWebhook: Handler = (d, i) => placeOrderOnce(d, i, "webhook");
