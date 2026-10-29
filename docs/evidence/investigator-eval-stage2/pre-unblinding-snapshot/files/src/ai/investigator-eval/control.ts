/**
 * Arm C: a deterministic control that applies ONLY the reasoning rules written in the investigator's
 * system instruction (src/ai/investigation.ts), with no model. Frozen in
 * docs/INVESTIGATOR_EVAL_PREREGISTRATION.md §4. Never copies evidence text into its output.
 */
import type { DiagnosticKind, Investigation, InvestigationEvidence } from "../investigation.ts";

type Level = "LOW" | "MEDIUM" | "HIGH";
const up = (l: Level, cap: Level): Level => { const order: Level[] = ["LOW", "MEDIUM", "HIGH"]; return order[Math.min(order.indexOf(l) + 1, order.indexOf(cap))]!; };
const ORDER: DiagnosticKind[] = ["HANDLER_TIMING", "IDEMPOTENCY_KEYS", "MERCHANT_WRITE_OUTCOMES"];
const REASON: Record<DiagnosticKind, string> = {
  HANDLER_TIMING: "Handler intervals distinguish overlapping concurrent writes from sequential duplicate writes.",
  IDEMPOTENCY_KEYS: "Write identities show whether a shared deduplication key could have blocked the duplicate.",
  MERCHANT_WRITE_OUTCOMES: "Committed write outcomes show which handler paths wrote orders; no unperformed diagnostic remains to separate the mechanisms further.",
};

export function promptRulesControl(evidence: readonly InvestigationEvidence[]): Investigation {
  const payment = evidence.find(e => e.source === "PAYPAL_SANDBOX_OBSERVATION" || e.source === "SYNTHETIC_PAYMENT_OBSERVATION");
  const state = evidence.find(e => e.source === "CONTROLLED_MERCHANT_STATE");
  const diag = (kind: DiagnosticKind) => evidence.find(e => e.source === "MERCHANT_DIAGNOSTIC" && e.facts.diagnostic === kind);
  const keys = diag("IDEMPOTENCY_KEYS"), timing = diag("HANDLER_TIMING"), writes = diag("MERCHANT_WRITE_OUTCOMES");
  const performed = [keys, timing, writes].filter((d): d is InvestigationEvidence => !!d);
  const orders = Array.isArray(state?.facts.orders) ? state.facts.orders as Array<{ status?: unknown }> : [];
  const active = typeof state?.facts.activeOrders === "number" ? state.facts.activeOrders : 0;
  const placed = orders.filter(o => o.status === "placed").length;
  const voided = orders.some(o => o.status === "voided_duplicate");
  const inconsistent = !!state && active !== placed;
  const base = [payment?.id, state?.id].filter((x): x is string => !!x);
  const next = ORDER.find(k => !diag(k)) ?? "MERCHANT_WRITE_OUTCOMES";
  const caveats = [!payment ? "No payment observation is present, so a completed capture is not established." : "",
    inconsistent ? "The merchant state is inconsistent: the active-order count differs from the listed placed orders." : ""].filter(Boolean);
  const cap = (h: Investigation["hypotheses"]) => caveats.length ? h.map(x => ({ ...x, confidence: "LOW" as const })) : h;

  if (active <= 1) {
    const cites = voided ? [...base, ...performed.map(d => d.id)] : base;
    return { summary: ["The current merchant state does not show an active duplicate order.", ...caveats].join(" "),
      hypotheses: cap([{ explanation: `The current merchant state does not show an active duplicate.${voided ? " A voided duplicate is recorded; the diagnostics present may explain its history." : ""}`,
        evidenceIds: cites.length ? cites : [evidence[0]!.id], confidence: "LOW", status: "HYPOTHESIS" }]),
      nextDiagnostic: next, diagnosticReason: REASON[next] };
  }
  let race: Level = "LOW", seq: Level = "LOW";
  const distinct = typeof keys?.facts.distinctKeys === "number" ? keys.facts.distinctKeys : null;
  if (distinct !== null && distinct >= 2) seq = "MEDIUM";
  if (distinct === 1) race = "MEDIUM";
  let timingNote = "";
  if (timing && Array.isArray(timing.facts.entries)) {
    const spans = (timing.facts.entries as Array<{ startedAt?: unknown; finishedAt?: unknown }>).map(e => [Date.parse(String(e.startedAt)), Date.parse(String(e.finishedAt))] as const);
    const overlap = spans.some((a, i) => spans.some((b, j) => i < j && a[0] < b[1] && b[0] < a[1]));
    if (overlap) { race = "MEDIUM"; timingNote = "Recorded handler intervals overlap."; }
    else { race = "LOW"; seq = up(seq, distinct !== null && distinct >= 2 ? "HIGH" : "MEDIUM"); timingNote = "Recorded handler intervals are disjoint, which weakens a concurrency explanation."; }
  }
  const handlerNames = writes && Array.isArray(writes.facts.entries) ? new Set((writes.facts.entries as Array<{ handler?: unknown }>).map(e => String(e.handler))).size : 0;
  const cites = [...base, ...performed.map(d => d.id)];
  const summary = [`${active} active merchant orders reference one payment observation.`,
    distinct !== null ? `The key diagnostic records ${distinct} distinct merchant write ${distinct === 1 ? "identity" : "identities"}.` : "",
    timingNote, handlerNames >= 2 ? `Committed writes came from ${handlerNames} distinct handler paths.` : "", ...caveats].filter(Boolean).join(" ");
  return { summary,
    hypotheses: cap([
      { explanation: "Concurrent merchant handlers may each have passed the existence check before either wrote, producing duplicate orders.", evidenceIds: cites, confidence: race, status: "HYPOTHESIS" },
      { explanation: "Sequential merchant handlers may have written duplicate orders because their distinct write identities bypassed a shared deduplication boundary.", evidenceIds: cites, confidence: seq, status: "HYPOTHESIS" },
    ]),
    nextDiagnostic: next, diagnosticReason: REASON[next] };
}
