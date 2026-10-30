/**
 * The verifier's observer (plan Task 9; spec §10). Verdicts come only from this verifier-owned SQL, run as ot_observer in a
 * REPEATABLE READ READ ONLY snapshot, never from candidate code or its claims. A candidate's stdout claim counts only when
 * assertClaimCorroborated finds it in durable state.
 */
import { readFileSync } from "node:fs";
import type pg from "pg";

export type Order = { id: string; captureId: string; amountMinor: string; currency: string; paypalOrderId: string };
export type StateSnapshot = { ordersByIntent: Record<string, Order[]>;
  obligations: Array<{ key: string; intentId: string; captureId: string; resultId: string | null; callId: string }>;
  /** Each marker's recorded outcome and the references its outcome record binds (null where a field is absent). */
  markers: Array<{ callId: string; boundary: string; outcome: unknown; resultId: string | null; intentId: string | null; captureId: string | null;
    originalClaimCallId: string | null }>;
  intents: Array<{ callId: string; boundary: string; resolvedState: string | null }>;
  captureEvidence: Array<{ evidenceId: string; captureId: string; amountMinor: string }>;
  outboxKinds: Record<string, number>; outboxEventIds: string[] };
type Verdict = { ok: boolean; detail: string };

const ROLES_SQL = new URL("../sql/roles.sql", import.meta.url);
/** roles.sql split into its sections, with psql-style variables substituted (:'x' as a literal, :"x" as an identifier). */
export function rolesSql(vars: { candidate_password: string; observer_password: string; database: string }):
  { cluster: string; database: string; template: string; connect: string } {
  const text = readFileSync(ROLES_SQL, "utf8").replace(/\r\n/g, "\n");
  const values: Record<string, string> = vars;
  const substitute = (sql: string) => sql
    .replace(/:'([a-z_]+)'/g, (_m, name: string) => { const v = values[name]; if (v === undefined) throw new Error(`roles.sql: no value for :'${name}'`); return `'${v.replace(/'/g, "''")}'`; })
    .replace(/:"([a-z_]+)"/g, (_m, name: string) => { const v = values[name]; if (v === undefined) throw new Error(`roles.sql: no value for :"${name}"`); return `"${v.replace(/"/g, '""')}"`; });
  const [, cluster, database, template, connect] = text.split(/^-- @section (?:cluster|database|template|connect)$/m);
  if (cluster === undefined || database === undefined || template === undefined || connect === undefined)
    throw new Error("roles.sql: expected cluster, database, template and connect sections");
  return { cluster: substitute(cluster), database: substitute(database), template: substitute(template), connect: substitute(connect) };
}

export async function snapshot(observerPool: pg.Pool): Promise<StateSnapshot> {
  const c = await observerPool.connect();
  try {
    await c.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const orders = (await c.query<{ id: string; intent_id: string; capture_id: string; amount_minor: string; currency: string; paypal_order_id: string }>(
      "SELECT id, intent_id, capture_id, amount_minor::text AS amount_minor, currency, paypal_order_id FROM shop.orders ORDER BY created_at, id")).rows;
    const obligations = (await c.query<{ obligation_key: string; intent_id: string; capture_id: string; result_id: string | null; claimed_by_call_id: string }>(
      "SELECT obligation_key, intent_id, capture_id, result_id, claimed_by_call_id FROM ordertruth_guard.obligations ORDER BY created_at, obligation_key")).rows;
    const markers = (await c.query<{ call_id: string; boundary: string; outcome: unknown; result_id: string | null; intent_id: string | null; capture_id: string | null;
        original_claim_call_id: string | null }>(
      `SELECT call_id, boundary, outcome_record->>'outcome' AS outcome, outcome_record->'result'->>'id' AS result_id,
              outcome_record->'identity'->>'intentId' AS intent_id, outcome_record->'identity'->>'captureId' AS capture_id,
              outcome_record->>'originalClaimCallId' AS original_claim_call_id
       FROM ordertruth_guard.commit_markers ORDER BY created_at, call_id`)).rows;
    const intents = (await c.query<{ call_id: string; boundary: string; resolved_state: string | null }>(
      "SELECT call_id, boundary, resolved_state FROM ordertruth_guard.commit_intents ORDER BY created_at, call_id")).rows;
    const evidence = (await c.query<{ evidence_id: string; capture_id: string; amount_minor: string }>(
      "SELECT evidence_id, capture_id, amount_minor::text AS amount_minor FROM ordertruth_guard.capture_evidence ORDER BY created_at, evidence_id")).rows;
    const outbox = (await c.query<{ event_id: string; kind: string }>("SELECT event_id, kind FROM ordertruth_guard.outbox ORDER BY created_at, event_id")).rows;
    await c.query("COMMIT");
    const ordersByIntent: Record<string, Order[]> = {};
    for (const o of orders) (ordersByIntent[o.intent_id] ??= []).push({ id: o.id, captureId: o.capture_id, amountMinor: o.amount_minor, currency: o.currency, paypalOrderId: o.paypal_order_id });
    const outboxKinds: Record<string, number> = {};
    for (const e of outbox) outboxKinds[e.kind] = (outboxKinds[e.kind] ?? 0) + 1;
    return { ordersByIntent,
      obligations: obligations.map(o => ({ key: o.obligation_key, intentId: o.intent_id, captureId: o.capture_id, resultId: o.result_id, callId: o.claimed_by_call_id })),
      markers: markers.map(m => ({ callId: m.call_id, boundary: m.boundary, outcome: m.outcome, resultId: m.result_id, intentId: m.intent_id,
        captureId: m.capture_id, originalClaimCallId: m.original_claim_call_id })),
      intents: intents.map(i => ({ callId: i.call_id, boundary: i.boundary, resolvedState: i.resolved_state })),
      captureEvidence: evidence.map(e => ({ evidenceId: e.evidence_id, captureId: e.capture_id, amountMinor: e.amount_minor })),
      outboxKinds, outboxEventIds: outbox.map(e => e.event_id) };
  } catch (error) { await c.query("ROLLBACK").catch(() => {}); throw error; } finally { c.release(); }
}

/** Exactly one order for the intent, matching the verified capture on every identity field. */
export function assertOneMatchingOrder(s: StateSnapshot, intentId: string, expected: Omit<Order, "id">): Verdict {
  const found = s.ordersByIntent[intentId] ?? [];
  if (found.length !== 1) return { ok: false, detail: `${intentId}: ${found.length} orders, expected exactly 1` };
  const o = found[0]!;
  const differing = (Object.keys(expected) as Array<keyof typeof expected>).filter(k => o[k] !== expected[k]);
  return differing.length ? { ok: false, detail: `${intentId}: order ${o.id} differs in ${differing.join(", ")}` } : { ok: true, detail: `${intentId}: order ${o.id}` };
}

/** Every obligation names an existing order with the same intent and capture. */
export function assertObligationsBackedByOrders(s: StateSnapshot): Verdict {
  const byId = new Map(Object.entries(s.ordersByIntent).flatMap(([intentId, os]) => os.map(o => [o.id, { ...o, intentId }] as const)));
  const bad = s.obligations.filter(ob => { const o = ob.resultId === null ? undefined : byId.get(ob.resultId); return !o || o.intentId !== ob.intentId || o.captureId !== ob.captureId; });
  return bad.length ? { ok: false, detail: `${bad.length} obligation(s) without a matching order: ${bad.map(b => `${b.captureId}->${b.resultId ?? "null"}`).join(", ")}` }
    : { ok: true, detail: `${s.obligations.length} obligation(s), all backed` };
}

/**
 * What a candidate claims, in the form the controller derives from its stdout. A guarded claim names the guard outcome and
 * call; an unguarded merchant (the V-A original, and NCs that bypass the guard) can only make a state-only claim.
 */
export type Claim =
  | { kind: "guarded"; guardOutcome: "CREATED" | "REUSED" | "IDENTITY_CONFLICT" | "REJECTED"; callId: string; orderId?: string; intentId: string; captureId: string }
  | { kind: "state_only"; orderId: string; intentId: string; captureId: string };

/**
 * A candidate's claim counts only if durable state binds every part of it together (review CP3 R2):
 * - CREATED: this call's marker records CREATED for this intent and capture with this result; this call holds the obligation for it; the order matches.
 * - REUSED: this call's marker records REUSED of this result and names an earlier claim; that earlier call holds the obligation; this call holds none.
 * - IDENTITY_CONFLICT / REJECTED: this call's marker records that outcome with no result; this call holds no obligation; the claim names no order.
 * - state_only: the order exists and matches the intent and capture. It says nothing about any SDK commit.
 */
export function assertClaimCorroborated(claim: Claim, s: StateSnapshot): Verdict {
  const problems: string[] = [];
  const order = claim.orderId === undefined ? undefined : (s.ordersByIntent[claim.intentId] ?? []).find(o => o.id === claim.orderId);
  const orderMatches = () => {
    if (claim.orderId === undefined) { problems.push("the claim names no order"); return; }
    if (!order) problems.push(`no order ${claim.orderId} for ${claim.intentId}`);
    else if (order.captureId !== claim.captureId) problems.push(`order ${claim.orderId} has capture ${order.captureId}, not ${claim.captureId}`);
  };
  if (claim.kind === "state_only") {
    orderMatches();
    return problems.length ? { ok: false, detail: problems.join("; ") } : { ok: true, detail: `state-only: order ${claim.orderId} matches` };
  }
  const markers = s.markers.filter(m => m.callId === claim.callId);
  const marker = markers[0];
  const ownClaims = s.obligations.filter(o => o.callId === claim.callId);
  const allowedBoundaries = claim.guardOutcome === "REJECTED" ? ["OPERATION", "REJECTION_AUDIT"] : ["OPERATION"];
  if (markers.length !== 1 || !marker) problems.push(`no single commit marker for call ${claim.callId}`);
  else {
    if (!allowedBoundaries.includes(marker.boundary)) problems.push(`marker boundary ${marker.boundary} can't record ${claim.guardOutcome}`);
    if (marker.outcome !== claim.guardOutcome) problems.push(`marker records ${String(marker.outcome)}, not ${claim.guardOutcome}`);
    if (marker.intentId !== claim.intentId || marker.captureId !== claim.captureId)
      problems.push(`marker is for ${String(marker.intentId)}/${String(marker.captureId)}, not ${claim.intentId}/${claim.captureId}`);
  }
  switch (claim.guardOutcome) {
    case "CREATED": {
      orderMatches();
      if (marker && marker.resultId !== claim.orderId) problems.push(`marker result ${String(marker.resultId)} is not order ${String(claim.orderId)}`);
      if (!ownClaims.some(o => o.resultId === claim.orderId && o.intentId === claim.intentId && o.captureId === claim.captureId))
        problems.push(`call ${claim.callId} holds no obligation for order ${String(claim.orderId)}`);
      break;
    }
    case "REUSED": {
      orderMatches();
      if (marker && marker.resultId !== claim.orderId) problems.push(`marker result ${String(marker.resultId)} is not order ${String(claim.orderId)}`);
      const earlier = marker?.originalClaimCallId;
      if (!earlier || earlier === claim.callId) problems.push("the reuse names no earlier claim");
      else if (!s.obligations.some(o => o.callId === earlier && o.resultId === claim.orderId && o.intentId === claim.intentId && o.captureId === claim.captureId))
        problems.push(`earlier call ${earlier} holds no obligation for order ${String(claim.orderId)}`);
      if (ownClaims.length) problems.push(`reuse call ${claim.callId} holds its own obligation`);
      break;
    }
    case "IDENTITY_CONFLICT": case "REJECTED": {
      if (claim.orderId !== undefined) problems.push(`${claim.guardOutcome} can't corroborate order ${claim.orderId}`);
      if (marker && marker.resultId !== null) problems.push(`marker records result ${marker.resultId} for ${claim.guardOutcome}`);
      if (ownClaims.length) problems.push(`call ${claim.callId} holds an obligation despite ${claim.guardOutcome}`);
      break;
    }
  }
  return problems.length ? { ok: false, detail: problems.join("; ") } : { ok: true, detail: `${claim.guardOutcome} by call ${claim.callId} corroborated` };
}
