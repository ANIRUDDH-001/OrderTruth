import { parseProviderValue, type Money } from "./money.ts";

/** Server-owned catalog. The browser can never set price, currency or quantity. */
export const GATE0_PRODUCT = {
  sku: "OT-GATE0-SANDBOX-TEST",
  name: "OrderTruth Gate 0 Sandbox test item",
  price: { currency: "USD", minor: 100 } satisfies Money,
} as const;

export const ATTEMPT_STATES = [
  "created",
  "awaiting_buyer_approval",
  "approved",
  "capture_in_progress",
  "captured",
  "pending",
  "denied",
  "uncertain",
  "mismatch",
] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

const TRANSITIONS: Record<AttemptState, readonly AttemptState[]> = {
  created: ["awaiting_buyer_approval"],
  awaiting_buyer_approval: ["approved", "capture_in_progress", "uncertain"],
  approved: ["capture_in_progress"],
  // Capture may end any way; uncertain must be resolved by readback, never by blind retry.
  capture_in_progress: ["captured", "pending", "denied", "uncertain", "mismatch"],
  uncertain: ["captured", "pending", "denied", "mismatch", "capture_in_progress", "approved", "awaiting_buyer_approval"],
  pending: ["captured", "denied", "mismatch", "uncertain"],
  captured: [],
  denied: [],
  mismatch: [],
};

export function canTransition(from: AttemptState, to: AttemptState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/** Minimal shape of the PayPal Orders v2 GET response that verification relies on. */
export type OrderReadback = {
  id?: string;
  status?: string;
  intent?: string;
  purchase_units?: Array<{
    reference_id?: string;
    custom_id?: string;
    amount?: { currency_code?: string; value?: string };
    payee?: { merchant_id?: string };
    payments?: {
      captures?: Array<{
        id?: string;
        status?: string;
        final_capture?: boolean;
        amount?: { currency_code?: string; value?: string };
        status_details?: { reason?: string };
      }>;
    };
  }>;
};

export type CaptureVerdict = {
  state: Extract<AttemptState, "captured" | "pending" | "denied" | "uncertain" | "mismatch">;
  captureId: string | null;
  captureStatus: string | null;
  orderStatus: string | null;
  captured: Money | null;
  reasons: string[];
};

/**
 * Decide the payment outcome from an authoritative PayPal GET readback, compared with the
 * server-owned intent. This is deterministic code, never AI. HTTP success alone is not proof.
 */
export function verifyCaptureReadback(
  readback: OrderReadback,
  expected: { orderId: string; amount: Money; customId: string },
): CaptureVerdict {
  const reasons: string[] = [];
  const orderStatus = readback.status ?? null;
  const units = readback.purchase_units ?? [];
  const base = { orderStatus, captureId: null, captureStatus: null, captured: null } as const;

  if (readback.id !== expected.orderId) return { ...base, state: "mismatch", reasons: ["order id differs from expected"] };
  if (readback.intent && readback.intent !== "CAPTURE") reasons.push(`unexpected intent ${readback.intent}`);
  if (units.length !== 1) return { ...base, state: "mismatch", reasons: [`expected 1 purchase unit, got ${units.length}`] };
  const unit = units[0]!;
  if (unit.custom_id !== undefined && unit.custom_id !== expected.customId) reasons.push("custom_id differs from local intent");

  const orderAmount = parseProviderValue(unit.amount?.value, unit.amount?.currency_code ?? "");
  if (!orderAmount || orderAmount.minor !== expected.amount.minor || orderAmount.currency !== expected.amount.currency) {
    reasons.push("order amount/currency differs from server-owned intent");
  }

  const captures = unit.payments?.captures ?? [];
  if (captures.length === 0) {
    return { ...base, state: "uncertain", reasons: [...reasons, `no capture present (order status ${orderStatus ?? "unknown"})`] };
  }
  if (captures.length > 1) reasons.push(`multiple captures (${captures.length}) for one intent`);
  const cap = captures[0]!;
  const captured = parseProviderValue(cap.amount?.value, cap.amount?.currency_code ?? "");
  if (!captured || captured.minor !== expected.amount.minor || captured.currency !== expected.amount.currency) {
    reasons.push("captured amount/currency differs from server-owned intent");
  }
  const out = { orderStatus, captureId: cap.id ?? null, captureStatus: cap.status ?? null, captured };

  if (reasons.length > 0) return { ...out, state: "mismatch", reasons };
  switch (cap.status) {
    case "COMPLETED":
      if (orderStatus !== "COMPLETED") return { ...out, state: "uncertain", reasons: [`capture COMPLETED but order status ${orderStatus}`] };
      return { ...out, state: "captured", reasons: ["capture COMPLETED; amount, currency and order id match intent"] };
    case "PENDING":
      return { ...out, state: "pending", reasons: [`capture PENDING: ${cap.status_details?.reason ?? "no reason given"}`] };
    case "DECLINED":
    case "FAILED":
      return { ...out, state: "denied", reasons: [`capture ${cap.status}`] };
    default:
      return { ...out, state: "uncertain", reasons: [`unrecognised capture status ${cap.status ?? "missing"}`] };
  }
}
