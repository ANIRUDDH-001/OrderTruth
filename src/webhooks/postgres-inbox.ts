import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/postgres.ts";
import type { EventSummary } from "./event.ts";
import type { DeliveryRow, EventRow, EventState } from "./inbox.ts";

/** Durable PostgreSQL inbox. Only the signature-verifying intake may accept a
 * delivery. External verification is completed before these transactions start. */
export class PostgresWebhookInbox {
  constructor(readonly pool: Pool, readonly schema = "ordertruth", private readonly provenance: "PAYPAL_SANDBOX_POSTBACK" | "SYNTHETIC_QUALIFICATION" = "PAYPAL_SANDBOX_POSTBACK") {
    if (schema !== "ordertruth" && !/^qual_[a-f0-9]{20}$/.test(schema)) throw new Error("Invalid OrderTruth schema");
    if (provenance === "SYNTHETIC_QUALIFICATION" && process.env.NODE_ENV !== "test") throw new Error("Synthetic webhook verification is test-only");
  }
  private tx<T>(action: (client: PoolClient) => Promise<T>) {
    return withTransaction(this.pool, async client => {
      await client.query("SELECT set_config('search_path',$1,true)", [`${this.schema},pg_catalog`]);
      return action(client);
    });
  }
  private async lockPayment(client: PoolClient, orderId: string | null) {
    if (!orderId) return;
    const row = (await client.query("SELECT intent_id FROM payment_attempts WHERE paypal_order_id=$1 FOR UPDATE", [orderId])).rows[0];
    if (row) await client.query("SELECT id FROM checkout_intents WHERE id=$1 FOR UPDATE", [row.intent_id]);
  }
  async recordDelivery(d: { claimedEventId: string | null; claimedEventType: string | null; bodySha256: string; bodyBytes: number; correlationId: string; nowMs: number }): Promise<number> {
    return this.tx(async client => {
      // Bound unauthenticated storage across processes, not just inside one server.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${this.schema}:webhook-admission`]);
      const count = (await client.query("SELECT count(*)::integer AS n FROM webhook_deliveries WHERE state<>'verified'")).rows[0].n;
      if (count >= 5000) throw new Error("Webhook inbox admission limit reached");
      const at = new Date().toISOString();
      return (await client.query(`INSERT INTO webhook_deliveries(state,claimed_event_id,claimed_event_type,body_sha256,body_bytes,correlation_id,received_at_ms,created_at,updated_at)
        VALUES('received_unverified',$1,$2,$3,$4,$5,$6,$7,$7) RETURNING seq`, [d.claimedEventId,d.claimedEventType,d.bodySha256,d.bodyBytes,d.correlationId,d.nowMs,at])).rows[0].seq as number;
    });
  }
  async countStoredUnverified(): Promise<number> {
    return this.tx(async client => (await client.query("SELECT count(*)::integer AS n FROM webhook_deliveries WHERE state<>'verified'")).rows[0].n as number);
  }
  async noteTransmission(seq: number, transmissionId: string, transmissionTime: string): Promise<void> {
    await this.tx(async client => { await client.query("UPDATE webhook_deliveries SET transmission_id=$1,transmission_time=$2,updated_at=$3 WHERE seq=$4 AND state='received_unverified'", [transmissionId,transmissionTime,new Date().toISOString(),seq]); });
  }
  async finishUnverified(seq: number, to: "rejected" | "retryable_failure" | "abandoned", reason: string, verify?: { ms: number; debugId: string | null }): Promise<boolean> {
    return this.tx(async client => (await client.query(`UPDATE webhook_deliveries SET state=$1,reason=$2,verify_ms=COALESCE($3,verify_ms),verify_debug_id=COALESCE($4,verify_debug_id),updated_at=$5
      WHERE seq=$6 AND state='received_unverified'`, [to,reason.slice(0,200),verify?.ms ?? null,verify?.debugId ?? null,new Date().toISOString(),seq])).rowCount === 1);
  }
  async acceptVerified(seq: number, summary: EventSummary, verify: { ms: number; debugId: string | null }, correlationId: string): Promise<"accepted" | "duplicate"> {
    return this.tx(async client => {
      await this.lockPayment(client,summary.resource.order_id);
      // Serialize the event identity even when it has no row yet. Never reserve
      // an event ID before successful signature verification.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${this.schema}:webhook:${summary.id}`]);
      const existing = (await client.query("SELECT event_id FROM webhook_events WHERE event_id=$1", [summary.id])).rowCount;
      const at = new Date().toISOString();
      const updated = await client.query(`UPDATE webhook_deliveries SET state=$1,reason=$2,verify_ms=$3,verify_debug_id=$4,updated_at=$5
        WHERE seq=$6 AND state='received_unverified' AND claimed_event_id=$7`, [existing ? "duplicate" : "verified",existing ? "verified duplicate of a stored event" : "paypal_postback SUCCESS",verify.ms,verify.debugId,at,seq,summary.id]);
      if (updated.rowCount !== 1) throw new Error("Delivery is not open or event identity differs");
      if (existing) {
        await client.query("UPDATE webhook_events SET deliveries=deliveries+1,updated_at=$1 WHERE event_id=$2", [at,summary.id]);
        return "duplicate";
      }
      await client.query(`INSERT INTO webhook_events(event_id,event_type,resource_type,event_create_time,first_delivery_seq,state,order_id,summary_json,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,'verified_pending',$6,$7,$8,$8)`, [summary.id,summary.event_type,summary.resource_type,summary.create_time,seq,summary.resource.order_id,JSON.stringify(summary),at]);
      await client.query(`INSERT INTO evidence(attempt_id,evidence_class,operation,http_status,paypal_debug_id,request_id,correlation_id,duration_ms,summary_json,created_at)
        VALUES(NULL,'PAYPAL_VERIFIED_WEBHOOK','webhook_verified',NULL,$1,NULL,$2,$3,$4,$5)`, [verify.debugId,correlationId,verify.ms,JSON.stringify({ delivery_seq: seq,verification: "paypal_postback",provenance: this.provenance,event: summary }),at]);
      return "accepted";
    });
  }
  async claimNext(nowMs: number, leaseMs: number): Promise<EventRow | undefined> {
    if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || !Number.isSafeInteger(nowMs + leaseMs)) throw new Error("Invalid webhook lease clock");
    return this.tx(async client => {
      const candidate = (await client.query<EventRow>(`SELECT * FROM webhook_events WHERE (state IN('verified_pending','retryable_failure') AND next_attempt_at_ms<=$1)
        OR (state='processing' AND lease_until_ms<=$1) ORDER BY first_delivery_seq LIMIT 1`, [nowMs])).rows[0];
      if (!candidate) return undefined;
      // Payment -> intent -> event, shared with repair. Recheck eligibility after
      // taking the payment lock so a competing worker cannot steal a live lease.
      await this.lockPayment(client,candidate.order_id);
      return (await client.query<EventRow>(`UPDATE webhook_events SET state='processing',process_attempts=process_attempts+1,lease_until_ms=$2,updated_at=$3
        WHERE event_id=$4 AND ((state IN('verified_pending','retryable_failure') AND next_attempt_at_ms<=$1) OR (state='processing' AND lease_until_ms<=$1)) RETURNING *`, [nowMs,nowMs+leaseMs,new Date().toISOString(),candidate.event_id])).rows[0];
    });
  }
  async finishEvent(eventId: string, leaseAttempt: number, to: Exclude<EventState,"verified_pending" | "processing">, o: { outcome: string; attemptId?: string | null; nextAttemptAtMs?: number }): Promise<boolean> {
    return this.tx(async client => {
      const event = (await client.query<EventRow>("SELECT * FROM webhook_events WHERE event_id=$1", [eventId])).rows[0];
      if (!event) return false;
      await this.lockPayment(client,event.order_id);
      return (await client.query(`UPDATE webhook_events SET state=$1,outcome=$2,attempt_id=COALESCE($3,attempt_id),next_attempt_at_ms=$4,lease_until_ms=NULL,updated_at=$5
        WHERE event_id=$6 AND state='processing' AND process_attempts=$7`, [to,o.outcome.slice(0,300),o.attemptId ?? null,o.nextAttemptAtMs ?? 0,new Date().toISOString(),eventId,leaseAttempt])).rowCount === 1;
    });
  }
  async abandonStale(olderThanMs: number): Promise<number> {
    return this.tx(async client => (await client.query("UPDATE webhook_deliveries SET state='abandoned',reason='open at restart; provider must redeliver',updated_at=$1 WHERE state='received_unverified' AND received_at_ms<=$2", [new Date().toISOString(),olderThanMs])).rowCount ?? 0);
  }
  async getEvent(eventId: string): Promise<EventRow | undefined> {
    return this.tx(async client => (await client.query<EventRow>("SELECT * FROM webhook_events WHERE event_id=$1", [eventId])).rows[0]);
  }
  async getDelivery(seq: number): Promise<DeliveryRow | undefined> {
    return this.tx(async client => (await client.query<DeliveryRow>("SELECT * FROM webhook_deliveries WHERE seq=$1", [seq])).rows[0]);
  }
}
