import type { EvidenceItem, IncidentClass, Scenario } from "./scenarios.ts";

export type BaselineResult = { incidentClass: IncidentClass; evidenceIds: string[]; rule: string };

/**
 * Deterministic, no-LLM rules. This is the authority for incident classification; AI output
 * is compared against it and never overrides it. Operator statements are ignored as facts.
 */
export function classifyBaseline(s: Scenario): BaselineResult {
  const trusted = (e: EvidenceItem) => e.cls === "PAYPAL_API_READBACK" || e.cls === "PAYPAL_VERIFIED_WEBHOOK" || e.cls === "MERCHANT_DB_OBSERVED";
  const ev = s.evidence.filter(trusted);
  const captures = ev.filter((e) => e.cls === "PAYPAL_API_READBACK" && e.fact.kind === "capture");
  if (captures.length !== 1) return { incidentClass: "INSUFFICIENT_EVIDENCE", evidenceIds: captures.map((c) => c.id), rule: "R0: exactly one capture readback required" };
  const capture = captures[0]!;
  const ref = capture.fact.paypal_order_ref;
  const orders = ev.filter((e) => e.fact.kind === "merchant_order_created" && e.fact.paypal_order_ref === ref);
  const fulfilled = ev.filter((e) => e.fact.kind === "fulfillment" && orders.some((o) => o.fact.merchant_order_id === e.fact.merchant_order_id));

  if (capture.fact.capture_status !== "COMPLETED") {
    if (fulfilled.length > 0) return { incidentClass: "FULFILLED_WITHOUT_CAPTURE", evidenceIds: [capture.id, ...fulfilled.map((f) => f.id)], rule: "R3: fulfillment while capture not COMPLETED" };
    return { incidentClass: "HEALTHY", evidenceIds: [capture.id], rule: "R3b: capture not complete, no fulfillment" };
  }
  if (orders.length > 1) return { incidentClass: "DUPLICATE_MERCHANT_ORDER", evidenceIds: [capture.id, ...orders.map((o) => o.id)], rule: "R1: >1 merchant order for one captured PayPal order" };
  if (orders.length === 1) return { incidentClass: "HEALTHY", evidenceIds: [capture.id, orders[0]!.id], rule: "R2: exactly one merchant order for one capture" };
  const elapsed = (Date.parse(s.observedAt) - Date.parse(capture.at)) / 1000;
  if (elapsed <= s.graceSeconds) return { incidentClass: "WITHIN_GRACE_PERIOD", evidenceIds: [capture.id], rule: `R4: no order yet, ${elapsed}s <= grace ${s.graceSeconds}s` };
  return { incidentClass: "MISSING_MERCHANT_ORDER", evidenceIds: [capture.id], rule: `R5: no order after ${elapsed}s > grace ${s.graceSeconds}s` };
}
