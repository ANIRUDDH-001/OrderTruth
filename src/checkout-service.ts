import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GATE0_PRODUCT, verifyCaptureReadback, type AttemptState, type CaptureVerdict, type OrderReadback } from "./domain/checkout.ts";
import { toProviderValue } from "./domain/money.ts";
import type { AttemptRow, EvidenceInput, IntentRow, Store } from "./db/store.ts";
import { PayPalError, type PayPalClient, type PayPalCall } from "./paypal/client.ts";
import { summarizeOrder } from "./paypal/summaries.ts";
import { maskId, redactValue } from "./redact.ts";

export type CheckoutErrorCode =
  | "unknown_order"
  | "invalid_order_id"
  | "not_approved"
  | "capture_in_progress"
  | "provider_error"
  | "provider_mismatch"
  | "outcome_unknown"
  | "capture_outcome_pending"
  | "invalid_checkout_key"
  | "checkout_in_progress"
  | "checkout_already_paid"
  | "checkout_closed";

export class CheckoutError extends Error {
  readonly code: CheckoutErrorCode;
  readonly httpStatus: number;
  /** Non-sensitive identifiers only (order id, state, retry hint). Sent to the browser. */
  readonly details: Record<string, unknown> | undefined;
  constructor(code: CheckoutErrorCode, message: string, httpStatus: number, details?: Record<string, unknown>) {
    super(message);
    this.name = "CheckoutError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export type Logger = { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void };

export type CheckoutOptions = {
  evidenceDir?: string | undefined;
  secrets?: readonly string[];
  /**
   * Minimum time after a capture claim before an explicit retry may POST again (same request id)
   * when the outcome is unknown. Default 120 s; the runtime uses max(120 s, 4 x HTTP timeout).
   */
  captureSettleMs?: number;
  /** A capture_in_progress claim younger than this may belong to a live request in any process. */
  reconcileStaleMs?: number;
  /** Clock (epoch ms) for claim timing. Tests inject it. */
  now?: () => number;
};

export type ReconcileOutcome = { attemptId: string; orderId: string; from: AttemptState; to: AttemptState; error?: string };

/** Browser-generated, stored until the checkout is terminal. Opaque; never a secret. */
export const CHECKOUT_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const ORDER_ID = /^[A-Z0-9]{8,36}$/;
const TERMINAL: readonly AttemptState[] = ["captured", "denied", "mismatch"];
const OUTCOME_UNKNOWN_MSG = "The payment may have completed. Do not pay again; the outcome will be confirmed by PayPal readback.";

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

export type CreateOrderResult = {
  intentId: string;
  attemptId: string;
  orderId: string;
  status: string | null;
  approveUrl: string | null;
  amount: { currency: string; value: string };
  /** True when an existing checkout for this key was returned instead of a new one. */
  reused: boolean;
};

const errText = (err: unknown) => ({ errName: (err as Error)?.name ?? "unknown", errMsg: String((err as Error)?.message ?? err).slice(0, 200) });

/**
 * Orchestrates the lifecycle: durable checkout intent -> create (server-owned amount, stable
 * request id) -> buyer approval -> guarded claim -> capture (stable request id) -> authoritative
 * GET readback -> deterministic verdict. A readback-only reconciler settles anything left open.
 */
export class CheckoutService {
  readonly #inFlight = new Map<string, Promise<CheckoutResult>>();
  readonly #creating = new Map<string, Promise<CreateOrderResult>>();
  readonly #evidenceFiles: string[] = [];
  readonly #settleMs: number;
  readonly #staleMs: number;
  readonly #now: () => number;
  #reconciling: Promise<{ outcomes: ReconcileOutcome[] }> | null = null;

  constructor(
    private readonly paypal: PayPalClient,
    private readonly store: Store,
    private readonly log: Logger,
    private readonly opts: CheckoutOptions = {},
  ) {
    this.#settleMs = opts.captureSettleMs ?? 120_000;
    this.#staleMs = opts.reconcileStaleMs ?? 60_000;
    this.#now = opts.now ?? Date.now;
  }

  /** The DB row is authoritative and must succeed; the file mirror is best-effort and never changes an outcome. */
  #evidence(e: EvidenceInput) {
    const summary = redactValue(e.summary, this.opts.secrets ?? []);
    const seq = this.store.appendEvidence({ ...e, summary });
    if (this.opts.evidenceDir) {
      try {
        mkdirSync(this.opts.evidenceDir, { recursive: true });
        const file = join(this.opts.evidenceDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${String(seq).padStart(4, "0")}_${e.operation}.json`);
        writeFileSync(file, JSON.stringify({ seq, ...e, summary, note: "Redacted allowlist summary. Not a raw provider body." }, null, 2));
        this.#evidenceFiles.push(file);
      } catch (err) {
        this.#safeLog("warn", { evt: "evidence_file_write_failed", seq, op: e.operation, ...errText(err) });
      }
    }
    this.#safeLog("info", { evt: "evidence", seq, cls: e.evidenceClass, op: e.operation, http: e.httpStatus, debugId: e.debugId, corr: e.correlationId, ms: e.durationMs });
    return seq;
  }

  #safeLog(level: keyof Logger, obj: object) {
    try {
      this.log[level](obj);
    } catch {
      /* logging must never change a payment outcome */
    }
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
   * Create (or resume) the server-priced order for one durable checkout intent. The same
   * `checkoutKey` always maps to the same intent, attempt and request ids, in any process, so a
   * buyer retry can never start a second independent payment. Without a key (CLI, tests) a fresh
   * one is generated. `redirect` enables the redirect-approval fallback.
   */
  createOrder(correlationId: string, opts: { checkoutKey?: string | undefined; redirect?: { returnUrl: string; cancelUrl: string } | undefined } = {}): Promise<CreateOrderResult> {
    const key = opts.checkoutKey ?? `ck_${randomUUID().replace(/-/g, "")}`;
    if (!CHECKOUT_KEY.test(key)) return Promise.reject(new CheckoutError("invalid_checkout_key", "x-checkout-key must be 16-128 characters [A-Za-z0-9_-]", 400));
    const existing = this.#creating.get(key);
    if (existing) return existing;
    const p = this.#createOrder(correlationId, key, opts.redirect).finally(() => this.#creating.delete(key));
    this.#creating.set(key, p);
    return p;
  }

  async #createOrder(correlationId: string, key: string, redirect?: { returnUrl: string; cancelUrl: string }): Promise<CreateOrderResult> {
    const newIntentId = `ci_${randomUUID()}`;
    const newAttemptId = `pa_${randomUUID()}`;
    const p = GATE0_PRODUCT;
    this.store.createIntentWithAttempt(
      { id: newIntentId, sku: p.sku, currency: p.price.currency, amount_minor: p.price.minor, correlation_id: correlationId, checkout_key: key },
      { id: newAttemptId, createRequestId: `ot-create-${newAttemptId}`, captureRequestId: `ot-capture-${newAttemptId}` },
    );
    const intent = this.store.getIntentByCheckoutKey(key)!;
    let a = this.store.getAttemptByIntentId(intent.id)!;
    const reused = intent.id !== newIntentId;
    if (a.state !== "created") return this.#existingCheckout(intent, a);

    // No provider order stored yet (first call, or an earlier create whose outcome is unknown):
    // (re)issue the create with the same stable PayPal-Request-Id.
    const value = toProviderValue({ currency: intent.currency, minor: intent.amount_minor });
    const body = {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: p.sku,
          custom_id: intent.id,
          description: p.name,
          amount: { currency_code: intent.currency, value, breakdown: { item_total: { currency_code: intent.currency, value } } },
          items: [{ name: p.name, sku: p.sku, quantity: "1", category: "DIGITAL_GOODS", unit_amount: { currency_code: intent.currency, value } }],
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
      r = await this.paypal.createOrder(body, a.create_request_id, { correlationId });
    } catch (err) {
      if (err instanceof PayPalError) {
        this.#errorEvidence(a.id, "create_order", err, correlationId, a.create_request_id);
        // State stays `created`: a retry with this key reuses the same create request id.
        if (err.outcomeUnknown) this.store.updateAttempt(a.id, { verdict_reasons: JSON.stringify([`create outcome unknown: ${err.kind}; retry reuses the same request id`]) });
        throw new CheckoutError("provider_error", err.message, 502);
      }
      throw err;
    }
    const order = r.body;
    this.#callEvidence(a.id, "PAYPAL_API_RESPONSE", "create_order", r, summarizeOrder(order));
    if (!this.store.attachOrder(a.id, order.id, order.status)) {
      // Another request/process stored the order first. Same request id, so PayPal returns the
      // same order; if it ever differed, ours is unknown locally and can never be captured here.
      a = this.store.getAttempt(a.id)!;
      if (a.paypal_order_id !== order.id) this.#safeLog("warn", { evt: "create_order_lost_race", attemptId: a.id, storedOrder: maskId(a.paypal_order_id ?? undefined), lostOrder: maskId(order.id) });
      return this.#existingCheckout(intent, a);
    }
    const approveUrl = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href ?? null;
    return { intentId: intent.id, attemptId: a.id, orderId: order.id, status: order.status, approveUrl, amount: { currency: intent.currency, value }, reused };
  }

  #existingCheckout(intent: IntentRow, a: AttemptRow): CreateOrderResult {
    const details = { orderId: a.paypal_order_id, state: a.state };
    switch (a.state) {
      case "awaiting_buyer_approval":
        return {
          intentId: intent.id,
          attemptId: a.id,
          orderId: a.paypal_order_id!,
          status: a.provider_order_status,
          approveUrl: null,
          amount: { currency: intent.currency, value: toProviderValue({ currency: intent.currency, minor: intent.amount_minor }) },
          reused: true,
        };
      case "captured":
        throw new CheckoutError("checkout_already_paid", "This checkout is already paid. Do not pay again.", 409, details);
      case "denied":
      case "mismatch":
        throw new CheckoutError("checkout_closed", "This checkout is closed. Start a new checkout.", 409, details);
      case "created":
        throw new CheckoutError("checkout_in_progress", "This checkout is being created. Retry shortly.", 409, details);
      default:
        throw new CheckoutError("checkout_in_progress", "A payment for this checkout is in progress or its outcome is not yet confirmed. Do not pay again.", 409, details);
    }
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

  /**
   * Persist a readback verdict through guarded transitions. A verdict backed by a capture record
   * applies from any legal predecessor; an `uncertain` verdict applies only if nobody re-claimed
   * the capture since `a` was read (claim counter guard).
   */
  #applyVerdict(a: AttemptRow, v: CaptureVerdict, raw: OrderReadback): boolean {
    const patch = {
      provider_order_status: v.orderStatus,
      capture_id: v.captureId,
      capture_status: v.captureStatus,
      captured_minor: v.captured?.minor ?? null,
      captured_currency: v.captured?.currency ?? null,
      payee_merchant_masked: maskId(raw.purchase_units?.[0]?.payee?.merchant_id),
      verdict_reasons: JSON.stringify(v.reasons),
    };
    if (v.state === "uncertain") {
      const guard = { captureClaims: a.capture_claims };
      return this.store.transition(a.id, "uncertain", patch, a.state, guard) || this.store.refresh(a.id, "uncertain", patch, guard);
    }
    return this.store.transition(a.id, v.state, patch) || this.store.refresh(a.id, v.state, patch);
  }

  #claimIsFresh(a: AttemptRow): boolean {
    return a.capture_claimed_at_ms !== null && this.#now() - a.capture_claimed_at_ms < this.#staleMs;
  }

  /** Capture an approved order at most once. Concurrent calls for one order share a single flight. */
  capture(orderId: string, correlationId: string): Promise<CheckoutResult> {
    const existing = this.#inFlight.get(orderId);
    if (existing) return existing;
    const p = this.#capture(orderId, correlationId).finally(() => this.#inFlight.delete(orderId));
    this.#inFlight.set(orderId, p);
    return p;
  }

  async #capture(orderId: string, correlationId: string): Promise<CheckoutResult> {
    let a = this.#requireAttempt(orderId);
    if (TERMINAL.includes(a.state)) return this.#result(a); // idempotent: no provider call at all
    if (a.state === "capture_in_progress" && this.#claimIsFresh(a)) {
      throw new CheckoutError("capture_in_progress", "A capture for this order is already in progress. Do not pay again.", 409, { orderId, state: a.state });
    }

    // 1. Read provider state first: never capture unless the buyer approved and correlation holds.
    const pre = await this.#readbackAndVerify(a, correlationId, "pre_capture_readback");
    a = this.store.getAttempt(a.id)!;
    if (TERMINAL.includes(a.state)) return this.#result(a);
    if (pre.raw.purchase_units?.[0]?.payments?.captures?.length) {
      // A capture already exists (earlier unknown outcome, other process): settle it, never capture again.
      this.#applyVerdict(a, pre.verdict, pre.raw);
      return this.#result(this.store.getAttempt(a.id)!, pre.verdict.reasons);
    }
    if (pre.verdict.state === "mismatch") {
      this.#applyVerdict(a, pre.verdict, pre.raw);
      throw new CheckoutError("provider_mismatch", `PayPal order does not match this checkout (${pre.verdict.reasons.join("; ")}); capture refused`, 409, { orderId });
    }
    if (pre.raw.status !== "APPROVED") {
      this.store.updateAttempt(a.id, { provider_order_status: pre.raw.status ?? null });
      throw new CheckoutError("not_approved", `order status is ${pre.raw.status ?? "unknown"}; buyer approval required before capture`, 409);
    }

    // 2. Guarded claim. APPROVED with no capture is proof only if no capture was ever requested.
    let claimed: boolean;
    if (a.state === "awaiting_buyer_approval" || a.state === "approved") {
      if (a.state === "awaiting_buyer_approval") this.store.transition(a.id, "approved", { provider_order_status: "APPROVED" }, "awaiting_buyer_approval");
      claimed = this.store.claimCapture(a.id, ["approved"], { nowMs: this.#now() });
    } else if (a.state === "uncertain" || a.state === "capture_in_progress") {
      // An earlier capture request's outcome is unknown (or its owner died). An APPROVED readback
      // now is not proof that request cannot still complete: wait out the settle window, then
      // retry only with the same stored request id, which PayPal treats idempotently.
      if (a.state === "capture_in_progress") {
        this.store.transition(a.id, "uncertain", { verdict_reasons: JSON.stringify(["stale capture claim; readback APPROVED with no capture; outcome of the earlier request unknown"]) }, "capture_in_progress", { captureClaims: a.capture_claims });
        a = this.store.getAttempt(a.id)!;
        if (a.state !== "uncertain") throw new CheckoutError("capture_in_progress", "A capture for this order is already in progress. Do not pay again.", 409, { orderId, state: a.state });
      }
      const since = this.#now() - (a.capture_claimed_at_ms ?? 0);
      if (since < this.#settleMs) {
        throw new CheckoutError("capture_outcome_pending", "An earlier capture request's outcome is not yet known. Do not pay again; retry later.", 409, { orderId, state: a.state, retryAfterMs: this.#settleMs - since });
      }
      claimed = this.store.claimCapture(a.id, ["uncertain"], { nowMs: this.#now(), settledBeforeMs: this.#now() - this.#settleMs });
    } else {
      throw new CheckoutError("capture_in_progress", "A payment for this order is in progress. Do not pay again.", 409, { orderId, state: a.state });
    }
    if (!claimed) throw new CheckoutError("capture_in_progress", "A capture for this order is already in progress. Do not pay again.", 409, { orderId });
    return this.#captureClaimed(orderId, a.id, correlationId);
  }

  /**
   * Runs only while holding a committed claim. From the moment the POST may have reached PayPal,
   * no local failure may surface as a generic error or release the order for a fresh capture:
   * failures become `uncertain` (best effort) + 503 outcome_unknown, settled later by readback.
   */
  async #captureClaimed(orderId: string, attemptId: string, correlationId: string): Promise<CheckoutResult> {
    const a = this.store.getAttempt(attemptId)!;
    const claim = a.capture_claims;
    try {
      let captureErr: PayPalError | null = null;
      try {
        const r = await this.paypal.captureOrder(orderId, a.capture_request_id, { correlationId });
        this.#callEvidence(a.id, "PAYPAL_API_RESPONSE", "capture_order", r, summarizeOrder(r.body));
      } catch (err) {
        if (!(err instanceof PayPalError)) throw err;
        captureErr = err;
        this.#errorEvidence(a.id, "capture_order", err, correlationId, a.capture_request_id);
      }

      // 3. Authoritative readback decides the outcome, whatever the capture call returned.
      let post: { verdict: CaptureVerdict; raw: OrderReadback };
      try {
        post = await this.#readbackAndVerify(this.store.getAttempt(a.id)!, correlationId, "post_capture_readback");
      } catch (err) {
        if (!(err instanceof PayPalError)) throw err;
        this.#errorEvidence(a.id, "post_capture_readback", err, correlationId, null);
        this.#markUncertain(a.id, claim, ["readback failed after capture request; outcome unknown; reconciler will read back"]);
        return this.#result(this.store.getAttempt(a.id)!);
      }
      const cur = this.store.getAttempt(a.id)!;
      if (TERMINAL.includes(cur.state)) return this.#result(cur);
      const v = post.verdict;
      if (v.state === "uncertain" && !post.raw.purchase_units?.[0]?.payments?.captures?.length) {
        this.#markUncertain(a.id, claim, [
          ...(captureErr ? [`capture call failed: ${captureErr.kind} ${captureErr.issues.join(",")}`.trim()] : []),
          `readback shows no capture (order status ${post.raw.status ?? "unknown"}); not proof the request cannot still complete`,
          `explicit retry allowed after ${this.#settleMs} ms with the same request id`,
        ]);
      } else {
        this.#applyVerdict(cur, v, post.raw);
      }
      return this.#result(this.store.getAttempt(a.id)!);
    } catch (err) {
      if (err instanceof CheckoutError) throw err;
      try {
        this.store.transition(a.id, "uncertain", { verdict_reasons: JSON.stringify(["local failure after capture request; outcome unknown; settle by readback"]) }, "capture_in_progress", { captureClaims: claim });
      } catch {
        /* the committed claim row still records that a capture may have happened */
      }
      this.#safeLog("error", { evt: "capture_local_failure", attemptId: a.id, ...errText(err) });
      throw new CheckoutError("outcome_unknown", OUTCOME_UNKNOWN_MSG, 503, { orderId });
    }
  }

  #markUncertain(attemptId: string, claim: number, reasons: string[]) {
    const patch = { verdict_reasons: JSON.stringify(reasons) };
    const guard = { captureClaims: claim };
    if (!this.store.transition(attemptId, "uncertain", patch, ["capture_in_progress", "pending"], guard)) this.store.refresh(attemptId, "uncertain", patch, guard);
  }

  /**
   * Readback-only reconciliation of every unsettled attempt (stale claims, uncertain, pending).
   * Issues GET requests only, never a capture; never moves anything back to `approved`.
   * Safe to run concurrently with captures in this or other processes (guarded transitions).
   */
  reconcile(correlationId = `reconcile_${randomUUID()}`): Promise<{ outcomes: ReconcileOutcome[] }> {
    if (this.#reconciling) return this.#reconciling;
    const p = this.#reconcile(correlationId).finally(() => (this.#reconciling = null));
    this.#reconciling = p;
    return p;
  }

  async #reconcile(correlationId: string): Promise<{ outcomes: ReconcileOutcome[] }> {
    const outcomes: ReconcileOutcome[] = [];
    for (const a of this.store.listUnsettled()) {
      const orderId = a.paypal_order_id!;
      if (this.#inFlight.has(orderId)) continue; // this process is mid-capture
      if (a.state === "capture_in_progress" && this.#claimIsFresh(a)) continue; // maybe another process is
      try {
        const { verdict, raw } = await this.#readbackAndVerify(a, correlationId, "reconcile_readback");
        const cur = this.store.getAttempt(a.id)!;
        if (cur.state === a.state && cur.capture_claims === a.capture_claims) {
          const v = verdict.state === "uncertain" ? { ...verdict, reasons: [...verdict.reasons, "reconciler: no definitive outcome; it never captures"] } : verdict;
          this.#applyVerdict(cur, v, raw);
        }
        outcomes.push({ attemptId: a.id, orderId, from: a.state, to: this.store.getAttempt(a.id)!.state });
      } catch (err) {
        if (err instanceof PayPalError) {
          try {
            this.#errorEvidence(a.id, "reconcile_readback", err, correlationId, null);
          } catch {
            /* evidence DB failure: logged below */
          }
        }
        this.#safeLog("warn", { evt: "reconcile_failed", attemptId: a.id, ...errText(err) });
        outcomes.push({ attemptId: a.id, orderId, from: a.state, to: a.state, error: err instanceof PayPalError ? err.kind : "local_error" });
      }
    }
    return { outcomes };
  }

  /** Read-only reconciliation for one order: GET from PayPal and update local verdict. No provider writes. */
  async readback(orderId: string, correlationId: string): Promise<CheckoutResult> {
    const a = this.#requireAttempt(orderId);
    const { verdict, raw } = await this.#readbackAndVerify(a, correlationId, "readback");
    this.#applyReadback(a.id, verdict, raw);
    return this.#result(this.store.getAttempt(a.id)!, verdict.reasons);
  }

  /**
   * Webhook-triggered readback. The GET is authoritative; the webhook only says "look now". The
   * result is applied only if `accept(raw)` returns null, i.e. the caller's claims (from a
   * PayPal-verified event) agree with what PayPal returns; otherwise nothing local changes and the
   * reason is returned. Read-only towards PayPal: never captures.
   */
  async readbackIf(orderId: string, correlationId: string, accept: (raw: OrderReadback) => string | null): Promise<{ applied: boolean; reason: string | null; result: CheckoutResult }> {
    const a = this.#requireAttempt(orderId);
    const { verdict, raw } = await this.#readbackAndVerify(a, correlationId, "webhook_readback");
    const reason = accept(raw);
    if (reason === null) this.#applyReadback(a.id, verdict, raw);
    return { applied: reason === null, reason, result: this.#result(this.store.getAttempt(a.id)!, verdict.reasons) };
  }

  /** Same rules as the manual readback: a capture record settles the verdict; otherwise only status / approval. */
  #applyReadback(attemptId: string, verdict: CaptureVerdict, raw: OrderReadback) {
    const cur = this.store.getAttempt(attemptId)!;
    if (raw.purchase_units?.[0]?.payments?.captures?.length) this.#applyVerdict(cur, verdict, raw);
    else {
      this.store.updateAttempt(attemptId, { provider_order_status: raw.status ?? null });
      if (raw.status === "APPROVED" && cur.state === "awaiting_buyer_approval") this.store.transition(attemptId, "approved", {}, "awaiting_buyer_approval");
    }
  }

  /** Read-only lookup for webhook correlation: is this PayPal order one of ours? */
  ownsOrder(orderId: string): { attemptId: string; intentId: string } | null {
    if (!ORDER_ID.test(orderId)) return null;
    const a = this.store.getAttemptByOrderId(orderId);
    return a ? { attemptId: a.id, intentId: a.intent_id } : null;
  }

  status(orderId: string): CheckoutResult {
    return this.#result(this.#requireAttempt(orderId));
  }
}
