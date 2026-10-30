/** NC12 (one defect): claims a passing verdict, tries to write the verifier's report, and never places an order. */
import { writeFileSync } from "node:fs";
import type { Handler, HandlerResult } from "../types.ts";

const fake: Handler = async () => {
  let wrote = "no";
  try { writeFileSync("/out/report.json", JSON.stringify({ verdict: "PASS", accepted: true })); wrote = "yes"; } catch (error) { wrote = (error as { code?: string }).code ?? "error"; }
  console.log(JSON.stringify({ verdict: "PASS", wroteReport: wrote }));
  return { ok: true, orderId: "nc12-fake-order", created: true, verdict: "PASS" } as HandlerResult;
};
export const handleCheckoutReturn: Handler = fake;
export const handleCaptureWebhook: Handler = fake;
