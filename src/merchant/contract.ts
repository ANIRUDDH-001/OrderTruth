import { parseProviderValue } from "../domain/money.ts";

/**
 * Reference merchant contract (Stage 1C), deterministic and AI-free:
 *
 *   An ELIGIBLE checkout intent (its single payment attempt is locally `captured` with a COMPLETED
 *   capture, AND the newest authoritative PayPal GET readback that shows any capture confirms that
 *   same capture COMPLETED for the intent's server-owned amount) must yield EXACTLY ONE active local
 *   merchant order. Two or more is a violation (DUPLICATE_MERCHANT_ORDER).
 *
 * Only that violation opens an incident in this stage. Zero orders for an eligible intent, or
 * orders for a non-eligible intent, are recorded as OUT_OF_SCOPE (no incident class exists for
 * them yet) rather than silently treated as healthy or accused as duplicates.
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
};

export type OrderFact = { id: string; status: string; captureId: string; amountMinor: number; currency: string };

export type Evaluation = {
  result: EvaluationResult;
  eligible: boolean;
  activeOrderCount: number;
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

export function evaluateContract(p: PaymentFacts, orders: readonly OrderFact[]): Evaluation {
  const active = orders.filter((o) => o.status === "placed");
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
    if (n === 0) return { result: "NOT_ELIGIBLE", eligible, activeOrderCount: n, reasons, confirmingReadbackSeqs: [] };
    return {
      result: "OUT_OF_SCOPE",
      eligible,
      activeOrderCount: n,
      reasons: [...reasons, `${n} merchant order(s) exist without an eligible capture; no incident class for this in Stage 1C`],
      confirmingReadbackSeqs: [],
    };
  }
  const basis = `capture ${p.captureId} COMPLETED confirmed by readback evidence ${confirming.join(", ")}`;
  if (n === 1) return { result: "HOLDS", eligible, activeOrderCount: n, reasons: [basis, "exactly one merchant order"], confirmingReadbackSeqs: confirming };
  if (n === 0) {
    return { result: "OUT_OF_SCOPE", eligible, activeOrderCount: n, reasons: [basis, "no merchant order yet; missing-order is not an incident class in Stage 1C"], confirmingReadbackSeqs: confirming };
  }
  return { result: "VIOLATED", eligible, activeOrderCount: n, reasons: [basis, `${n} merchant orders for one captured intent; contract allows exactly one`], confirmingReadbackSeqs: confirming };
}

/** Parse a persisted summarizeOrder() JSON into a ReadbackFact (tolerates missing fields). */
export function readbackFact(row: { seq: number; http_status: number | null; created_at: string; summary_json: string }): ReadbackFact {
  let s: Record<string, unknown> = {};
  try {
    s = JSON.parse(row.summary_json) as Record<string, unknown>;
  } catch {
    /* unparsable summary -> no units, never confirms */
  }
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const units = Array.isArray(s.purchase_units) ? (s.purchase_units as Array<Record<string, unknown>>) : [];
  return {
    seq: row.seq,
    httpStatus: row.http_status,
    createdAt: row.created_at,
    orderId: str(s.id),
    orderStatus: str(s.status),
    units: units.map((u) => ({
      customId: str(u.custom_id),
      captures: (Array.isArray(u.captures) ? (u.captures as Array<Record<string, unknown>>) : []).map((c) => {
        const amt = (c.amount ?? {}) as Record<string, unknown>;
        return { id: str(c.id), status: str(c.status), currency: str(amt.currency_code), value: str(amt.value) };
      }),
    })),
  };
}
