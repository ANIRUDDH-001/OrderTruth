/** The lab merchant's handler contract (plan Task 8). Every candidate module exports handleCheckoutReturn and handleCaptureWebhook. */
import type pg from "pg";
import type { CaptureCapability } from "../../guard/src/capability.ts";
import type { CreateOrderResult, Guard } from "../../guard/src/guard.ts";

export type MerchantDeps = { pool: pg.Pool; afterCheck: () => Promise<void>; guard?: Guard; capability?: CaptureCapability;
  /** Issues another fixture capability (only NC6 uses it, to reuse SYN-CAP-1 everywhere). */
  issue?: (observationId: string) => Promise<CaptureCapability> };
export type HandlerInput = { intentId: string; observationId: string };
export type HandlerResult = { ok: true; orderId: string; created: boolean; guardOutcome?: CreateOrderResult["outcome"]; callId?: string }
  | { ok: false; error: string; code?: string; guardOutcome?: CreateOrderResult["outcome"]; callId?: string };
export type Handler = (d: MerchantDeps, i: HandlerInput) => Promise<HandlerResult>;
export type Path = "checkout_return" | "webhook";

/** Maps a guard result to the handler contract; only CREATED and REUSED yield an order. */
export function fromGuard(r: CreateOrderResult): HandlerResult {
  if ((r.outcome === "CREATED" || r.outcome === "REUSED") && r.result)
    return { ok: true, orderId: r.result.id, created: r.outcome === "CREATED", guardOutcome: r.outcome, callId: r.callId };
  return { ok: false, error: `${r.outcome}${r.reason ? `: ${r.reason}` : ""}`, code: r.reason ?? r.outcome, guardOutcome: r.outcome, callId: r.callId };
}
export const need = <T>(v: T | undefined, what: string): T => { if (v === undefined) throw new Error(`lab merchant: ${what} is required`); return v; };
