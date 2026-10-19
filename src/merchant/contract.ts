import { parseProviderValue } from "../domain/money.ts";

/**
 * Reference merchant contract (Stage 1C), deterministic and AI-free:
 *
 *   An ELIGIBLE checkout intent (its single payment attempt is locally `captured` with a COMPLETED
 *   capture, AND the newest authoritative PayPal GET readback that shows any capture confirms that
 *   same capture COMPLETED for the intent's server-owned amount) must yield EXACTLY ONE active local
 *   merchant order that MATCHES the captured payment: same payment attempt, PayPal order id,
 *   capture id, SKU, currency and amount (integer minor units). Two or more matching orders is a
 *   violation (DUPLICATE_MERCHANT_ORDER).
 *
 * This base evaluator retains Stage 1C duplicate semantics. Gate 2B separately evaluates zero
 * effective orders with stricter current-readback eligibility and a persisted-time grace period. Any
 * placed order that does not match the capture (unless two matching orders already prove the
 * duplicate), or orders for a non-eligible intent, are recorded as OUT_OF_SCOPE with explicit
 * reasons (no incident class exists for them yet) rather than treated as healthy or accused.
 */
export const CONTRACT_ID = "REF_MERCHANT_ONE_CAPTURE_ONE_ORDER_V1";
export const INCIDENT_CLASS = "DUPLICATE_MERCHANT_ORDER";
/** A duplicate order for money already captured risks double fulfilment: fixed rule, not a model. */
export const DUPLICATE_SEVERITY = "high";

export type EvaluationResult = "HOLDS" | "VIOLATED" | "NOT_ELIGIBLE" | "OUT_OF_SCOPE";

/** A persisted PAYPAL_API_READBACK evidence row, parsed from its redacted allowlist summary. */
export type ReadbackFact = {
  seq: number;
  httpStatus: number | null;
  createdAt: string;
  orderId: string | null;
  orderStatus: string | null;
  units: Array<{ customId: string | null; captures: Array<{ id: string | null; status: string | null; currency: string | null; value: string | null }> }>;
};

export type PaymentFacts = {
  intentId: string;
  intentSku: string;
  intentCurrency: string;
  intentMinor: number;
  attemptId: string | null;
  attemptState: string | null;
  paypalOrderId: string | null;
  captureId: string | null;
  captureStatus: string | null;
  capturedMinor: number | null;
  capturedCurrency: string | null;
  readbacks: ReadbackFact[];
  /** Failed GET observations are uncertainty, never authoritative capture proof. */
  readbackFailures?: Array<{ seq: number; createdAt: string }>;
};

export type OrderFact = { id: string; status: string; effectiveStatus?: string; attemptId: string; paypalOrderId: string; captureId: string; sku: string; amountMinor: number; currency: string };

export type Evaluation = {
  result: EvaluationResult;
  eligible: boolean;
  activeOrderCount: number;
  /** Placed orders that match the captured payment field for field (only when eligible). */
  matchingOrderIds: string[];
  reasons: string[];
  /** Readback evidence rows that confirm the capture (only when eligible). */
  confirmingReadbackSeqs: number[];
};

/** Does this readback confirm exactly the locally recorded capture for this intent? null = yes. */
function readbackContradiction(r: ReadbackFact, p: PaymentFacts): string | null {
  if (r.orderId !== p.paypalOrderId) return "readback order id differs";
  if (r.units.length !== 1) return "readback purchase units not exactly one";
  const u = r.units[0]!;
  if (u.customId !== p.intentId) return "readback custom_id differs from intent";
  if (u.captures.length !== 1) return `readback shows ${u.captures.length} captures`;
  const c = u.captures[0]!;
  if (c.id !== p.captureId) return "readback capture id differs from local capture";
  if (c.status !== "COMPLETED") return `readback capture status ${c.status ?? "missing"}`;
  const m = parseProviderValue(c.value, c.currency ?? "");
  if (!m || m.minor !== p.intentMinor || m.currency !== p.intentCurrency) return "readback capture amount differs from intent";
  return null;
}

/** Every field in which a merchant order differs from the eligible captured payment; [] = matches. */
export function orderMismatches(o: OrderFact, p: PaymentFacts): string[] {
  const out: string[] = [];
  if (o.attemptId !== p.attemptId) out.push(`payment attempt ${o.attemptId} != ${p.attemptId ?? "missing"}`);
  if (o.paypalOrderId !== p.paypalOrderId) out.push(`PayPal order id ${o.paypalOrderId} != ${p.paypalOrderId ?? "missing"}`);
  if (o.captureId !== p.captureId) out.push(`capture id ${o.captureId} != ${p.captureId ?? "missing"}`);
  if (o.sku !== p.intentSku) out.push(`sku ${o.sku} != ${p.intentSku}`);
  if (o.currency !== p.intentCurrency) out.push(`currency ${o.currency} != ${p.intentCurrency}`);
  if (o.amountMinor !== p.intentMinor) out.push(`amount minor ${o.amountMinor} != ${p.intentMinor}`);
  return out;
}

export function evaluateContract(p: PaymentFacts, orders: readonly OrderFact[]): Evaluation {
  const active = orders.filter((o) => o.status === "placed" && (o.effectiveStatus ?? o.status) === "placed");
  const n = active.length;
  const reasons: string[] = [];
  let confirming: number[] = [];

  if (p.attemptState !== "captured") reasons.push(`payment attempt state ${p.attemptState ?? "missing"}, not captured`);
  else if (p.captureStatus !== "COMPLETED") reasons.push(`local capture status ${p.captureStatus ?? "missing"}`);
  else if (p.capturedMinor !== p.intentMinor || p.capturedCurrency !== p.intentCurrency) reasons.push("locally captured amount differs from intent");
  else {
    // Readbacks before the capture (no captures yet) are not contradictions; the newest one that
    // shows any capture decides. A later contradicting readback (e.g. refunded) removes eligibility.
    const withCaptures = p.readbacks
      .filter((r) => r.httpStatus === 200 && r.units.some((u) => u.captures.length > 0))
      .sort((a, b) => a.seq - b.seq);
    const newest = withCaptures.at(-1);
    if (!newest) reasons.push("no authoritative PAYPAL_API_READBACK shows a capture");
    else {
      const why = readbackContradiction(newest, p);
      if (why) reasons.push(`newest capture readback (evidence ${newest.seq}): ${why}`);
      else confirming = withCaptures.filter((r) => readbackContradiction(r, p) === null).map((r) => r.seq);
    }
  }
  const eligible = reasons.length === 0;

  if (!eligible) {
    if (n === 0) return { result: "NOT_ELIGIBLE", eligible, activeOrderCount: n, matchingOrderIds: [], reasons, confirmingReadbackSeqs: [] };
    return {
      result: "OUT_OF_SCOPE",
      eligible,
      activeOrderCount: n,
      matchingOrderIds: [],
      reasons: [...reasons, `${n} merchant order(s) exist without an eligible capture; no incident class for this in Stage 1C`],
      confirmingReadbackSeqs: [],
    };
  }
  const basis = `capture ${p.captureId} COMPLETED confirmed by readback evidence ${confirming.join(", ")}`;
  const matching = active.filter((o) => orderMismatches(o, p).length === 0).map((o) => o.id);
  const mismatched = active.filter((o) => !matching.includes(o.id)).map((o) => `merchant order ${o.id} does not match the capture: ${orderMismatches(o, p).join("; ")}`);
  const out = (result: EvaluationResult, ...why: string[]): Evaluation => ({
    result, eligible, activeOrderCount: n, matchingOrderIds: matching, reasons: [basis, ...why, ...mismatched], confirmingReadbackSeqs: confirming,
  });
  // Two matching orders prove the duplicate on their own; an extra mismatched order is reported, not ignored.
  if (matching.length >= 2) return out("VIOLATED", `${matching.length} matching merchant orders for one captured intent; contract allows exactly one`);
  if (mismatched.length > 0) {
    return out("OUT_OF_SCOPE", `${mismatched.length} placed merchant order(s) do not match the captured payment; no incident class for mismatched orders in Stage 1C`);
  }
  if (n === 1) return out("HOLDS", "exactly one merchant order, matching the capture");
  return out("OUT_OF_SCOPE", "no merchant order yet; missing-order is not an incident class in Stage 1C");
}

/** Parse a persisted summarizeOrder() JSON into a ReadbackFact (tolerates missing fields). */
export function readbackFact(row: { seq: number; http_status: number | null; created_at: string; summary_json: string }): ReadbackFact {
  const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  let s: Record<string, unknown> = {};
  try {
    s = object(JSON.parse(row.summary_json));
  } catch {
    /* unparsable summary -> no units, never confirms */
  }
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const units: unknown[] = Array.isArray(s.purchase_units) ? s.purchase_units : [];
  return {
    seq: row.seq,
    httpStatus: row.http_status,
    createdAt: row.created_at,
    orderId: str(s.id),
    orderStatus: str(s.status),
    units: units.map((unit) => {
      const u = object(unit);
      return {
        customId: str(u.custom_id),
        captures: (Array.isArray(u.captures) ? u.captures : []).map((capture: unknown) => {
          const c = object(capture);
          const amt = object(c.amount);
          return { id: str(c.id), status: str(c.status), currency: str(amt.currency_code), value: str(amt.value) };
        }),
      };
    }),
  };
}
