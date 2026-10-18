import type { Store } from "../db/store.ts";
import type { EventSummary } from "./event.ts";

export type DeliveryState = "received_unverified" | "verified" | "duplicate" | "rejected" | "retryable_failure" | "abandoned";
export type EventState = "verified_pending" | "processing" | "processed" | "foreign" | "ignored" | "disagreed" | "retryable_failure" | "failed";
export const EVENT_TERMINAL: readonly EventState[] = ["processed", "foreign", "ignored", "disagreed", "failed"];

export type DeliveryRow = {
  seq: number;
  state: DeliveryState;
  claimed_event_id: string | null;
  claimed_event_type: string | null;
  transmission_id: string | null;
  transmission_time: string | null;
  body_sha256: string;
  body_bytes: number;
  reason: string | null;
  correlation_id: string;
  verify_ms: number | null;
  verify_debug_id: string | null;
  received_at_ms: number;
};

export type EventRow = {
  event_id: string;
  event_type: string;
  resource_type: string | null;
  event_create_time: string | null;
  first_delivery_seq: number;
  deliveries: number;
  state: EventState;
  order_id: string | null;
  attempt_id: string | null;
  process_attempts: number;
  next_attempt_at_ms: number;
  lease_until_ms: number | null;
  outcome: string | null;
  summary_json: string;
};

const now = () => new Date().toISOString();

/**
 * Durable webhook inbox on the shared SQLite store. Dedup key = PayPal event id, but only from
 * verified deliveries (DB trigger enforced). Every state change is audited by DB triggers.
 */
export class WebhookInbox {
  constructor(readonly store: Store) {}

  get #db() {
    return this.store.db;
  }

  /** Must succeed before anything else happens to a request; failure means "not safe, ask PayPal to retry". */
  recordDelivery(d: { claimedEventId: string | null; claimedEventType: string | null; bodySha256: string; bodyBytes: number; correlationId: string; nowMs: number }): number {
    const ts = now();
    const r = this.#db
      .prepare(
        `INSERT INTO webhook_deliveries (state, claimed_event_id, claimed_event_type, body_sha256, body_bytes, correlation_id, received_at_ms, created_at, updated_at)
         VALUES ('received_unverified', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.claimedEventId, d.claimedEventType, d.bodySha256, d.bodyBytes, d.correlationId, d.nowMs, ts, ts);
    return Number(r.lastInsertRowid);
  }

  noteTransmission(seq: number, transmissionId: string, transmissionTime: string) {
    this.#db.prepare("UPDATE webhook_deliveries SET transmission_id = ?, transmission_time = ?, updated_at = ? WHERE seq = ? AND state = 'received_unverified'").run(transmissionId, transmissionTime, now(), seq);
  }

  /** Close an unverified delivery as rejected / retryable / abandoned. Never touches events. */
  finishUnverified(seq: number, to: "rejected" | "retryable_failure" | "abandoned", reason: string, verify?: { ms: number; debugId: string | null }): boolean {
    const r = this.#db
      .prepare("UPDATE webhook_deliveries SET state = ?, reason = ?, verify_ms = COALESCE(?, verify_ms), verify_debug_id = COALESCE(?, verify_debug_id), updated_at = ? WHERE seq = ? AND state = 'received_unverified'")
      .run(to, reason.slice(0, 200), verify?.ms ?? null, verify?.debugId ?? null, now(), seq);
    return Number(r.changes) === 1;
  }

  /**
   * After PayPal SUCCESS: in one transaction, mark the delivery verified and create the event, or
   * mark it a duplicate of the existing event. Also appends PAYPAL_VERIFIED_WEBHOOK evidence for a
   * first delivery. Only once this commits may the endpoint return 2xx.
   */
  acceptVerified(seq: number, summary: EventSummary, verify: { ms: number; debugId: string | null }, correlationId: string): "accepted" | "duplicate" {
    return this.store.tx(() => {
      const ts = now();
      const existing = this.#db.prepare("SELECT event_id FROM webhook_events WHERE event_id = ?").get(summary.id);
      const to: DeliveryState = existing ? "duplicate" : "verified";
      const r = this.#db
        .prepare("UPDATE webhook_deliveries SET state = ?, reason = ?, verify_ms = ?, verify_debug_id = ?, updated_at = ? WHERE seq = ? AND state = 'received_unverified' AND claimed_event_id = ?")
        .run(to, existing ? "verified duplicate of a stored event" : "paypal_postback SUCCESS", verify.ms, verify.debugId, ts, seq, summary.id);
      if (Number(r.changes) !== 1) throw new Error("delivery is not open or its event id differs");
      if (existing) {
        this.#db.prepare("UPDATE webhook_events SET deliveries = deliveries + 1, updated_at = ? WHERE event_id = ?").run(ts, summary.id);
        return "duplicate";
      }
      this.#db
        .prepare(
          `INSERT INTO webhook_events (event_id, event_type, resource_type, event_create_time, first_delivery_seq, state, order_id, summary_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'verified_pending', ?, ?, ?, ?)`,
        )
        .run(summary.id, summary.event_type, summary.resource_type, summary.create_time, seq, summary.resource.order_id, JSON.stringify(summary), ts, ts);
      this.store.appendEvidence({
        attemptId: null,
        evidenceClass: "PAYPAL_VERIFIED_WEBHOOK",
        operation: "webhook_verified",
        httpStatus: null,
        debugId: verify.debugId,
        requestId: null,
        correlationId,
        durationMs: verify.ms,
        summary: { delivery_seq: seq, verification: "paypal_postback", event: summary },
      });
      return "accepted";
    });
  }

  /**
   * Lease the next due event (pending, retryable and due, or a processing lease that expired after
   * a crash). One UPDATE, so concurrent processors in any process cannot both take it.
   */
  claimNext(nowMs: number, leaseMs: number): EventRow | undefined {
    return this.#db
      .prepare(
        `UPDATE webhook_events SET state = 'processing', process_attempts = process_attempts + 1, lease_until_ms = ?, updated_at = ?
         WHERE event_id = (
           SELECT event_id FROM webhook_events
           WHERE (state IN ('verified_pending', 'retryable_failure') AND next_attempt_at_ms <= ?) OR (state = 'processing' AND lease_until_ms <= ?)
           ORDER BY first_delivery_seq LIMIT 1)
         AND ((state IN ('verified_pending', 'retryable_failure') AND next_attempt_at_ms <= ?) OR (state = 'processing' AND lease_until_ms <= ?))
         RETURNING *`,
      )
      .get(nowMs + leaseMs, now(), nowMs, nowMs, nowMs, nowMs) as EventRow | undefined;
  }

  /** Complete a lease. Applies only if this lease is still the current one (attempt counter guard). */
  finishEvent(eventId: string, leaseAttempt: number, to: Exclude<EventState, "verified_pending" | "processing">, o: { outcome: string; attemptId?: string | null; nextAttemptAtMs?: number }): boolean {
    const r = this.#db
      .prepare(
        `UPDATE webhook_events SET state = ?, outcome = ?, attempt_id = COALESCE(?, attempt_id), next_attempt_at_ms = ?, lease_until_ms = NULL, updated_at = ?
         WHERE event_id = ? AND state = 'processing' AND process_attempts = ?`,
      )
      .run(to, o.outcome.slice(0, 300), o.attemptId ?? null, o.nextAttemptAtMs ?? 0, now(), eventId, leaseAttempt);
    return Number(r.changes) === 1;
  }

  /** Startup: deliveries left open by a crash never got a 2xx, so PayPal retries them. Close them as abandoned. */
  abandonStale(olderThanMs: number): number {
    const r = this.#db
      .prepare("UPDATE webhook_deliveries SET state = 'abandoned', reason = 'open at restart; no 2xx was sent; PayPal redelivers', updated_at = ? WHERE state = 'received_unverified' AND received_at_ms <= ?")
      .run(now(), olderThanMs);
    return Number(r.changes);
  }

  getEvent(eventId: string): EventRow | undefined {
    return this.#db.prepare("SELECT * FROM webhook_events WHERE event_id = ?").get(eventId) as EventRow | undefined;
  }

  getDelivery(seq: number): DeliveryRow | undefined {
    return this.#db.prepare("SELECT * FROM webhook_deliveries WHERE seq = ?").get(seq) as DeliveryRow | undefined;
  }

  listDeliveries(): DeliveryRow[] {
    return this.#db.prepare("SELECT * FROM webhook_deliveries ORDER BY seq").all() as DeliveryRow[];
  }

  listEvents(): EventRow[] {
    return this.#db.prepare("SELECT * FROM webhook_events ORDER BY first_delivery_seq").all() as EventRow[];
  }

  listAudit(): Array<{ seq: number; subject: string; subject_id: string; from_state: string | null; to_state: string; reason: string | null }> {
    return this.#db.prepare("SELECT seq, subject, subject_id, from_state, to_state, reason FROM webhook_audit ORDER BY seq").all() as never;
  }
}
