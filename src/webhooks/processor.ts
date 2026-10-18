import type { CheckoutService, Logger } from "../checkout-service.ts";
import type { OrderReadback } from "../domain/checkout.ts";
import { PayPalError } from "../paypal/client.ts";
import type { EventSummary } from "./event.ts";
import type { EventRow, EventState, WebhookInbox } from "./inbox.ts";

/** Event types that may trigger an authoritative readback. Everything else is stored and ignored. */
export const HANDLED_TYPES: ReadonlySet<string> = new Set([
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.DECLINED",
  "CHECKOUT.ORDER.APPROVED",
  "CHECKOUT.ORDER.COMPLETED",
]);

export type ProcessorOptions = {
  log: Logger;
  now?: () => number;
  leaseMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
};

type Decision = { to: Exclude<EventState, "verified_pending" | "processing">; outcome: string; attemptId?: string | null; retry?: boolean };

const sameAmount = (a: { currency_code: string | null; value: string | null } | null, b: { currency_code?: string; value?: string } | undefined) =>
  !!b && a?.currency_code === (b.currency_code ?? null) && a?.value === (b.value ?? null);

/**
 * Does PayPal's authoritative readback agree with what the verified event claims? Status is not
 * compared: events arrive out of order and the readback is newer, so readback status wins. Identity
 * and money must match exactly. Returns null when they agree, else the first disagreement.
 */
export function eventAgreesWithReadback(s: EventSummary, raw: OrderReadback): string | null {
  if (raw.id !== s.resource.order_id) return "readback order id differs from event";
  const unit = raw.purchase_units?.[0];
  if (!unit || (raw.purchase_units?.length ?? 0) !== 1) return "readback purchase units not exactly one";
  if (s.resource.custom_id !== null && unit.custom_id !== s.resource.custom_id) return "custom_id differs between event and readback";
  if (s.event_type.startsWith("PAYMENT.CAPTURE.")) {
    const cap = unit.payments?.captures?.find((c) => c.id === s.resource.id);
    if (!cap) return "event capture id not present in readback";
    if (s.resource.amount && !sameAmount(s.resource.amount, cap.amount)) return "capture amount differs between event and readback";
  } else if (s.resource.amount && !sameAmount(s.resource.amount, unit.amount)) {
    return "order amount differs between event and readback";
  }
  return null;
}

/**
 * Asynchronous processing of verified events (after the 2xx). Each event is leased with one atomic
 * UPDATE, so a crash or a second process cannot double-process; an expired lease is reclaimed.
 * Payment state changes only through CheckoutService.readbackIf (authoritative GET), and only for
 * orders this merchant created, when event and readback agree.
 */
export class WebhookProcessor {
  readonly #now: () => number;
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  readonly #base: number;
  readonly #maxBackoff: number;
  #draining: Promise<number> | null = null;
  #again = false;

  constructor(
    private readonly inbox: WebhookInbox,
    private readonly checkout: CheckoutService,
    private readonly opts: ProcessorOptions,
  ) {
    this.#now = opts.now ?? Date.now;
    this.#leaseMs = opts.leaseMs ?? 60_000;
    this.#maxAttempts = opts.maxAttempts ?? 10;
    this.#base = opts.baseBackoffMs ?? 5_000;
    this.#maxBackoff = opts.maxBackoffMs ?? 600_000;
  }

  #log(level: keyof Logger, obj: object) {
    try {
      this.opts.log[level]({ evt: "webhook_event", ...obj });
    } catch {
      /* never changes an outcome */
    }
  }

  backoffMs(attempts: number) {
    return Math.min(this.#base * 2 ** Math.max(0, attempts - 1), this.#maxBackoff);
  }

  /** Process every due event. Single flight per process; a kick during a drain causes one more pass. */
  drain(max = 100): Promise<number> {
    if (this.#draining) {
      this.#again = true;
      return this.#draining;
    }
    const run = async () => {
      let n = 0;
      while (n < max) {
        this.#again = false;
        const row = this.inbox.claimNext(this.#now(), this.#leaseMs);
        if (!row) {
          await Promise.resolve();
          if (this.#again) continue;
          break;
        }
        n++;
        await this.#one(row);
      }
      return n;
    };
    this.#draining = run().finally(() => (this.#draining = null));
    return this.#draining;
  }

  kick() {
    this.drain().catch((err) => this.#log("error", { evt2: "drain_failed", errName: (err as Error)?.name }));
  }

  async #one(row: EventRow) {
    let d: Decision;
    try {
      d = row.process_attempts > this.#maxAttempts ? { to: "failed", outcome: `gave up after ${row.process_attempts - 1} attempts` } : await this.decide(row);
    } catch (err) {
      d = { to: "retryable_failure", outcome: `local error ${(err as Error)?.name ?? "unknown"}`, retry: true };
    }
    const next = d.to === "retryable_failure" ? this.#now() + this.backoffMs(row.process_attempts) : 0;
    let ok = false;
    try {
      ok = this.inbox.finishEvent(row.event_id, row.process_attempts, d.to, { outcome: d.outcome, attemptId: d.attemptId ?? null, nextAttemptAtMs: next });
    } catch (err) {
      // Lease stays; it expires and the event is reclaimed. Readback is idempotent, so redoing it is safe.
      this.#log("error", { eventId: row.event_id, evt2: "finish_failed", errName: (err as Error)?.name });
      return;
    }
    this.#log(ok ? "info" : "warn", { eventId: row.event_id, type: row.event_type, state: ok ? d.to : "lease_lost", outcome: d.outcome, attempt: row.process_attempts });
  }

  /** Decide one leased event. Exposed for tests. */
  async decide(row: EventRow): Promise<Decision> {
    const s = JSON.parse(row.summary_json) as EventSummary;
    if (!HANDLED_TYPES.has(s.event_type)) return { to: "ignored", outcome: `event type ${s.event_type} not handled` };
    const orderId = s.resource.order_id;
    if (!orderId) return { to: "foreign", outcome: "event carries no order id" };
    const ours = this.checkout.ownsOrder(orderId);
    if (!ours) return { to: "foreign", outcome: "order not created by this merchant; no readback" };
    if (s.resource.custom_id !== null && s.resource.custom_id !== ours.intentId) {
      return { to: "disagreed", outcome: "event custom_id differs from local intent; no readback", attemptId: ours.attemptId };
    }
    try {
      const r = await this.checkout.readbackIf(orderId, `wh_${row.event_id}_${row.process_attempts}`, (raw) => eventAgreesWithReadback(s, raw));
      if (!r.applied) return { to: "disagreed", outcome: `readback disagrees: ${r.reason}`, attemptId: ours.attemptId };
      return { to: "processed", outcome: `readback applied; attempt state ${r.result.state}`, attemptId: ours.attemptId };
    } catch (err) {
      if (err instanceof PayPalError) return { to: "retryable_failure", outcome: `readback failed: ${err.kind}`, attemptId: ours.attemptId, retry: true };
      throw err;
    }
  }
}
