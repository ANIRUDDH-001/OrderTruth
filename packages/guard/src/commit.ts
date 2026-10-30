/**
 * Commit journal, markers and unknown-commit resolution (spec §5.3e; plan Task 5).
 *
 * Every guard transaction journals a commit intent (autocommitted, on the auxiliary pool) before its effect, and writes
 * a commit marker as its last statement, so the marker commits if and only if the transaction does. After a lost COMMIT
 * acknowledgement the outcome is decided only by durable evidence:
 *   COMMITTED                  the marker is present and a boundary-specific confirmation agrees with durable state;
 *   NOT_COMMITTED_ESTABLISHED  the original backend is proved ended (with visibility proved by a probe), and a FRESH
 *                              marker read taken after that still finds nothing;
 *   STILL_UNKNOWN              anything else. Never a rollback by default.
 * pg_xact_status is diagnostic only. Timestamps are compared in SQL, never through JavaScript Dates.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";

export type GuardPools = { op: pg.Pool; aux: pg.Pool };
export type Boundary = "ISSUANCE" | "OPERATION" | "REJECTION_AUDIT";
export type EventualState = "COMMITTED" | "NOT_COMMITTED_ESTABLISHED" | "STILL_UNKNOWN";
export type OutcomeRecord = { [k: string]: unknown };
/** Boundary-specific durable confirmation. Callers must supply one; a missing confirmation never counts as success. */
export type Confirm = (r: OutcomeRecord, aux: pg.PoolClient) => Promise<boolean>;
export type RunHooks = { beforeCommit?: () => Promise<void>; afterCommitFailure?: (ctx: { callId: string }) => void; xactStatusOverride?: () => Promise<string | null> };
export type ResolveHooks = { afterFirstMarkerRead?: () => Promise<void>; xactStatusOverride?: () => Promise<string | null> };

export class CommitOutcomeUnknown extends Error {
  readonly callId: string; readonly boundary: Boundary; readonly reason: string;
  constructor(callId: string, boundary: Boundary, reason: string) {
    super(`commit outcome unknown for ${boundary} call ${callId}: ${reason}`); this.name = "CommitOutcomeUnknown";
    this.callId = callId; this.boundary = boundary; this.reason = reason;
  }
}
export class NotCommittedEstablished extends Error {
  readonly callId: string; readonly boundary: Boundary;
  constructor(callId: string, boundary: Boundary) {
    super(`${boundary} call ${callId} did not commit (established: no marker after the original backend ended)`); this.name = "NotCommittedEstablished";
    this.callId = callId; this.boundary = boundary;
  }
}
export class CommitEvidenceInconsistent extends Error {
  readonly callId: string; readonly detail: string;
  constructor(callId: string, detail: string) { super(`commit evidence inconsistent for call ${callId}: ${detail}`); this.name = "CommitEvidenceInconsistent"; this.callId = callId; this.detail = detail; }
}
/** Nothing from the operation persisted; the caller may retry. */
export class GuardRetryableError extends Error {
  readonly retryable = true;
  constructor(message: string, cause?: unknown) { super(message, { cause }); this.name = "GuardRetryableError"; }
}

const BOUNDARIES = new Set<Boundary>(["ISSUANCE", "OPERATION", "REJECTION_AUDIT"]);
const INCONSISTENT = "COMMIT_EVIDENCE_INCONSISTENT";
const TRANSIENT = new Set(["55P03", "57014", "40001", "40P01"]);
const verifierMode = () => process.env.ORDERTRUTH_GUARD_MODE === "verifier";
const positiveInt = (v: number | undefined, fallback: number, name: string) => {
  const n = v ?? fallback;
  if (!Number.isInteger(n) || n <= 0) throw new Error(`runGuardTx: ${name} must be a positive integer`);
  return n;
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function runGuardTx<T>(pools: GuardPools, boundary: Boundary, identity: OutcomeRecord,
  fn: (tx: pg.PoolClient, ctx: { callId: string }) => Promise<{ value: T; outcomeRecord: OutcomeRecord }>,
  o: { confirm?: Confirm; lockMs?: number; statementMs?: number; resolveDeadlineMs?: number; hooks?: RunHooks } = {}):
  Promise<{ value: T; callId: string; resolved?: true }> {
  if (!BOUNDARIES.has(boundary)) throw new Error(`runGuardTx: unknown boundary ${String(boundary)}`);
  const merchantId = identity.merchantId;
  if (typeof merchantId !== "string" || merchantId.length === 0) throw new Error("runGuardTx: identity.merchantId is required");
  const lockMs = positiveInt(o.lockMs, 5000, "lockMs"), statementMs = positiveInt(o.statementMs, 10000, "statementMs");
  const deadlineMs = positiveInt(o.resolveDeadlineMs, 5000, "resolveDeadlineMs");
  const hooks: RunHooks = verifierMode() ? (o.hooks ?? {}) : {};
  const callId = randomUUID();
  let client: pg.PoolClient;
  try { client = await pools.op.connect(); } catch (error) { throw new GuardRetryableError("runGuardTx: no operation connection within the pool timeout", error); }
  let broken = false, released = false, commitSent = false, xid: string | undefined, result: { value: T } | undefined;
  const onError = () => { broken = true; };
  client.on("error", onError);
  const release = (destroy: boolean) => {
    if (released) return;
    released = true; client.off("error", onError); client.release(destroy ? true : undefined);
  };
  const recordResolved = (state: Exclude<EventualState, "STILL_UNKNOWN">) => pools.aux.query(
    "UPDATE ordertruth_guard.commit_intents SET resolved_state = $2, resolved_at = now() WHERE call_id = $1 AND resolved_state IS NULL", [callId, state]).catch(() => {});
  try {
    // Simple-protocol statements (no parameters): BEGIN, the boundary tag the verifier's proxy keys on, and COMMIT.
    await client.query("BEGIN");
    await client.query(`SET LOCAL application_name = 'ot:${boundary}'`);
    await client.query(`SET LOCAL lock_timeout = ${lockMs}`);
    await client.query(`SET LOCAL statement_timeout = ${statementMs}`);
    await client.query("SET LOCAL standard_conforming_strings = on");
    const backend = (await client.query<{ pid: number; backend_start: string | null; postmaster_start: string; in_recovery: boolean }>(
      `SELECT pg_backend_pid() AS pid, (SELECT backend_start::text FROM pg_stat_activity WHERE pid = pg_backend_pid()) AS backend_start,
              pg_postmaster_start_time()::text AS postmaster_start, pg_is_in_recovery() AS in_recovery`)).rows[0];
    if (!backend?.backend_start) throw new GuardRetryableError("runGuardTx: the backend is not visible to itself in pg_stat_activity");
    if (backend.in_recovery) throw new GuardRetryableError("runGuardTx: connected to a standby; the guard requires the primary");
    try {
      await pools.aux.query(`INSERT INTO ordertruth_guard.commit_intents (call_id, merchant_id, boundary, identity, backend_pid, backend_start, postmaster_start)
        VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)`,
        [callId, merchantId, boundary, JSON.stringify(identity), backend.pid, backend.backend_start, backend.postmaster_start]);
    } catch (error) { throw new GuardRetryableError("runGuardTx: the commit intent could not be journaled", error); }
    const { value, outcomeRecord } = await fn(client, { callId });
    result = { value };
    // The binding fields are set here, not by the caller, so a record can only ever describe the call that wrote it.
    const bound: OutcomeRecord = { ...outcomeRecord, callId, boundary, merchantId, identity };
    await client.query("INSERT INTO ordertruth_guard.commit_markers (call_id, merchant_id, boundary, outcome_record) VALUES ($1, $2, $3, $4)",
      [callId, merchantId, boundary, JSON.stringify(bound)]);
    xid = (await client.query<{ xid: string }>("SELECT pg_current_xact_id()::text AS xid")).rows[0]?.xid;
    if (hooks.beforeCommit) await hooks.beforeCommit();
    commitSent = true;
    await client.query("COMMIT");
    release(false);
    await recordResolved("COMMITTED");
    return { value, callId };
  } catch (error) {
    if (!commitSent) {
      let rolledBack = false;
      if (!broken) { try { await client.query("ROLLBACK"); rolledBack = true; } catch { /* the connection is unusable */ } }
      release(!rolledBack);
      if (rolledBack) await recordResolved("NOT_COMMITTED_ESTABLISHED");   // a confirmed ROLLBACK is definitive
      // Lock, statement, serialization and deadlock timeouts leave nothing behind (spec §5.3d failure semantics): retryable.
      const code = (error as { code?: unknown } | null)?.code;
      if (rolledBack && typeof code === "string" && TRANSIENT.has(code)) throw new GuardRetryableError(`runGuardTx: transient failure ${code}`, error);
      throw error;
    }
    // COMMIT was sent and its outcome is unknown. Destroy the client so its backend can end, then resolve from durable evidence.
    release(true);
    hooks.afterCommitFailure?.({ callId });
    const r = await resolveCall(pools, callId, { deadlineMs, xid, ...(o.confirm ? { confirm: o.confirm } : {}),
      hooks: hooks.xactStatusOverride ? { xactStatusOverride: hooks.xactStatusOverride } : {} });
    if (r.state === "COMMITTED" && result) return { value: result.value, callId, resolved: true };
    if (r.state === "NOT_COMMITTED_ESTABLISHED") throw new NotCommittedEstablished(callId, boundary);
    if (r.reason?.startsWith(INCONSISTENT)) throw new CommitEvidenceInconsistent(callId, r.reason);
    throw new CommitOutcomeUnknown(callId, boundary, r.reason ?? "unresolved");
  }
}

/** Proves, right now, that the resolver can see the operation role's backends: a probe connection's exact identity must be visible through aux. */
export async function visibilityProof(pools: GuardPools): Promise<{ ok: boolean; reason: string }> {
  const probe = await pools.op.connect();
  try {
    const self = (await probe.query<{ pid: number; backend_start: string | null }>(
      "SELECT pg_backend_pid() AS pid, (SELECT backend_start::text FROM pg_stat_activity WHERE pid = pg_backend_pid()) AS backend_start")).rows[0];
    if (!self?.backend_start) return { ok: false, reason: "probe backend not visible to itself" };
    const seen = (await pools.aux.query<{ same: boolean | null }>("SELECT backend_start = $2::timestamptz AS same FROM pg_stat_activity WHERE pid = $1",
      [self.pid, self.backend_start])).rows[0];
    return seen?.same === true ? { ok: true, reason: "" } : { ok: false, reason: "resolver role cannot see the operation role's backend identity" };
  } finally { probe.release(); }
}

export async function resolveCall(pools: GuardPools, callId: string,
  o: { deadlineMs: number; confirm?: Confirm; xid?: string | undefined; hooks?: ResolveHooks }):
  Promise<{ state: EventualState; outcomeRecord?: OutcomeRecord; reason?: string }> {
  const hooks: ResolveHooks = verifierMode() ? (o.hooks ?? {}) : {};
  const unknown = (reason: string) => ({ state: "STILL_UNKNOWN" as const, reason });
  const inconsistent = (detail: string) => unknown(`${INCONSISTENT}: ${detail}`);
  try {
    const intent = (await pools.aux.query<{ merchant_id: string; boundary: string; backend_pid: number; backend_start: string; postmaster_start: string }>(
      `SELECT merchant_id, boundary, backend_pid, backend_start::text AS backend_start, postmaster_start::text AS postmaster_start
       FROM ordertruth_guard.commit_intents WHERE call_id = $1`, [callId])).rows[0];
    if (!intent) return unknown("no commit intent is journaled for this call");
    const sameServer = async () => (await pools.aux.query<{ ok: boolean }>(
      "SELECT NOT pg_is_in_recovery() AND pg_postmaster_start_time() = $1::timestamptz AS ok", [intent.postmaster_start])).rows[0]?.ok === true;
    // `bound`: the record names this call, its boundary and merchant, and carries exactly the identity journaled before the effect.
    const readMarker = async () => (await pools.aux.query<{ merchant_id: string; boundary: string; outcome_record: OutcomeRecord; bound: boolean | null }>(
      `SELECT m.merchant_id, m.boundary, m.outcome_record,
              (m.outcome_record->>'callId' = m.call_id AND m.outcome_record->>'boundary' = m.boundary AND m.outcome_record->>'merchantId' = m.merchant_id
               AND m.outcome_record->'identity' = i.identity) AS bound
       FROM ordertruth_guard.commit_markers m JOIN ordertruth_guard.commit_intents i USING (call_id) WHERE m.call_id = $1`, [callId])).rows[0];
    const diagnostic = async () => {
      if (hooks.xactStatusOverride) return hooks.xactStatusOverride();
      if (!o.xid) return null;
      try { return (await pools.aux.query<{ s: string | null }>("SELECT pg_xact_status($1::xid8) AS s", [o.xid])).rows[0]?.s ?? null; } catch { return null; }
    };
    const record = (state: Exclude<EventualState, "STILL_UNKNOWN">) => pools.aux.query(
      "UPDATE ordertruth_guard.commit_intents SET resolved_state = $2, resolved_at = now() WHERE call_id = $1 AND resolved_state IS NULL", [callId, state]);

    if (!(await sameServer())) return unknown("server identity changed (different postmaster start) or the server is a standby");
    let marker = await readMarker();
    if (!marker) {
      if (hooks.afterFirstMarkerRead) await hooks.afterFirstMarkerRead();
      const visible = await visibilityProof(pools);
      if (!visible.ok) return unknown(`monitoring visibility not established: ${visible.reason}`);
      const deadline = Date.now() + o.deadlineMs;
      for (;;) {
        const alive = (await pools.aux.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz",
          [intent.backend_pid, intent.backend_start])).rowCount !== 0;
        if (!alive) break;
        if (Date.now() >= deadline) return unknown("the original backend was still present at the deadline");
        await sleep(100);
      }
      if (!(await sameServer())) return unknown("server identity changed during resolution");
      marker = await readMarker();                    // a fresh READ COMMITTED statement, taken only after termination
      if (!marker) {
        if ((await diagnostic()) === "committed") return inconsistent("no marker, but the diagnostic reports the transaction committed");
        await record("NOT_COMMITTED_ESTABLISHED");
        return { state: "NOT_COMMITTED_ESTABLISHED" };
      }
    }
    if (marker.merchant_id !== intent.merchant_id || marker.boundary !== intent.boundary) return inconsistent("the marker does not match its intent");
    if (marker.bound !== true) return inconsistent("the outcome record is not bound to this call, boundary, merchant and journaled identity");
    if (!o.confirm) return unknown("no mandatory confirmation was supplied for this boundary");
    const aux = await pools.aux.connect();
    let confirmed = false;
    try { confirmed = await o.confirm(marker.outcome_record, aux); } finally { aux.release(); }
    if (!confirmed) return inconsistent("durable state does not confirm the recorded outcome");
    if ((await diagnostic()) === "aborted") return inconsistent("a marker is present, but the diagnostic reports the transaction aborted");
    await record("COMMITTED");
    return { state: "COMMITTED", outcomeRecord: marker.outcome_record };
  } catch (error) {
    return unknown(`database unreachable or failed during resolution: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Resolves every unresolved journaled intent older than `olderThanMs`, from durable records only (works after a full restart). */
export async function recoverPending(pools: GuardPools, o: { olderThanMs: number; deadlineMs: number; confirm?: Confirm }):
  Promise<Array<{ callId: string; boundary: Boundary; state: EventualState; outcomeRecord?: OutcomeRecord }>> {
  const pending = (await pools.aux.query<{ call_id: string; boundary: Boundary }>(
    `SELECT call_id, boundary FROM ordertruth_guard.commit_intents
     WHERE resolved_state IS NULL AND created_at <= now() - ($1::int * interval '1 millisecond') ORDER BY created_at`, [o.olderThanMs])).rows;
  const out: Array<{ callId: string; boundary: Boundary; state: EventualState; outcomeRecord?: OutcomeRecord }> = [];
  for (const p of pending) {
    const r = await resolveCall(pools, p.call_id, { deadlineMs: o.deadlineMs, ...(o.confirm ? { confirm: o.confirm } : {}) });
    out.push({ callId: p.call_id, boundary: p.boundary, state: r.state, ...(r.outcomeRecord ? { outcomeRecord: r.outcomeRecord } : {}) });
  }
  return out;
}
