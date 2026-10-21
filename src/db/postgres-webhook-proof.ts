import type { PoolClient } from "pg";
import type { AttemptRow } from "./store.ts";
import type { DeliveryRow, EventRow } from "../webhooks/inbox.ts";
import type { EventSummary } from "../webhooks/event.ts";
import { canonical } from "../domain/canonical.ts";

type Audit = { seq: number; subject: string; subject_id: string; from_state: string | null; to_state: string; reason: string | null };
type Proof = { seq: number; attempt_id: string | null; operation: string; paypal_debug_id: string | null; correlation_id: string; duration_ms: number | null; summary_json: string };
const refuse = (): never => { throw new Error("Webhook provenance invalid or contradictory; repair refused"); };
function parsed<T>(raw: string): T { try { return JSON.parse(raw) as T; } catch { return refuse(); } }

/** Existing persisted postback/evidence/audit proof, not a fresh PayPal signature
 * check. Caller holds payment -> intent locks. Webhook writers use that order. */
export async function postgresWebhookProof(client: PoolClient, attempt: AttemptRow) {
  const events = (await client.query<EventRow>("SELECT * FROM webhook_events WHERE attempt_id=$1 OR order_id=$2 ORDER BY event_id FOR UPDATE", [attempt.id,attempt.paypal_order_id])).rows;
  const eventIds = events.map(e => e.event_id); const deliveryIds = events.map(e => e.first_delivery_seq);
  // Either side selects evidence: a contradictory link cannot hide a record.
  const proofs = (await client.query<Proof>(`SELECT * FROM evidence WHERE evidence_class='PAYPAL_VERIFIED_WEBHOOK' AND (
    attempt_id=$1 OR summary_json::jsonb->'event'->>'id'=ANY($2::text[])
    OR summary_json::jsonb->>'delivery_seq'=ANY($3::text[])
    OR summary_json::jsonb->'event'->'resource'->>'order_id'=$4) ORDER BY seq`, [attempt.id,eventIds,deliveryIds.map(String),attempt.paypal_order_id])).rows;
  if (!events.length) { if (proofs.length) refuse(); return null; }
  if (events.length > 200 || proofs.length > 400) throw new Error("Webhook proof exceeds bounded repair scope");
  if (proofs.length !== events.length) refuse();
  const deliveries = (await client.query<DeliveryRow>(`SELECT * FROM webhook_deliveries WHERE seq=ANY($1::bigint[])
    OR (claimed_event_id=ANY($2::text[]) AND state IN('verified','duplicate')) ORDER BY seq FOR UPDATE`, [deliveryIds,eventIds])).rows;
  const audit = (await client.query<Audit>(`SELECT * FROM webhook_audit WHERE (subject='event' AND subject_id=ANY($1::text[]))
    OR (subject='delivery' AND subject_id=ANY($2::text[])) ORDER BY seq`, [eventIds,deliveries.map(d => String(d.seq))])).rows;
  if (deliveries.length > 2000 || audit.length > 10000) throw new Error("Webhook proof exceeds bounded repair scope");
  const rules = (await client.query<{ subject: string; from_state: string; to_state: string }>("SELECT * FROM webhook_transitions ORDER BY subject,from_state,to_state")).rows;
  const chain = (subject: string,id: string,initial: string,current: string,reason?: string) => {
    const history = audit.filter(a => a.subject === subject && a.subject_id === id);
    if (!history.length || history[0]!.from_state !== null || history[0]!.to_state !== initial || (reason !== undefined && history[0]!.reason !== reason)) refuse();
    for (let n = 1; n < history.length; n++) {
      const step = history[n]!;
      if (step.from_state !== history[n-1]!.to_state || !rules.some(r => r.subject === subject && r.from_state === step.from_state && r.to_state === step.to_state)) refuse();
    }
    if (history.at(-1)!.to_state !== current) refuse();
    return history;
  };
  for (const event of events) {
    const delivery = deliveries.find(d => d.seq === event.first_delivery_seq);
    if (!delivery || delivery.state !== "verified" || delivery.claimed_event_id !== event.event_id || delivery.claimed_event_type !== event.event_type) refuse();
    const summary = parsed<Partial<EventSummary> | null>(event.summary_json);
    if (!summary || summary.id !== event.event_id || summary.event_type !== event.event_type || summary.resource_type !== event.resource_type
      || summary.create_time !== event.event_create_time || !summary.resource || summary.resource.order_id !== event.order_id
      || (event.attempt_id !== null && (event.attempt_id !== attempt.id || event.order_id !== attempt.paypal_order_id))) refuse();
    const linked = proofs.filter(e => {
      const p = parsed<{ delivery_seq?: number; event?: { id?: string } } | null>(e.summary_json);
      return p?.event?.id === event.event_id || p?.delivery_seq === event.first_delivery_seq;
    });
    if (linked.length !== 1) refuse();
    const e = linked[0]!;
    const proof = parsed<{ delivery_seq?: number; verification?: string; event?: unknown } | null>(e.summary_json);
    if (!proof || proof.delivery_seq !== event.first_delivery_seq || proof.verification !== "paypal_postback" || canonical(proof.event) !== canonical(summary)
      || (e.attempt_id !== null && e.attempt_id !== event.attempt_id) || e.operation !== "webhook_verified"
      || e.paypal_debug_id !== delivery!.verify_debug_id || e.duration_ms !== delivery!.verify_ms || e.correlation_id !== delivery!.correlation_id) refuse();
    const history = chain("delivery",String(event.first_delivery_seq),"received_unverified","verified");
    if (history.length !== 2 || history[1]!.from_state !== "received_unverified") refuse();
    chain("event",event.event_id,"verified_pending",event.state,`delivery ${event.first_delivery_seq}`);
  }
  return { events,deliveries,audit,proofs,transitionRules: rules };
}
