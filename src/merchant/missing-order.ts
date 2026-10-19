import { evaluateContract, type Evaluation, type PaymentFacts, type ReadbackFact } from "./contract.ts";

export const MISSING_INCIDENT_CLASS = "MISSING_MERCHANT_ORDER";
export const DEFAULT_MISSING_ORDER_GRACE_MS = 300_000;

export type MissingOrderTiming = {
  graceMs: number;
  observedAt: string;
  confirmedAt: string | null;
  dueAt: string | null;
  anchorReadbackSeq: number | null;
};

/** Pure, conservative missing-order rule. Never substitutes a webhook for GET readback.
 * Grace begins at the first locally persisted confirmation in the newest uninterrupted run of
 * confirmations, NOT provider update_time, intent age, check time, or mutable attempt.updated_at.
 * A newer failure, empty readback or contradiction suppresses detection and restarts that run.
 */
export function assessMissingOrder(p: PaymentFacts, base: Evaluation, nowMs: number, graceMs: number): { evaluation: Evaluation; timing: MissingOrderTiming; violated: boolean } {
  const timing: MissingOrderTiming = { graceMs, observedAt: new Date(nowMs).toISOString(), confirmedAt: null, dueAt: null, anchorReadbackSeq: null };
  const out = (evaluation: Evaluation, violated = false) => ({ evaluation, timing, violated });
  // Mismatched placed orders are ambiguous and remain OUT_OF_SCOPE. Duplicates stay unchanged.
  if (!base.eligible || base.activeOrderCount !== 0) return out(base);
  const confirms = (r: ReadbackFact) => r.orderStatus === "COMPLETED" && evaluateContract({ ...p, readbacks: [r] }, []).eligible;
  const rows = [...p.readbacks].sort((a, b) => a.seq - b.seq);
  const newest = rows.at(-1);
  const lastFailureSeq = Math.max(0, ...(p.readbackFailures ?? []).map(r => r.seq));
  const refuse = (why: string) => out({ ...base, result: "NOT_ELIGIBLE", eligible: false, confirmingReadbackSeqs: [], reasons: [why] });
  if (!p.attemptId || !p.paypalOrderId || !p.captureId) return refuse("missing-order eligibility requires nonempty local attempt, order and capture identities");
  if (!newest || newest.seq < lastFailureSeq || !confirms(newest)) return refuse("missing-order eligibility requires the newest persisted readback to confirm the completed order and capture without a later failed refresh");
  let start = rows.length - 1;
  while (start > 0 && rows[start - 1]!.seq > lastFailureSeq && confirms(rows[start - 1]!)) start--;
  const continuous = rows.slice(start);
  let previous = -Infinity;
  for (const row of continuous) {
    const ms = Date.parse(row.createdAt);
    if (!Number.isFinite(ms) || new Date(ms).toISOString() !== row.createdAt || ms > nowMs || ms < previous) return refuse("missing-order confirmation timestamps are invalid, future or non-monotonic; grace cannot be established");
    previous = ms;
  }
  const anchor = continuous[0]!;
  const dueMs = Date.parse(anchor.createdAt) + graceMs;
  if (!Number.isSafeInteger(dueMs) || !Number.isFinite(new Date(dueMs).getTime())) return refuse("missing-order grace deadline is outside the supported timestamp range");
  timing.confirmedAt = anchor.createdAt;
  timing.dueAt = new Date(dueMs).toISOString();
  timing.anchorReadbackSeq = anchor.seq;
  const violated = nowMs >= dueMs;
  return out({ ...base, result: violated ? "VIOLATED" : "OUT_OF_SCOPE", confirmingReadbackSeqs: continuous.map(r => r.seq), reasons: [
    `completed capture ${p.captureId} confirmed by persisted readback evidence ${continuous.map(r => r.seq).join(", ")}`,
    violated ? `zero matching effective merchant orders after grace deadline ${timing.dueAt}` : `waiting for merchant order; grace expires at ${timing.dueAt}`,
  ] }, violated);
}
