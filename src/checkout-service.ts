import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GATE0_PRODUCT, verifyCaptureReadback, type AttemptState, type CaptureVerdict, type OrderReadback } from "./domain/checkout.ts";
import { toProviderValue } from "./domain/money.ts";
import type { AttemptRow, EvidenceInput, Store } from "./db/store.ts";
import { PayPalError, type PayPalClient, type PayPalCall } from "./paypal/client.ts";
import { summarizeOrder } from "./paypal/summaries.ts";
import { maskId, redactValue } from "./redact.ts";

export class CheckoutError extends Error {
  readonly code: "unknown_order" | "invalid_order_id" | "not_approved" | "capture_in_progress" | "provider_error";
  readonly httpStatus: number;
  constructor(code: CheckoutError["code"], message: string, httpStatus: number) {
    super(message);
    this.name = "CheckoutError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export type Logger = { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void };

const ORDER_ID = /^[A-Z0-9]{8,36}$/;
const CAPTURABLE_FROM: readonly AttemptState[] = ["awaiting_buyer_approval", "approved", "uncertain"];
const TERMINAL: readonly AttemptState[] = ["captured", "denied", "mismatch"];

export type CheckoutResult = {
  attemptId: string;
  orderId: string | null;
  state: AttemptState;
  orderStatus: string | null;
  captureId: string | null;
  captureStatus: string | null;
  amount: { currency: string; value: string } | null;
  reasons: string[];
  evidenceFiles: string[];
};

/**
 * Orchestrates the Gate 0 lifecycle: create (server-owned amount) -> buyer approval ->
 * capture (stable PayPal-Request-Id) -> authoritative GET readback -> deterministic verdict.
 */
export class CheckoutService {
  readonly #inFlight = new Map<string, Promise<CheckoutResult>>();
  readonly #evidenceFiles: string[] = [];

  constructor(
    private readonly paypal: PayPalClient,
    private readonly store: Store,
    private readonly log: Logger,
    private readonly opts: { evidenceDir?: string | undefined; secrets?: readonly string[] } = {},
  ) {}

  #evidence(e: EvidenceInput) {
    const summary = redactValue(e.summary, this.opts.secrets ?? []);
    const seq = this.store.appendEvidence({ ...e, summary });
    if (this.opts.evidenceDir) {
      mkdirSync(this.opts.evidenceDir, { recursive: true });
      const file = join(this.opts.evidenceDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${String(seq).padStart(4, "0")}_${e.operation}.json`);
      writeFileSync(file, JSON.stringify({ seq, ...e, summary, note: "Redacted allowlist summary. Not a raw provider body." }, null, 2));
      this.#evidenceFiles.push(file);
    }
    this.log.info({ evt: "evidence", seq, cls: e.evidenceClass, op: e.operation, http: e.httpStatus, debugId: e.debugId, corr: e.correlationId, ms: e.durationMs });
    return seq;
  }

  #callEvidence(attemptId: string | null, cls: EvidenceInput["evidenceClass"], operation: string, r: PayPalCall<unknown>, summary: unknown) {
    return this.#evidence({ attemptId, evidenceClass: cls, operation, httpStatus: r.httpStatus, debugId: r.debugId, requestId: r.requestId, correlationId: r.correlationId, durationMs: r.durationMs, summary });
  }

  #errorEvidence(attemptId: string | null, operation: string, err: PayPalError, correlationId: string, requestId: string | null) {
    return this.#evidence({
      attemptId,
      evidenceClass: "PAYPAL_API_RESPONSE",
      operation: `${operation}_error`,
      httpStatus: err.httpStatus,
      debugId: err.debugId,
      requestId,
      correlationId,
      durationMs: err.durationMs,
      summary: { kind: err.kind, issues: err.issues, outcomeUnknown: err.outcomeUnknown },
    });
  }

  get evidenceFiles(): readonly string[] {
    return this.#evidenceFiles;
  }

  /**
   * Create a server-priced order. `returnUrl`/`cancelUrl` enable the redirect-approval fallback;
   * omit them for the SDK v6 popup flow (matches the official sample).
   */
  async createOrder(correlationId: string, redirect?: { returnUrl: string; cancelUrl: string }) {
    const intentId = `ci_${randomUUID()}`;
    const attemptId = `pa_${randomUUID()}`;
    const createRequestId = `ot-create-${attemptId}`;
    const captureRequestId = `ot-capture-${attemptId}`;
    const p = GATE0_PRODUCT;
    this.store.createIntentWithAttempt(
      { id: intentId, sku: p.sku, currency: p.price.currency, amount_minor: p.price.minor, correlation_id: correlationId },
      { id: attemptId, createRequestId, captureRequestId },
    );
    const value = toProviderValue(p.price);
    const body = {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: p.sku,
          custom_id: intentId,
          description: p.name,
          amount: { currency_code: p.price.currency, value, breakdown: { item_total: { currency_code: p.price.currency, value } } },
          items: [{ name: p.name, sku: p.sku, quantity: "1", category: "DIGITAL_GOODS", unit_amount: { currency_code: p.price.currency, value } }],
        },
      ],
      ...(redirect
        ? {
            payment_source: {
              paypal: {
                experience_context: {
                  brand_name: "OrderTruth Gate 0",
                  shipping_preference: "NO_SHIPPING",
                  user_action: "PAY_NOW",
                  return_url: redirect.returnUrl,
                  cancel_url: redirect.cancelUrl,
                },
              },
            },
          }
        : {}),
    };

    let r: Awaited<ReturnType<PayPalClient["createOrder"]>>;
    try {
      r = await this.paypal.createOrder(body, createRequestId, { correlationId });
    } catch (err) {
      if (err instanceof PayPalError) {
        this.#errorEvidence(attemptId, "create_order", err, correlationId, createRequestId);
        if (err.outcomeUnknown) this.store.updateAttempt(attemptId, { state: "uncertain", verdict_reasons: JSON.stringify([`create outcome unknown: ${err.kind}`]) });
        throw new CheckoutError("provider_error", err.message, 502);
      }
      throw err;
    }
    const order = r.body;
    this.store.updateAttempt(attemptId, { paypal_order_id: order.id, state: "awaiting_buyer_approval", provider_order_status: order.status });
    this.#callEvidence(attemptId, "PAYPAL_API_RESPONSE", "create_order", r, summarizeOrder(order));
    const approveUrl = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href ?? null;
    return { intentId, attemptId, orderId: order.id, status: order.status, approveUrl, amount: { currency: p.price.currency, value } };
  }

  #requireAttempt(orderId: string): AttemptRow {
    if (!ORDER_ID.test(orderId)) throw new CheckoutError("invalid_order_id", "order id format invalid", 400);
    const a = this.store.getAttemptByOrderId(orderId);
    if (!a) throw new CheckoutError("unknown_order", "order was not created by this merchant", 404);
    return a;
  }

  #result(a: AttemptRow, reasons?: string[]): CheckoutResult {
    return {
      attemptId: a.id,
      orderId: a.paypal_order_id,
      state: a.state,
      orderStatus: a.provider_order_status,
      captureId: a.capture_id,
      captureStatus: a.capture_status,
      amount: a.captured_minor !== null && a.captured_currency ? { currency: a.captured_currency, value: toProviderValue({ currency: "USD", minor: a.captured_minor }) } : null,
      reasons: reasons ?? (a.verdict_reasons ? (JSON.parse(a.verdict_reasons) as string[]) : []),
      evidenceFiles: [...this.#evidenceFiles],
    };
  }

  /** Authoritative GET readback, persisted as PAYPAL_API_READBACK, plus deterministic verdict. */
  async #readbackAndVerify(a: AttemptRow, correlationId: string, operation: string): Promise<{ verdict: CaptureVerdict; raw: OrderReadback }> {
    const r = await this.paypal.getOrder(a.paypal_order_id!, { correlationId });
    const raw = r.body as OrderReadback;
    this.#callEvidence(a.id, "PAYPAL_API_READBACK", operation, r, summarizeOrder(raw));
    const intent = this.store.getIntent(a.intent_id)!;
    const verdict = verifyCaptureReadback(raw, { orderId: a.paypal_order_id!, amount: { currency: intent.currency, minor: intent.amount_minor }, customId: intent.id });
    return { verdict, raw };
  }

  #persistVerdict(a: AttemptRow, v: CaptureVerdict, raw: OrderReadback) {
    this.store.updateAttempt(a.id, {
      state: v.state,
      provider_order_status: v.orderStatus,
      capture_id: v.captureId,
      capture_status: v.captureStatus,
      captured_minor: v.captured?.minor ?? null,
      captured_currency: v.captured?.currency ?? null,
      payee_merchant_masked: maskId(raw.purchase_units?.[0]?.payee?.merchant_id),
      verdict_reasons: JSON.stringify(v.reasons),
    });
  }

  /** Capture an approved order exactly once. Concurrent calls for one order share a single flight. */
  capture(orderId: string, correlationId: string): Promise<CheckoutResult> {
    const existing = this.#inFlight.get(orderId);
    if (existing) return existing;
    const p = this.#capture(orderId, correlationId).finally(() => this.#inFlight.delete(orderId));
    this.#inFlight.set(orderId, p);
    return p;
  }

  async #capture(orderId: string, correlationId: string): Promise<CheckoutResult> {
    const a = this.#requireAttempt(orderId);
    if (TERMINAL.includes(a.state)) return this.#result(a); // idempotent: no second provider write

    // 1. Read provider state first: never capture unless the buyer actually approved.
    const pre = await this.#readbackAndVerify(a, correlationId, "pre_capture_readback");
    if (pre.raw.purchase_units?.[0]?.payments?.captures?.length) {
      // Already captured (e.g. earlier uncertain attempt): reconcile, do not capture again.
      this.#persistVerdict(a, pre.verdict, pre.raw);
      return this.#result(this.store.getAttempt(a.id)!, pre.verdict.reasons);
    }
    if (pre.raw.status !== "APPROVED") {
      this.store.updateAttempt(a.id, { provider_order_status: pre.raw.status ?? null });
      throw new CheckoutError("not_approved", `order status is ${pre.raw.status ?? "unknown"}; buyer approval required before capture`, 409);
    }
    this.store.updateAttempt(a.id, { state: "approved", provider_order_status: "APPROVED" });

    // 2. Claim (compare-and-set) then capture with the stable request id stored at intent creation.
    if (!this.store.claimCapture(a.id, CAPTURABLE_FROM)) throw new CheckoutError("capture_in_progress", "capture already in progress", 409);
    let captureErr: PayPalError | null = null;
    try {
      const r = await this.paypal.captureOrder(orderId, a.capture_request_id, { correlationId });
      this.#callEvidence(a.id, "PAYPAL_API_RESPONSE", "capture_order", r, summarizeOrder(r.body));
    } catch (err) {
      if (!(err instanceof PayPalError)) throw err;
      captureErr = err;
      this.#errorEvidence(a.id, "capture_order", err, correlationId, a.capture_request_id);
      this.store.updateAttempt(a.id, { state: "uncertain", verdict_reasons: JSON.stringify([`capture call failed: ${err.kind} ${err.issues.join(",")}`]) });
    }

    // 3. Authoritative readback decides the outcome, whatever the capture call returned.
    try {
      const post = await this.#readbackAndVerify(this.store.getAttempt(a.id)!, correlationId, "post_capture_readback");
      const hasCapture = !!post.raw.purchase_units?.[0]?.payments?.captures?.length;
      if (!hasCapture && post.raw.status === "APPROVED") {
        // Provider confirms nothing was captured; safe to allow a later retry (same request id).
        this.store.updateAttempt(a.id, { state: "approved", verdict_reasons: JSON.stringify([...(captureErr ? [`capture failed: ${captureErr.kind}`] : []), "readback: still APPROVED, no capture"]) });
      } else {
        this.#persistVerdict(a, post.verdict, post.raw);
      }
      return this.#result(this.store.getAttempt(a.id)!);
    } catch (err) {
      if (err instanceof PayPalError) {
        this.#errorEvidence(a.id, "post_capture_readback", err, correlationId, null);
        this.store.updateAttempt(a.id, { state: "uncertain", verdict_reasons: JSON.stringify(["readback failed; outcome unknown; re-run readback before any retry"]) });
        return this.#result(this.store.getAttempt(a.id)!);
      }
      throw err;
    }
  }

  /** Read-only reconciliation: GET from PayPal and update local verdict. No provider writes. */
  async readback(orderId: string, correlationId: string): Promise<CheckoutResult> {
    const a = this.#requireAttempt(orderId);
    const { verdict, raw } = await this.#readbackAndVerify(a, correlationId, "readback");
    if (raw.purchase_units?.[0]?.payments?.captures?.length) this.#persistVerdict(a, verdict, raw);
    else this.store.updateAttempt(a.id, { provider_order_status: raw.status ?? null, ...(raw.status === "APPROVED" && a.state === "awaiting_buyer_approval" ? { state: "approved" as const } : {}) });
    return this.#result(this.store.getAttempt(a.id)!, verdict.reasons);
  }

  status(orderId: string): CheckoutResult {
    return this.#result(this.#requireAttempt(orderId));
  }
}
