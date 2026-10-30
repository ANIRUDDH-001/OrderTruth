/**
 * The guard (spec §5.3a, §5.3c, §5.3d, §5.3e; plan Task 6): createOrderOnce for profile P1 / tier T1, and recovery.
 *
 * Gate A runs §5.3c steps 1–9 with step 6 (legacy checks) skipped, so every result carries LEGACY_CHECK_ABSENT. Every decided
 * outcome commits its evidence before it is returned; a lost COMMIT acknowledgement is resolved from durable records only,
 * by a confirmation that dispatches on the marker's boundary and recorded outcome. Nothing is reconstructed from memory.
 */
import pg from "pg";
import { canonical, sha256 } from "../../../src/domain/canonical.ts";
import { confirmIssuance, SDK_VERSION, snapshotCapability, verifyMac, type CaptureCapability } from "./capability.ts";
import { CommitEvidenceInconsistent, CommitOutcomeUnknown, GuardRetryableError, recoverPending as recoverCalls, resolveCall, runGuardTx,
  visibilityProof, type Boundary, type Confirm, type EventualState, type GuardPools, type OutcomeRecord } from "./commit.ts";
import { REQUIRED_CREATE_ORDER_RETURNS, validateConfig, type GuardConfig, type RegisteredStatement } from "./config.ts";
import { CONTRACT, evidenceEventId, evidenceId, fingerprintP1, obligationKeyP1, validateAmountMinor, validateIdentifier } from "./identity.ts";

export type GuardOptions = { pool: pg.Pool; auxConnectionString: string; auxMax: number; merchantId: string; buildId: string;
  paypalEnv: "sandbox"; capabilityKey: Buffer; config: GuardConfig; freshnessMs: number; now?: () => number;
  timeouts: { lockMs: number; statementMs: number; connectionMs: number }; resolveDeadlineMs?: number;
  acceptTestAuthority?: boolean; testAuthorityKey?: Buffer;
  /** Honoured only when ORDERTRUTH_GUARD_MODE === "verifier". */
  testHooks?: { afterClaim?: () => Promise<void>; beforeCommit?: () => Promise<void>; afterCommitFailure?: (ctx: { callId: string }) => void } };
export type RejectReason = "BAD_MAC" | "TEST_AUTHORITY" | "LIVE_ENVIRONMENT" | "BINDING_MISMATCH" | "STALE" | "NO_CAPTURE_EVIDENCE" | "EVIDENCE_MISMATCH" | "STATEMENT_POSTCONDITION";
export type CreateOrderOutcome = "CREATED" | "REUSED" | "IDENTITY_CONFLICT" | "REJECTED";
export type CreateOrderResult = { outcome: CreateOrderOutcome; tier: "T1"; callId: string; result?: { table: "orders"; id: string }; reason?: RejectReason;
  flags: Array<"LEGACY_CHECK_ABSENT">; resolved?: true; originalClaimCallId?: string };
export type Resolution = { callId: string; state: EventualState; boundary?: Boundary; result?: CreateOrderResult; evidenceId?: string; reason?: string };
export type Guard = {
  createOrderOnce(i: { capture: CaptureCapability; intentId: string; pathId: string; siteId: string }): Promise<CreateOrderResult>;
  resolve(callId: string): Promise<Resolution>;
  recoverPending(o: { olderThanMs: number }): Promise<Resolution[]>;
  close(): Promise<void> };

type Row = Record<string, unknown>;
type Bindings = Partial<Record<string, string>>;
type OrderIdentity = { intent_id: string; paypal_order_id: string; capture_id: string; amount_minor: string; currency: string };
const FLAGS: Array<"LEGACY_CHECK_ABSENT"> = ["LEGACY_CHECK_ABSENT"];
const EVIDENCE_KIND: Record<CreateOrderOutcome, string> = { CREATED: "claimed", REUSED: "reused", IDENTITY_CONFLICT: "conflict", REJECTED: "rejected" };
const verifierMode = () => process.env.ORDERTRUTH_GUARD_MODE === "verifier";
const production = () => process.env.NODE_ENV === "production";
const finitePositive = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;

/** Executes a registered statement with its declared parameters, using the extended protocol (one statement, typed parameters). */
function runStatement(c: pg.ClientBase, s: RegisteredStatement, b: Bindings): Promise<pg.QueryResult<Row>> {
  const values = s.params.map(p => {
    const v = b[p];
    if (v === undefined) throw new Error(`guard: parameter ${p} is not available to this statement`);
    return v;
  });
  return c.query({ text: s.sql, values, queryMode: "extended" } as pg.QueryConfig);
}
/** The full operation identity (spec §5.3a row checks): exactly these values, compared as text. */
function sameOrder(row: Row | undefined, want: OrderIdentity): row is Row {
  return !!row && typeof row.id === "string" && row.id.length > 0
    && REQUIRED_CREATE_ORDER_RETURNS.every(k => k === "id" || String(row[k]) === want[k]);
}
const orderIdentity = (c: { intentId: string; paypalOrderId: string; captureId: string; amountMinor: string; currency: string }): OrderIdentity =>
  ({ intent_id: c.intentId, paypal_order_id: c.paypalOrderId, capture_id: c.captureId, amount_minor: c.amountMinor, currency: c.currency });

export async function createGuard(o: GuardOptions): Promise<Guard> {
  if (o.paypalEnv !== "sandbox") throw new Error("createGuard: sandbox only (paypalEnv must be \"sandbox\")");
  if (!validateIdentifier(o.merchantId) || !validateIdentifier(o.buildId)) throw new Error("createGuard: invalid merchantId or buildId");
  // Each required timeout by name: iterating the supplied keys would let an omitted one through (review R1), and pg treats a
  // missing connection timeout as "wait forever".
  const timeouts: unknown = o.timeouts;
  if (!timeouts || typeof timeouts !== "object") throw new Error("createGuard: timeouts { lockMs, statementMs, connectionMs } is required");
  for (const k of ["lockMs", "statementMs", "connectionMs"] as const)
    if (!finitePositive((timeouts as Record<string, unknown>)[k])) throw new Error(`createGuard: timeouts.${k} must be a finite positive integer`);
  if (!finitePositive(o.freshnessMs) || !finitePositive(o.auxMax)) throw new Error("createGuard: freshnessMs and auxMax must be finite positive integers");
  const resolveDeadlineMs = o.resolveDeadlineMs ?? 5000;
  if (!finitePositive(resolveDeadlineMs)) throw new Error("createGuard: resolveDeadlineMs must be a finite positive integer");
  // The whole resolution attempt: termination wait plus one connection acquisition and one statement's worth of slack.
  const resolveAttemptMs = resolveDeadlineMs + o.timeouts.connectionMs + o.timeouts.statementMs;
  // pg's default connection timeout is infinite, which could wait forever (spec §5.4b).
  if (!finitePositive((o.pool as unknown as { options?: { connectionTimeoutMillis?: unknown } }).options?.connectionTimeoutMillis))
    throw new Error("createGuard: the operation pool needs a finite, positive connectionTimeoutMillis");
  if (!Buffer.isBuffer(o.capabilityKey) || o.capabilityKey.length < 32) throw new Error("createGuard: capabilityKey must be at least 32 bytes");
  validateConfig(o.config);
  if (o.acceptTestAuthority) {
    if (!verifierMode()) throw new Error("createGuard: acceptTestAuthority requires ORDERTRUTH_GUARD_MODE=verifier");
    if (production()) throw new Error("createGuard: acceptTestAuthority is refused when NODE_ENV=production");
    if (!Buffer.isBuffer(o.testAuthorityKey) || o.testAuthorityKey.length < 32 || o.testAuthorityKey.equals(o.capabilityKey))
      throw new Error("createGuard: testAuthorityKey must be at least 32 bytes and differ from capabilityKey");
  }
  const testKey = o.acceptTestAuthority ? o.testAuthorityKey : undefined;
  const aux = new pg.Pool({ connectionString: o.auxConnectionString, max: o.auxMax, connectionTimeoutMillis: o.timeouts.connectionMs,
    statement_timeout: o.timeouts.statementMs, lock_timeout: o.timeouts.lockMs });
  aux.on("error", () => {});
  const pools: GuardPools = { op: o.pool, aux };
  try {
    const installed = (await aux.query<{ merchant_id: string }>("SELECT merchant_id FROM ordertruth_guard.installation")).rows[0]?.merchant_id;
    if (installed !== o.merchantId) throw new Error("createGuard: the ordertruth_guard installation belongs to another merchant (or is missing)");
    const opRole = (await o.pool.query<{ u: string }>("SELECT current_user AS u")).rows[0]?.u;
    const resolver = (await aux.query<{ u: string; stats: boolean }>("SELECT current_user AS u, pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') AS stats")).rows[0];
    if (!resolver || (resolver.u !== opRole && !resolver.stats))
      throw new Error("createGuard: the resolver role must be the operation role or a member of pg_read_all_stats");
    const visible = await visibilityProof(pools);
    if (!visible.ok) throw new Error(`createGuard: startup visibility probe failed: ${visible.reason}`);
    if (production() && (await aux.query("SELECT 1 FROM ordertruth_guard.obligations WHERE authority = 'TEST' LIMIT 1")).rowCount !== 0)
      throw new Error("createGuard: refusing production: TEST-authority obligations exist in this merchant database");
  } catch (error) { await aux.end().catch(() => {}); throw error; }

  const now = o.now ?? Date.now;
  const hooks: NonNullable<GuardOptions["testHooks"]> = verifierMode() ? (o.testHooks ?? {}) : {};
  const runHooks = { ...(hooks.beforeCommit ? { beforeCommit: hooks.beforeCommit } : {}), ...(hooks.afterCommitFailure ? { afterCommitFailure: hooks.afterCommitFailure } : {}) };

  /** Writes one evidence event and its cloud_evidence delivery row inside `tx`; the event ID is tenant-scoped and per call. */
  async function writeEvidence(tx: pg.ClientBase, kind: string, callId: string, c: CaptureCapability, obligationKey: string | null, pathId: string, payload: Row) {
    const authority = c.authority === "PAYPAL" ? "PAYPAL" : "TEST";
    const eventId = evidenceEventId({ merchantId: o.merchantId, authority, paypalEnv: "sandbox", payeeMerchantId: String(c.payeeMerchantId),
      operationKind: "CREATE_ORDER", obligationKey: obligationKey ?? "", eventKind: kind, contractVersion: CONTRACT.version, callId });
    await tx.query(`INSERT INTO ordertruth_guard.outbox (event_id, merchant_id, kind, obligation_key, call_id, payload, authority, provenance, contract_version, sdk_version, path_id, build_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [eventId, o.merchantId, kind, obligationKey, callId, JSON.stringify({ ...payload, callId }), authority, String(c.provenance), CONTRACT.version, SDK_VERSION, pathId, o.buildId]);
    await tx.query("INSERT INTO ordertruth_guard.outbox_deliveries (event_id, destination, merchant_id) VALUES ($1, 'cloud_evidence', $2)", [eventId, o.merchantId]);
    return eventId;
  }

  /** §5.3c step 1: HMAC, authority and binding, before any transaction. Freshness is checked later, on the claim path only. */
  function precheck(c: CaptureCapability, intentId: string): RejectReason | null {
    if (!c || typeof c !== "object") return "BAD_MAC";
    const macOk = (key: Buffer) => { try { return verifyMac(c, key); } catch { return false; } };
    if (c.authority === "TEST") { if (!testKey) return "TEST_AUTHORITY"; if (!macOk(testKey)) return "BAD_MAC"; }
    else if (c.authority !== "PAYPAL" || !macOk(o.capabilityKey)) return "BAD_MAC";
    if (c.paypalEnv !== "sandbox") return "LIVE_ENVIRONMENT";
    if (c.merchantId !== o.merchantId || c.intentId !== intentId) return "BINDING_MISMATCH";
    const wellFormed = [c.payeeMerchantId, c.captureId, c.paypalOrderId, c.evidenceId].every(validateIdentifier)
      && validateAmountMinor(c.amountMinor) && typeof c.currency === "string" && /^[A-Z]{3}$/.test(c.currency)
      && c.status === "COMPLETED" && typeof c.observedAt === "string" && !Number.isNaN(Date.parse(c.observedAt));
    return wellFormed ? null : "BINDING_MISMATCH";
  }

  const txOptions = { confirm, lockMs: o.timeouts.lockMs, statementMs: o.timeouts.statementMs, resolveDeadlineMs, resolveAttemptMs, hooks: runHooks };

  /** A pre-transaction rejection commits its evidence in its own audit transaction; if that fails, throw instead of returning REJECTED. */
  async function audit(c: CaptureCapability, i: { intentId: string; pathId: string; siteId: string }, reason: RejectReason): Promise<CreateOrderResult> {
    let key: string | null = null;
    try { key = obligationKeyP1({ paypalEnv: "sandbox", payeeMerchantId: c.payeeMerchantId, captureId: c.captureId, unit: "primary" }); } catch { /* unbindable */ }
    const identity = { merchantId: o.merchantId, intentId: i.intentId, pathId: i.pathId, siteId: i.siteId, captureId: String(c.captureId), obligationKey: key };
    try {
      const r = await runGuardTx(pools, "REJECTION_AUDIT", identity, async (tx, { callId }) => {
        const claimed = { authority: String(c.authority), paypalEnv: String(c.paypalEnv), merchantId: String(c.merchantId), intentId: String(c.intentId),
          captureId: String(c.captureId), amountMinor: String(c.amountMinor), currency: String(c.currency), evidenceId: String(c.evidenceId) };
        const ev = await writeEvidence(tx, "rejected", callId, c, key, i.pathId, { outcome: "REJECTED", reason, decided: "BEFORE_TRANSACTION", claimed });
        const value: CreateOrderResult = { outcome: "REJECTED", tier: "T1", callId, reason, flags: FLAGS };
        return { value, outcomeRecord: { callId, boundary: "REJECTION_AUDIT", merchantId: o.merchantId, identity, outcome: "REJECTED", result: null,
          obligationKey: key, originalClaimCallId: null, evidenceEventId: ev, reason, attemptedResultIds: [] } };
      }, txOptions);
      return r.resolved ? { ...r.value, resolved: true } : r.value;
    } catch (error) {
      if (error instanceof CommitOutcomeUnknown || error instanceof CommitEvidenceInconsistent) throw error;
      throw new GuardRetryableError("createOrderOnce: the rejection audit could not be committed, so no REJECTED is returned", error);
    }
  }

  async function createOrderOnce(i: { capture: CaptureCapability; intentId: string; pathId: string; siteId: string }): Promise<CreateOrderResult> {
    if (!validateIdentifier(i.intentId) || !validateIdentifier(i.pathId) || !validateIdentifier(i.siteId)) throw new Error("createOrderOnce: invalid intentId, pathId or siteId");
    if (!o.config.sites.some(s => s.siteId === i.siteId && s.pathId === i.pathId)) throw new Error(`createOrderOnce: site ${i.siteId} on path ${i.pathId} is not declared`);
    const c = i.capture && typeof i.capture === "object" ? snapshotCapability(i.capture) : {} as CaptureCapability;
    const rejected = precheck(c, i.intentId);
    if (rejected) return audit(c, i, rejected);

    const key = obligationKeyP1({ paypalEnv: "sandbox", payeeMerchantId: c.payeeMerchantId, captureId: c.captureId, unit: "primary" });
    const want = orderIdentity(c);
    const identity = { merchantId: o.merchantId, captureId: c.captureId, paypalOrderId: c.paypalOrderId, intentId: c.intentId, amountMinor: c.amountMinor,
      currency: c.currency, evidenceId: c.evidenceId, obligationKey: key, pathId: i.pathId, siteId: i.siteId, authority: c.authority };
    const bindings: Bindings = { "merchant.id": o.merchantId, "intent.id": i.intentId, "capture.id": c.captureId, "capture.paypalOrderId": c.paypalOrderId,
      "capture.amountMinor": c.amountMinor, "capture.currency": c.currency, "path.id": i.pathId, "site.id": i.siteId };

    const r = await runGuardTx(pools, "OPERATION", identity, async (tx, { callId }) => {
      const decide = async (outcome: CreateOrderOutcome, d: { reason?: RejectReason; result?: { table: "orders"; id: string }; originalClaimCallId?: string;
        attemptedResultIds?: string[]; payload?: Row } = {}) => {
        const ev = await writeEvidence(tx, EVIDENCE_KIND[outcome], callId, c, key, i.pathId, { outcome, reason: d.reason ?? null, ...d.payload });
        const value: CreateOrderResult = { outcome, tier: "T1", callId, flags: FLAGS, ...(d.result ? { result: d.result } : {}),
          ...(d.reason ? { reason: d.reason } : {}), ...(d.originalClaimCallId ? { originalClaimCallId: d.originalClaimCallId } : {}) };
        return { value, outcomeRecord: { callId, boundary: "OPERATION", merchantId: o.merchantId, identity, outcome, result: d.result ?? null, obligationKey: key,
          originalClaimCallId: d.originalClaimCallId ?? null, evidenceEventId: ev, reason: d.reason ?? null, attemptedResultIds: d.attemptedResultIds ?? [] } as OutcomeRecord };
      };
      // The fingerprint's line items come from the merchant intent, never from the caller (spec §5.2).
      const intents = (await runStatement(tx, o.config.intentLocator, bindings)).rows;
      if (intents.length !== 1) return decide("REJECTED", { reason: "BINDING_MISMATCH", payload: { detail: `intent locator returned ${intents.length} rows` } });
      const intent = intents[0]!;
      const fingerprint = fingerprintP1({ captureId: c.captureId, paypalOrderId: c.paypalOrderId, intentId: c.intentId, currency: c.currency,
        amountMinor: c.amountMinor, linesHash: sha256(canonical(intent.line_items ?? null)) });

      // §5.3c step 3: the conflict target is exactly the physical primary key, so secondary-index hits surface as 23505.
      await tx.query("SAVEPOINT s1");
      let claimedKey: string | undefined, uniqueViolation: string | undefined;
      try {
        claimedKey = (await tx.query<{ obligation_key: string }>(`INSERT INTO ordertruth_guard.obligations (merchant_id, operation_kind, paypal_env, payee_merchant_id,
            capture_id, intent_id, unit, claimed_by_call_id, origin, fingerprint, authority, provenance, contract_version, sdk_version, path_id, site_id, build_id)
          VALUES ($1, 'CREATE_ORDER', 'sandbox', $2, $3, $4, 'primary', $5, 'NEW', $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (merchant_id, operation_kind, obligation_key) DO NOTHING RETURNING obligation_key`,
          [o.merchantId, c.payeeMerchantId, c.captureId, c.intentId, callId, fingerprint, c.authority, c.provenance, CONTRACT.version, SDK_VERSION,
            i.pathId, i.siteId, o.buildId])).rows[0]?.obligation_key;
      } catch (error) {
        // A concurrent identical claim can pass the PK arbiter pre-check and then hit a non-arbiter unique index first (review CP2 B1),
        // so a 23505 is classified only after the PK row has been looked up.
        if ((error as { code?: unknown }).code !== "23505") throw error;
        await tx.query("ROLLBACK TO SAVEPOINT s1");
        uniqueViolation = String((error as { constraint?: unknown }).constraint);
      }
      if (claimedKey !== undefined && claimedKey !== key) throw new Error("guard: the database's obligation key differs from obligationKeyP1");

      if (claimedKey === undefined) {
        // A new READ COMMITTED statement: the conflicting row is committed (the insert waited for its transaction), so REUSED can't roll back.
        const existing = (await tx.query<{ fingerprint: string; result_table: string | null; result_id: string | null; claimed_by_call_id: string }>(
          `SELECT fingerprint, result_table, result_id, claimed_by_call_id FROM ordertruth_guard.obligations
           WHERE merchant_id = $1 AND operation_kind = 'CREATE_ORDER' AND obligation_key = $2`, [o.merchantId, key])).rows[0];
        if (!existing && uniqueViolation === "obligations_p1_intent") {
          const holder = (await tx.query<{ capture_id: string; fingerprint: string; claimed_by_call_id: string }>(`SELECT capture_id, fingerprint, claimed_by_call_id
            FROM ordertruth_guard.obligations WHERE merchant_id = $1 AND operation_kind = 'CREATE_ORDER' AND intent_id = $2 AND unit = 'primary'`, [o.merchantId, c.intentId])).rows[0];
          return decide("IDENTITY_CONFLICT", { payload: { rule: "SECONDARY_INTENT", attempted: { captureId: c.captureId, fingerprint },
            existing: holder ? { captureId: holder.capture_id, fingerprint: holder.fingerprint, claimedByCallId: holder.claimed_by_call_id } : null } });
        }
        if (!existing) throw new Error(`guard: the claim conflicted (${uniqueViolation ?? "primary key"}) but no existing obligation explains it`);
        if (existing.fingerprint === fingerprint && existing.result_table === "orders" && existing.result_id)
          return decide("REUSED", { result: { table: "orders", id: existing.result_id }, originalClaimCallId: existing.claimed_by_call_id,
            payload: { fingerprint, result: { table: "orders", id: existing.result_id }, originalClaimCallId: existing.claimed_by_call_id } });
        return decide("IDENTITY_CONFLICT", { payload: { rule: "PRIMARY_FINGERPRINT", attempted: { captureId: c.captureId, amountMinor: c.amountMinor, currency: c.currency, fingerprint },
          existing: { fingerprint: existing.fingerprint, claimedByCallId: existing.claimed_by_call_id } } });
      }

      // Claimed. From here a decision that must not keep the claim rolls back to S1 and commits its evidence.
      if (hooks.afterClaim) await hooks.afterClaim();
      const reject = async (reason: RejectReason, payload: Row = {}, attemptedResultIds: string[] = []) => {
        await tx.query("ROLLBACK TO SAVEPOINT s1");
        return decide("REJECTED", { reason, attemptedResultIds, payload: { ...payload, attemptedResultIds } });
      };
      const observedAt = Date.parse(c.observedAt), at = now();
      if (at > observedAt + o.freshnessMs) return reject("STALE", { observedAt: c.observedAt, freshnessMs: o.freshnessMs, now: new Date(at).toISOString() });

      // §5.3c step 5: the evidence row committed at issuance must equal the capability, field by field.
      const ev = (await tx.query<Row>(`SELECT authority, provenance, merchant_id, paypal_env, payee_merchant_id, capture_id, paypal_order_id, intent_id, status, currency,
          amount_minor::text AS amount_minor, verification_method, response_hash, observation_hash, observed_at = $2::timestamptz AS observed_at_equal
        FROM ordertruth_guard.capture_evidence WHERE evidence_id = $1`, [c.evidenceId, c.observedAt])).rows[0];
      if (!ev) return reject("NO_CAPTURE_EVIDENCE", { evidenceId: c.evidenceId });
      const expected: Row = { authority: c.authority, provenance: c.provenance, merchant_id: o.merchantId, paypal_env: c.paypalEnv, payee_merchant_id: c.payeeMerchantId,
        capture_id: c.captureId, paypal_order_id: c.paypalOrderId, intent_id: c.intentId, status: c.status, currency: c.currency, amount_minor: c.amountMinor,
        verification_method: c.verificationMethod, response_hash: c.responseHash, observed_at_equal: true };
      const differing = Object.keys(expected).filter(k => ev[k] !== expected[k]);
      const recomputed = evidenceId({ authority: c.authority, merchantId: o.merchantId, captureId: c.captureId, observationHash: String(ev.observation_hash) });
      if (recomputed !== c.evidenceId) differing.push("evidence_id");
      if (differing.length) return reject("EVIDENCE_MISMATCH", { evidenceId: c.evidenceId, differing });
      if (String(intent.currency) !== c.currency || String(intent.amount_minor) !== c.amountMinor)
        return reject("BINDING_MISMATCH", { detail: "capture amount or currency differs from the merchant intent" });

      // §5.3c step 7 (T1): the registered statement, exactly one row with the full identity, then a persisted re-read in tx.
      const created = (await runStatement(tx, o.config.createOrder, bindings)).rows;
      const returnedIds = created.map(row => String(row.id));
      if (created.length !== 1 || !sameOrder(created[0], want)) return reject("STATEMENT_POSTCONDITION", { detail: "createOrder RETURNING" }, returnedIds);
      const orderId = String(created[0]!.id);
      const reread = (await runStatement(tx, o.config.orderLocator, { ...bindings, "order.id": orderId })).rows, persisted = reread[0];
      if (reread.length !== 1 || !sameOrder(persisted, want) || persisted.id !== orderId)
        return reject("STATEMENT_POSTCONDITION", { detail: "persisted re-read through orderLocator" }, [orderId]);

      await tx.query(`UPDATE ordertruth_guard.obligations SET result_table = 'orders', result_id = $3
        WHERE merchant_id = $1 AND operation_kind = 'CREATE_ORDER' AND obligation_key = $2 AND claimed_by_call_id = $4`, [o.merchantId, key, orderId, callId]);
      return decide("CREATED", { result: { table: "orders", id: orderId }, payload: { fingerprint, evidenceId: c.evidenceId, result: { table: "orders", id: orderId } } });
    }, txOptions);
    return r.resolved ? { ...r.value, resolved: true } : r.value;
  }

  /**
   * Mandatory durable confirmation (plan Task 5 table), dispatched on boundary and recorded outcome. The record must be exactly
   * what this call's marker holds; then each outcome's own evidence and effect checks apply. Anything unsupported is false.
   */
  async function confirm(r: OutcomeRecord, c: pg.PoolClient): Promise<boolean> {
    if (typeof r.callId !== "string" || r.merchantId !== o.merchantId || typeof r.boundary !== "string") return false;
    const exact = await c.query("SELECT 1 FROM ordertruth_guard.commit_markers WHERE call_id = $1 AND boundary = $2 AND merchant_id = $3 AND outcome_record = $4::jsonb",
      [r.callId, r.boundary, o.merchantId, JSON.stringify(r)]);
    if (exact.rowCount !== 1) return false;
    if (r.boundary === "ISSUANCE") return confirmIssuance(r, c);
    if (r.boundary !== "OPERATION" && r.boundary !== "REJECTION_AUDIT") return false;
    const outcome = r.outcome as CreateOrderOutcome;
    if (!Object.hasOwn(EVIDENCE_KIND, String(outcome)) || (r.boundary === "REJECTION_AUDIT" && outcome !== "REJECTED")) return false;
    if (typeof r.evidenceEventId !== "string") return false;
    const ev = (await c.query<{ payload: Row }>(`SELECT o.payload FROM ordertruth_guard.outbox o JOIN ordertruth_guard.outbox_deliveries d
        ON d.event_id = o.event_id AND d.destination = 'cloud_evidence' AND d.merchant_id = o.merchant_id
      WHERE o.event_id = $1 AND o.call_id = $2 AND o.kind = $3 AND o.merchant_id = $4`, [r.evidenceEventId, r.callId, EVIDENCE_KIND[outcome], o.merchantId])).rows[0];
    if (!ev || ev.payload.outcome !== outcome || (ev.payload.reason ?? null) !== (r.reason ?? null)) return false;
    const ownClaims = (await c.query("SELECT 1 FROM ordertruth_guard.obligations WHERE merchant_id = $1 AND claimed_by_call_id = $2", [o.merchantId, r.callId])).rowCount;
    const id = r.identity as Row | undefined;
    const locate = async (orderId: string) => {
      const b: Bindings = { "merchant.id": o.merchantId, "order.id": orderId };
      for (const [name, field] of [["intent.id", "intentId"], ["capture.id", "captureId"], ["capture.paypalOrderId", "paypalOrderId"],
        ["capture.amountMinor", "amountMinor"], ["capture.currency", "currency"], ["path.id", "pathId"], ["site.id", "siteId"]] as const)
        if (typeof id?.[field] === "string") b[name] = id[field];
      return (await runStatement(c, o.config.orderLocator, b)).rows;
    };
    const resultId = (r.result as { table?: unknown; id?: unknown } | null)?.table === "orders" ? (r.result as { id?: unknown }).id : undefined;
    const p = ev.payload as { result?: { id?: unknown } | null; originalClaimCallId?: unknown; evidenceId?: unknown; attemptedResultIds?: unknown };
    switch (outcome) {
      case "CREATED": case "REUSED": {
        if (typeof resultId !== "string" || !id || p.result?.id !== resultId) return false;
        if (outcome === "CREATED" && p.evidenceId !== id.evidenceId) return false;
        if (outcome === "REUSED" && p.originalClaimCallId !== r.originalClaimCallId) return false;
        const claimant = outcome === "CREATED" ? r.callId : r.originalClaimCallId;
        if (typeof claimant !== "string" || (outcome === "REUSED" && (claimant === r.callId || ownClaims !== 0))) return false;
        const obligation = (await c.query(`SELECT 1 FROM ordertruth_guard.obligations WHERE merchant_id = $1 AND operation_kind = 'CREATE_ORDER' AND obligation_key = $2
          AND claimed_by_call_id = $3 AND result_table = 'orders' AND result_id = $4 AND fingerprint = $5`, [o.merchantId, r.obligationKey, claimant, resultId, ev.payload.fingerprint])).rowCount;
        if (obligation !== 1) return false;
        const rows = await locate(resultId);
        return rows.length === 1 && rows[0]!.id === resultId
          && sameOrder(rows[0], orderIdentity(id as { intentId: string; paypalOrderId: string; captureId: string; amountMinor: string; currency: string }));
      }
      case "IDENTITY_CONFLICT": {
        const q = ev.payload as { attempted?: { fingerprint?: unknown }; existing?: { fingerprint?: unknown } | null };
        return ownClaims === 0 && typeof q.attempted?.fingerprint === "string" && typeof q.existing?.fingerprint === "string";
      }
      case "REJECTED": {
        if (ownClaims !== 0 || !Array.isArray(r.attemptedResultIds)) return false;
        if (canonical(r.attemptedResultIds) !== canonical(p.attemptedResultIds ?? [])) return false;
        for (const attempted of r.attemptedResultIds) if (typeof attempted !== "string" || (await locate(attempted)).length !== 0) return false;
        return true;
      }
    }
  }

  const toResolution = (callId: string, x: { state: EventualState; outcomeRecord?: OutcomeRecord; reason?: string }): Resolution => {
    const base: Resolution = { callId, state: x.state, ...(x.reason ? { reason: x.reason } : {}) };
    const rec = x.outcomeRecord;
    if (x.state !== "COMMITTED" || !rec) return base;
    const boundary = rec.boundary as Boundary;
    if (boundary === "ISSUANCE") return { ...base, boundary, evidenceId: String(rec.evidenceId) };
    const result = rec.result as { table: "orders"; id: string } | null;
    return { ...base, boundary, result: { outcome: rec.outcome as CreateOrderOutcome, tier: "T1", callId, flags: FLAGS, resolved: true,
      ...(result ? { result: { table: result.table, id: result.id } } : {}), ...(typeof rec.reason === "string" ? { reason: rec.reason as RejectReason } : {}),
      ...(typeof rec.originalClaimCallId === "string" ? { originalClaimCallId: rec.originalClaimCallId } : {}) } };
  };

  return {
    createOrderOnce,
    async resolve(callId) { return toResolution(callId, await resolveCall(pools, callId, { deadlineMs: resolveDeadlineMs, attemptMs: resolveAttemptMs, confirm })); },
    async recoverPending(r) {
      if (!Number.isInteger(r.olderThanMs) || r.olderThanMs < 0) throw new Error("recoverPending: olderThanMs must be a non-negative integer");
      const pending = await recoverCalls(pools, { olderThanMs: r.olderThanMs, deadlineMs: resolveDeadlineMs, attemptMs: resolveAttemptMs, confirm });
      return pending.map(p => ({ ...toResolution(p.callId, p), boundary: p.boundary }));
    },
    async close() { await aux.end(); },
  };
}
