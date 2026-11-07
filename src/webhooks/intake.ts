import { createHash } from "node:crypto";
import type { Logger } from "../checkout-service.ts";
import { claimedIdentity, EventSchema, parseTransmissionHeaders, summarizeEvent, type EventSummary } from "./event.ts";
import type { WebhookInbox } from "./inbox.ts";
import type { WebhookVerifier } from "./verifier.ts";

export type IntakeResponse = { status: number; body: { ok: boolean; result?: "accepted" | "duplicate"; error?: string; delivery?: number } };

export type IntakeOptions = {
  /** Configured Sandbox webhook id. Required: the listener refuses to start without it. */
  webhookId: string;
  maxTransmissionAgeMs: number;
  maxFutureSkewMs: number;
  /**
   * Legacy persist-before-verify adapters: ceiling on deliveries that did not become a new verified event (rejected, retryable,
   * abandoned, open, duplicate). At the ceiling a request is refused with 503 before any row is
   * written. Default 5000. PostgreSQL instead verifies before persistence, stores
   * no rejected inputs and does not add rows for authenticated redeliveries.
   */
  maxStoredUnverified?: number;
  /** Concurrent postbacks allowed; beyond this, 503 so PayPal retries (bounds outbound amplification). */
  maxConcurrentVerifications?: number;
  now?: () => number;
  log: Logger;
  /** Called after a 2xx-worthy commit, before the response is sent. Must not throw. */
  onAccepted?: () => void;
  /** TEST HOOK (process tests): invoked after PayPal SUCCESS and before the durable commit. */
  afterVerify?: () => void;
};

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });
type IntakeMethod = "recordDelivery" | "countStoredUnverified" | "noteTransmission" | "finishUnverified" | "acceptVerified";
export type AuthenticatedDelivery = Parameters<WebhookInbox["recordDelivery"]>[0] & { transmissionId: string; transmissionTime: string };
export type IntakeInbox = { [K in IntakeMethod]: (...args: Parameters<WebhookInbox[K]>) => ReturnType<WebhookInbox[K]> | Promise<ReturnType<WebhookInbox[K]>> } & {
  /** PostgreSQL verifies first, then atomically persists new accepted proof only.
   * Rejected inputs and authenticated duplicates cannot consume durable storage.
   * Only call after successful signature verification, never on claimed identity. */
  persistAuthenticated?: (delivery: AuthenticatedDelivery, summary: EventSummary, verify: { ms: number; debugId: string | null }) => Promise<{ result: "accepted" | "duplicate"; seq: number }>;
};

/**
 * Legacy adapter order (SQLite). PostgreSQL with persistAuthenticated validates
 * and verifies first, then atomically persists accepted proof; no durable reject
 * or duplicate rows are added. Both paths acknowledge only after durable proof.
 * Legacy order of operations:
 *   0. (app) global rate limit, then (here) the stored-unverified ceiling — 429/503, nothing stored
 *   1. durable delivery row (received_unverified) — failure: 503, nothing claimed
 *   2. structure, headers, transmission-time window — failure: 400, delivery rejected
 *   3. PayPal postback — FAILURE: 400 rejected; no definitive answer: 503 retryable
 *   4. one transaction: delivery verified|duplicate + event row (dedup by event id) + evidence
 *   5. only then 200
 * Nothing here changes payment or merchant state; that happens later, in the processor, only via
 * authoritative PayPal readback.
 */
export class WebhookIntake {
  #active = 0;
  readonly #now: () => number;
  readonly #max: number;
  readonly #ceiling: number;

  constructor(
    private readonly inbox: IntakeInbox,
    private readonly verifier: WebhookVerifier,
    private readonly opts: IntakeOptions,
  ) {
    if (!/^[A-Za-z0-9]{1,50}$/.test(opts.webhookId)) throw new Error("WebhookIntake requires a configured webhook id");
    this.#now = opts.now ?? Date.now;
    this.#max = opts.maxConcurrentVerifications ?? 8;
    this.#ceiling = opts.maxStoredUnverified ?? 5000;
  }

  #log(level: keyof Logger, obj: object) {
    try {
      this.opts.log[level]({ evt: "webhook_delivery", ...obj });
    } catch {
      /* logging never changes an outcome */
    }
  }

  async #reject(seq: number, status: number, reason: string, verify?: { ms: number; debugId: string | null }): Promise<IntakeResponse> {
    const to = status === 503 ? "retryable_failure" : "rejected";
    try {
      await this.inbox.finishUnverified(seq, to, reason, verify);
    } catch (err) {
      // The row stays received_unverified and is closed as abandoned at the next start. No 2xx either way.
      this.#log("warn", { seq, evt2: "delivery_close_failed", errName: (err as Error)?.name });
    }
    this.#log(status === 503 ? "warn" : "info", { seq, state: to, reason });
    return { status, body: { ok: false, error: reason.split(":")[0]!, delivery: seq } };
  }

  async receive(raw: Buffer, headers: Record<string, string | string[] | undefined>, correlationId: string): Promise<IntakeResponse> {
    const nowMs = this.#now();
    let text: string | null = null;
    let parsed: unknown;
    try {
      text = fatalUtf8.decode(raw);
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const claimed = claimedIdentity(parsed);

    let seq: number | undefined;
    const reject = async (status: number,reason: string,verify?: { ms: number; debugId: string | null }): Promise<IntakeResponse> => {
      if (seq !== undefined) return this.#reject(seq,status,reason,verify);
      this.#log(status === 503 ? "warn" : "info", { state: "not_recorded",reason,correlationId });
      return { status,body: { ok: false,error: reason.split(":")[0]! } };
    };
    if (!this.inbox.persistAuthenticated) try {
      if (await this.inbox.countStoredUnverified() >= this.#ceiling) {
        this.#log("warn", { state: "not_recorded", reason: "inbox_ceiling", ceiling: this.#ceiling });
        return { status: 503, body: { ok: false, error: "inbox_ceiling" } };
      }
      seq = await this.inbox.recordDelivery({
        claimedEventId: claimed.id,
        claimedEventType: claimed.type,
        bodySha256: createHash("sha256").update(raw).digest("hex"),
        bodyBytes: raw.length,
        correlationId,
        nowMs,
      });
    } catch (err) {
      this.#log("error", { state: "not_recorded", reason: "inbox_write_failed", errName: (err as Error)?.name });
      return { status: 503, body: { ok: false, error: "inbox_unavailable" } };
    }

    if (parsed === undefined || text === null) return reject(400, "malformed_json");
    const ev = EventSchema.safeParse(parsed);
    if (!ev.success) return reject(400, `invalid_event_structure:${ev.error.issues.map((i) => i.path.join(".") || "root").slice(0, 5).join(",")}`);
    const h = parseTransmissionHeaders(headers);
    if ("reason" in h) return reject(400, h.reason);
    try {
      if (seq !== undefined) await this.inbox.noteTransmission(seq, h.transmissionId, h.transmissionTime);
    } catch {
      return reject(503, "inbox_write_failed");
    }
    if (nowMs - h.transmissionTimeMs > this.opts.maxTransmissionAgeMs) return reject(400, "transmission_expired");
    if (h.transmissionTimeMs - nowMs > this.opts.maxFutureSkewMs) return reject(400, "transmission_in_future");

    if (this.#active >= this.#max) return reject(503, "verifier_busy");
    this.#active++;
    let v: Awaited<ReturnType<WebhookVerifier["verify"]>>;
    try {
      v = await this.verifier.verify({ rawBody: text, headers: h, webhookId: this.opts.webhookId, correlationId });
    } catch {
      v = { status: "UNAVAILABLE", kind: "verifier_threw", durationMs: 0, debugId: null };
    } finally {
      this.#active--;
    }
    const vm = { ms: v.durationMs, debugId: v.debugId };
    if (v.status === "FAILURE") return reject(400, "signature_invalid", vm);
    if (v.status === "UNAVAILABLE") return reject(503, `verification_unavailable:${v.kind}`, vm);

    this.opts.afterVerify?.();
    let result: "accepted" | "duplicate";
    try {
      if (this.inbox.persistAuthenticated) {
        const committed = await this.inbox.persistAuthenticated({ claimedEventId: claimed.id,claimedEventType: claimed.type,
          bodySha256: createHash("sha256").update(raw).digest("hex"),bodyBytes: raw.length,correlationId,nowMs,
          transmissionId: h.transmissionId,transmissionTime: h.transmissionTime },summarizeEvent(ev.data),vm);
        result = committed.result; seq = committed.seq;
      } else {
        if (seq === undefined) throw new Error("Missing durable delivery");
        result = await this.inbox.acceptVerified(seq, summarizeEvent(ev.data), vm, correlationId);
      }
    } catch (err) {
      this.#log("error", { seq, reason: "persist_failed", errName: (err as Error)?.name });
      return reject(503, "persist_failed", vm);
    }
    this.#log("info", { seq, state: result === "accepted" ? "verified" : "duplicate", eventId: ev.data.id, type: ev.data.event_type, verifyMs: v.durationMs });
    try {
      this.opts.onAccepted?.();
    } catch {
      /* processing is kicked best-effort; the interval and startup sweep pick it up anyway */
    }
    return { status: 200, body: { ok: true, result, delivery: seq } };
  }
}
