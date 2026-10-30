import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { observationEventId, signCapability, type CaptureCapability } from "../../packages/guard/src/capability.ts";
import { evidenceId as evidenceIdOf } from "../../packages/guard/src/identity.ts";
import { GuardRetryableError } from "../../packages/guard/src/commit.ts";
import { createGuard, type Guard, type GuardOptions } from "../../packages/guard/src/guard.ts";
import { createTestCaptureAuthority } from "../../packages/guard/src/testing/index.ts";
import { fixture, runChild, setupGuardEnv, V_A_CONFIG, type GuardEnv } from "./setup.ts";

const testKey = Buffer.alloc(32, 7), capabilityKey = Buffer.alloc(32, 9);
const OBSERVED_AT = Date.parse("2026-10-30T00:00:00.000Z"), FRESHNESS = 60_000;
const CHECKOUT = { pathId: "checkout_return", siteId: "checkout_return:order-write" };
const WEBHOOK = { pathId: "webhook", siteId: "webhook:order-write" };
const previousMode = process.env.ORDERTRUTH_GUARD_MODE, previousNodeEnv = process.env.NODE_ENV;
let env: GuardEnv;
const guards: Guard[] = [];

beforeAll(() => { process.env.ORDERTRUTH_GUARD_MODE = "verifier"; });
beforeEach(async () => { env = await setupGuardEnv("SYN-M-A", { withShop: true }); });
afterEach(async () => {
  process.env.ORDERTRUTH_GUARD_MODE = "verifier"; process.env.NODE_ENV = previousNodeEnv;
  while (guards.length) await guards.pop()!.close();
  await env?.close();
});
afterAll(() => { if (previousMode === undefined) delete process.env.ORDERTRUTH_GUARD_MODE; else process.env.ORDERTRUTH_GUARD_MODE = previousMode; });

const options = (over: Partial<GuardOptions> = {}): GuardOptions => ({
  pool: env.pools.op, auxConnectionString: env.auxConnectionString(), auxMax: 2, merchantId: "SYN-M-A", buildId: "guard-test",
  paypalEnv: "sandbox", capabilityKey, config: V_A_CONFIG, freshnessMs: FRESHNESS, now: () => OBSERVED_AT,
  timeouts: { lockMs: 2000, statementMs: 5000, connectionMs: 5000 }, acceptTestAuthority: true, testAuthorityKey: testKey, ...over });
const guardWith = async (over: Partial<GuardOptions> = {}) => { const g = await createGuard(options(over)); guards.push(g); return g; };
const issue = (observationId: string) => createTestCaptureAuthority({ pools: env.pools, merchantId: "SYN-M-A", fixture, key: testKey }).issue(observationId);
const resign = (c: CaptureCapability, over: Partial<CaptureCapability>) => { const { mac: _mac, ...rest } = c; return signCapability({ ...rest, ...over }, testKey); };
const n = async (sql: string, params: unknown[] = []) => Number((await env.db.client.query(sql, params)).rows[0].n);
const orders = (captureId?: string) => captureId
  ? n("SELECT count(*) AS n FROM shop.orders WHERE capture_id = $1", [captureId]) : n("SELECT count(*) AS n FROM shop.orders");
const obligations = (captureId: string) => n("SELECT count(*) AS n FROM ordertruth_guard.obligations WHERE capture_id = $1", [captureId]);
const evidence = async (callId: string, kind: string) => (await env.db.client.query<{ payload: Record<string, unknown> }>(
  "SELECT payload FROM ordertruth_guard.outbox WHERE call_id = $1 AND kind = $2", [callId, kind])).rows;

describe("createOrderOnce, profile P1 / tier T1 (spec §5.3a, §5.3c, §5.3d; plan Task 6)", () => {
  it("created then reused", async () => {
    const guard = await guardWith(), cap = await issue("SYN-OBS-1");
    const first = await guard.createOrderOnce({ capture: cap, intentId: "SYN-INT-1", ...CHECKOUT });
    const second = await guard.createOrderOnce({ capture: cap, intentId: "SYN-INT-1", ...WEBHOOK });
    expect([first.outcome, second.outcome]).toEqual(["CREATED", "REUSED"]);
    expect(second.result?.id).toBe(first.result?.id);
    expect(second.originalClaimCallId).toBe(first.callId);
    expect([first.tier, first.flags]).toEqual(["T1", ["LEGACY_CHECK_ABSENT"]]);
    expect(await orders()).toBe(1);
    expect(await evidence(first.callId, "claimed")).toHaveLength(1);
    expect(await evidence(second.callId, "reused")).toHaveLength(1);
  });

  it("distinct intents both create", async () => {
    const guard = await guardWith();
    const a = await guard.createOrderOnce({ capture: await issue("SYN-OBS-2"), intentId: "SYN-INT-2", ...CHECKOUT });
    const b = await guard.createOrderOnce({ capture: await issue("SYN-OBS-3"), intentId: "SYN-INT-3", ...WEBHOOK });
    expect([a.outcome, b.outcome]).toEqual(["CREATED", "CREATED"]);
    expect(a.result?.id).not.toBe(b.result?.id);
    expect(await orders()).toBe(2);
  });

  it("validly issued amended observation conflicts on committed obligation", async () => {
    const guard = await guardWith();
    const first = await guard.createOrderOnce({ capture: await issue("SYN-OBS-1"), intentId: "SYN-INT-1", ...CHECKOUT });
    const amended = await issue("SYN-OBS-1B");
    expect((await env.db.client.query("SELECT amount_minor::text AS a FROM ordertruth_guard.capture_evidence WHERE evidence_id = $1", [amended.evidenceId])).rows[0].a).toBe("1500");
    const r = await guard.createOrderOnce({ capture: amended, intentId: "SYN-INT-1", ...WEBHOOK });
    expect(r.outcome).toBe("IDENTITY_CONFLICT");
    expect(await orders()).toBe(1);
    expect(await obligations("SYN-CAP-1")).toBe(1);
    const [conflict] = await evidence(r.callId, "conflict");
    const payload = conflict!.payload as { attempted: { fingerprint: string }; existing: { fingerprint: string; claimedByCallId: string } };
    expect(typeof payload.attempted.fingerprint).toBe("string");
    expect(typeof payload.existing.fingerprint).toBe("string");
    expect(payload.attempted.fingerprint).not.toBe(payload.existing.fingerprint);
    expect(payload.existing.claimedByCallId).toBe(first.callId);
  });

  it("first-use capability that disagrees with its evidence row is EVIDENCE_MISMATCH", async () => {
    const guard = await guardWith(), cap = await issue("SYN-OBS-1");
    const r = await guard.createOrderOnce({ capture: resign(cap, { amountMinor: "1500" }), intentId: "SYN-INT-1", ...CHECKOUT });
    expect([r.outcome, r.reason]).toEqual(["REJECTED", "EVIDENCE_MISMATCH"]);
    expect(await obligations("SYN-CAP-1")).toBe(0);
    expect(await orders()).toBe(0);
    expect(await evidence(r.callId, "rejected")).toHaveLength(1);
  });

  it("second capture for same intent conflicts via partial index", async () => {
    const guard = await guardWith();
    await guard.createOrderOnce({ capture: await issue("SYN-OBS-1"), intentId: "SYN-INT-1", ...CHECKOUT });
    const r = await guard.createOrderOnce({ capture: await issue("SYN-OBS-4"), intentId: "SYN-INT-1", ...WEBHOOK });
    expect(r.outcome).toBe("IDENTITY_CONFLICT");
    expect(await obligations("SYN-CAP-4")).toBe(0);
    expect(await orders()).toBe(1);
    const [conflict] = await evidence(r.callId, "conflict");
    expect((conflict!.payload as { rule: string }).rule).toBe("SECONDARY_INTENT");
  });

  it("freshness boundary is inclusive", async () => {
    let now = OBSERVED_AT + FRESHNESS;
    const guard = await guardWith({ now: () => now });
    const edge = await guard.createOrderOnce({ capture: await issue("SYN-OBS-2"), intentId: "SYN-INT-2", ...CHECKOUT });
    expect(edge.outcome).toBe("CREATED");
    now += 1;
    const stale = await guard.createOrderOnce({ capture: await issue("SYN-OBS-3"), intentId: "SYN-INT-3", ...CHECKOUT });
    expect([stale.outcome, stale.reason]).toEqual(["REJECTED", "STALE"]);
    expect(await obligations("SYN-CAP-3")).toBe(0);
    const retry = await guard.createOrderOnce({ capture: await issue("SYN-OBS-2"), intentId: "SYN-INT-2", ...WEBHOOK });
    expect(retry.outcome).toBe("REUSED");
    expect(retry.result?.id).toBe(edge.result?.id);
  });

  it("a normal guard rejects a test capability as TEST_AUTHORITY with audit evidence", async () => {
    const cap = await issue("SYN-OBS-1");
    const { acceptTestAuthority: _a, testAuthorityKey: _k, ...normal } = options();
    const guard = await createGuard(normal); guards.push(guard);
    const r = await guard.createOrderOnce({ capture: cap, intentId: "SYN-INT-1", ...CHECKOUT });
    expect([r.outcome, r.reason]).toEqual(["REJECTED", "TEST_AUTHORITY"]);
    expect(await evidence(r.callId, "rejected")).toHaveLength(1);
    expect((await env.db.client.query("SELECT boundary FROM ordertruth_guard.commit_markers WHERE call_id = $1", [r.callId])).rows[0].boundary).toBe("REJECTION_AUDIT");
    expect(await obligations("SYN-CAP-1")).toBe(0);
  });

  it("rejects a forged MAC and a capability bound to another intent before the transaction", async () => {
    const guard = await guardWith(), cap = await issue("SYN-OBS-1");
    const forged = await guard.createOrderOnce({ capture: { ...cap, amountMinor: "1" }, intentId: "SYN-INT-1", ...CHECKOUT });
    const elsewhere = await guard.createOrderOnce({ capture: cap, intentId: "SYN-INT-2", ...CHECKOUT });
    const unhashable = await guard.createOrderOnce({ capture: { ...cap, amountMinor: 1n as unknown as string }, intentId: "SYN-INT-1", ...CHECKOUT });
    expect([forged.reason, elsewhere.reason, unhashable.reason]).toEqual(["BAD_MAC", "BINDING_MISMATCH", "BAD_MAC"]);
    expect(await evidence(forged.callId, "rejected")).toHaveLength(1);
    expect(await obligations("SYN-CAP-1")).toBe(0);
  });

  it("reads the capability once, so a getter can't change a field after the MAC check", async () => {
    const guard = await guardWith({ now: () => OBSERVED_AT + FRESHNESS + 1 }), cap = await issue("SYN-OBS-2");
    let reads = 0;
    const tricky = { ...cap } as CaptureCapability;
    Object.defineProperty(tricky, "observedAt", { enumerable: true,
      get: () => (++reads === 1 ? cap.observedAt : new Date(OBSERVED_AT + FRESHNESS).toISOString()) });
    const r = await guard.createOrderOnce({ capture: tricky, intentId: "SYN-INT-2", ...CHECKOUT });
    expect([r.outcome, r.reason]).toEqual(["REJECTED", "STALE"]);
    expect(reads).toBe(1);
  });

  it("an identical concurrent claim that passes the PK pre-check before the first claim's PK entry is REUSED, not a conflict", async () => {
    // Index order as a dump/restore can leave it (unique intent index, then a slow index, then the PK): the second claim's PK
    // arbiter pre-check passes while the first sleeps in the slow index, so the second meets the intent index first (23505).
    await env.db.client.query(`CREATE FUNCTION public.ot_slow(t text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN PERFORM pg_sleep(0.4); RETURN t; END $$;
      CREATE INDEX obligations_slow ON ordertruth_guard.obligations (public.ot_slow(capture_id));
      ALTER TABLE ordertruth_guard.obligations DROP CONSTRAINT obligations_pkey, ADD PRIMARY KEY (merchant_id, operation_kind, obligation_key)`);
    const indexes = (await env.db.client.query(`SELECT array_agg(indexrelid::regclass::text ORDER BY indexrelid) AS o FROM pg_index
      WHERE indrelid = 'ordertruth_guard.obligations'::regclass`)).rows[0].o;
    expect(indexes).toEqual(["ordertruth_guard.obligations_p1_intent", "ordertruth_guard.obligations_slow", "ordertruth_guard.obligations_pkey"]);
    const guard = await guardWith(), cap = await issue("SYN-OBS-1");
    const a = guard.createOrderOnce({ capture: cap, intentId: "SYN-INT-1", ...CHECKOUT });
    await new Promise(r => setTimeout(r, 150));
    const b = guard.createOrderOnce({ capture: cap, intentId: "SYN-INT-1", ...WEBHOOK });
    const [ra, rb] = [await a, await b];
    expect([ra.outcome, rb.outcome]).toEqual(["CREATED", "REUSED"]);
    expect(rb.result?.id).toBe(ra.result?.id);
    expect(await evidence(rb.callId, "conflict")).toHaveLength(0);
  });

  it("live environment is refused at startup (sandbox only)", async () => {
    await expect(createGuard(options({ paypalEnv: "live" as "sandbox" }))).rejects.toThrow(/sandbox only/);
  });

  it("evidence substitution rejected", async () => {
    const guard = await guardWith();
    const two = await issue("SYN-OBS-2"), three = await issue("SYN-OBS-3");
    const r = await guard.createOrderOnce({ capture: resign(two, { evidenceId: three.evidenceId }), intentId: "SYN-INT-2", ...CHECKOUT });
    expect([r.outcome, r.reason]).toEqual(["REJECTED", "EVIDENCE_MISMATCH"]);
    expect(await obligations("SYN-CAP-2")).toBe(0);
  });

  it("missing capture evidence is NO_CAPTURE_EVIDENCE", async () => {
    const guard = await guardWith(), two = await issue("SYN-OBS-2");
    const r = await guard.createOrderOnce({ capture: resign(two, { evidenceId: "0".repeat(64) }), intentId: "SYN-INT-2", ...CHECKOUT });
    expect([r.outcome, r.reason]).toEqual(["REJECTED", "NO_CAPTURE_EVIDENCE"]);
  });

  it("lying RETURNING is caught by persisted re-read", async () => {
    const lying = { ...V_A_CONFIG, createOrder: { ...V_A_CONFIG.createOrder,
      sql: "INSERT INTO shop.orders (intent_id, paypal_order_id, capture_id, amount_minor, currency, created_by_path) VALUES ($1, $2, $3, 0, $5, $6) "
        + "RETURNING id, intent_id, paypal_order_id, capture_id, $4::text AS amount_minor, currency" } };
    const guard = await guardWith({ config: lying });
    const r = await guard.createOrderOnce({ capture: await issue("SYN-OBS-1"), intentId: "SYN-INT-1", ...CHECKOUT });
    expect([r.outcome, r.reason]).toEqual(["REJECTED", "STATEMENT_POSTCONDITION"]);
    expect(await orders()).toBe(0);
    expect(await obligations("SYN-CAP-1")).toBe(0);
  });

  it("pool exhaustion fails retryable without deadlock", async () => {
    const pool = new pg.Pool({ ...env.opConfig(), max: 2, connectionTimeoutMillis: 1000 }); pool.on("error", () => {});
    try {
      const cap = await issue("SYN-OBS-1");
      const guard = await guardWith({ pool, timeouts: { lockMs: 2000, statementMs: 5000, connectionMs: 1000 } });
      const started = Date.now();
      const settled = await Promise.allSettled(Array.from({ length: 10 }, (_v, k) => guard.createOrderOnce({ capture: cap, intentId: "SYN-INT-1", ...(k % 2 ? WEBHOOK : CHECKOUT) })));
      expect(Date.now() - started).toBeLessThanOrEqual(1000 + 2000);
      const outcomes = settled.flatMap(s => s.status === "fulfilled" ? [s.value.outcome] : []);
      expect(outcomes.filter(x => x === "CREATED")).toHaveLength(1);
      expect(outcomes.every(x => x === "CREATED" || x === "REUSED")).toBe(true);
      for (const s of settled) if (s.status === "rejected") expect(s.reason).toBeInstanceOf(GuardRetryableError);
      expect(await orders()).toBe(1);
    } finally { while (guards.length) await guards.pop()!.close(); await pool.end(); }
  });
});

describe("createGuard startup checks (plan Task 6)", () => {
  it("refuses unsafe or inconsistent configuration", async () => {
    await expect(createGuard(options({ timeouts: { lockMs: Infinity, statementMs: 5000, connectionMs: 5000 } }))).rejects.toThrow(/finite/);
    await expect(createGuard(options({ merchantId: "SYN-M-B" }))).rejects.toThrow(/another merchant/);
    await expect(createGuard(options({ config: { ...V_A_CONFIG, createOrder: { ...V_A_CONFIG.createOrder, sql: "COMMIT", params: [] } } }))).rejects.toThrow(/transaction control/);
    const noTimeout = new pg.Pool({ ...env.opConfig(), connectionTimeoutMillis: 0 });
    try { await expect(createGuard(options({ pool: noTimeout }))).rejects.toThrow(/connectionTimeoutMillis/); } finally { await noTimeout.end(); }
    delete process.env.ORDERTRUTH_GUARD_MODE;
    await expect(createGuard(options())).rejects.toThrow(/ORDERTRUTH_GUARD_MODE=verifier/);
    process.env.ORDERTRUTH_GUARD_MODE = "verifier"; process.env.NODE_ENV = "production";
    await expect(createGuard(options())).rejects.toThrow(/production/);
  });

  it("refuses production when TEST-authority obligations exist", async () => {
    const guard = await guardWith();
    await guard.createOrderOnce({ capture: await issue("SYN-OBS-1"), intentId: "SYN-INT-1", ...CHECKOUT });
    process.env.NODE_ENV = "production";
    const { acceptTestAuthority: _a, testAuthorityKey: _k, ...normal } = options();
    await expect(createGuard(normal)).rejects.toThrow(/TEST-authority obligations/);
  });

  it("refuses a resolver role that can't see the operation role's backends", async () => {
    await env.db.client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ot_guard_aux') THEN CREATE ROLE ot_guard_aux LOGIN PASSWORD 'ot-guard-aux-disposable'; END IF; END $$`);
    await env.db.client.query(`GRANT USAGE ON SCHEMA ordertruth_guard TO ot_guard_aux; GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ordertruth_guard TO ot_guard_aux`);
    const auxConnectionString = env.auxConnectionString({ user: "ot_guard_aux", password: "ot-guard-aux-disposable" });
    await expect(createGuard(options({ auxConnectionString }))).rejects.toThrow(/pg_read_all_stats/);
  });
});

describe("resolution after a complete restart (spec §5.3e items 5–6; plan Task 6 restart matrix)", () => {
  const child = fileURLToPath(new URL("./guard-restart-child.ts", import.meta.url));
  /** Arms the proxy, runs one guard call in a child process that exits from the commit-failure path, and returns its callId. */
  async function crashAfterCommit(boundary: "ISSUANCE" | "OPERATION" | "REJECTION_AUDIT", call: Record<string, unknown>): Promise<string> {
    env.proxy.arm({ boundary, mode: "drop-commit-ack" });
    const run = await runChild(child, JSON.stringify({ op: { ...env.opConfig(), max: undefined }, auxConnectionString: env.auxConnectionString(),
      capabilityKey: capabilityKey.toString("hex"), testKey: testKey.toString("hex"), call }));
    const dropped = env.proxy.events().some(e => e.boundary === boundary && e.action === "commit-ack-dropped");
    env.proxy.reset();
    const out = JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}") as { exited?: string; callId?: string };
    expect(out.exited, `stdout: ${run.stdout}\nstderr: ${run.stderr}`).toBe("commit-failure");
    expect(dropped).toBe(true);
    return out.callId!;
  }
  const order = (capture: CaptureCapability, intentId: string, extra: Record<string, unknown> = {}) =>
    ({ kind: "order", capture, intentId, ...WEBHOOK, nowMs: OBSERVED_AT, acceptTestAuthority: true, ...extra });
  const recover = async (callId: string) => {
    const guard = await guardWith();          // a new guard: nothing from the child's process memory
    return (await guard.recoverPending({ olderThanMs: 0 })).find(x => x.callId === callId);
  };

  it("resolve after restart rebuilds CreateOrderResult from durable records", async () => {
    const callId = await crashAfterCommit("OPERATION", order(await issue("SYN-OBS-1"), "SYN-INT-1"));
    const r = await recover(callId);
    expect(r?.state).toBe("COMMITTED");
    expect(r?.result?.outcome).toBe("CREATED");
    const observed = (await env.db.client.query("SELECT id FROM shop.orders WHERE capture_id = 'SYN-CAP-1'")).rows;
    expect(observed).toHaveLength(1);
    expect(r?.result?.result).toEqual({ table: "orders", id: observed[0].id });
    expect(await n("SELECT count(*) AS n FROM ordertruth_guard.obligations WHERE claimed_by_call_id = $1", [callId])).toBe(1);
  });

  it("REUSED after restart keeps the earlier claim's call ID and creates nothing new", async () => {
    const cap = await issue("SYN-OBS-1");
    const first = await (await guardWith()).createOrderOnce({ capture: cap, intentId: "SYN-INT-1", ...CHECKOUT });
    const callId = await crashAfterCommit("OPERATION", order(cap, "SYN-INT-1"));
    const r = await recover(callId);
    expect([r?.state, r?.result?.outcome]).toEqual(["COMMITTED", "REUSED"]);
    expect(r?.result?.result?.id).toBe(first.result?.id);
    expect(r?.result?.originalClaimCallId).toBe(first.callId);
    expect(await orders()).toBe(1);
    expect(await n("SELECT count(*) AS n FROM ordertruth_guard.obligations WHERE claimed_by_call_id = $1", [callId])).toBe(0);
  });

  it("IDENTITY_CONFLICT after restart preserves both observations and creates nothing new", async () => {
    await (await guardWith()).createOrderOnce({ capture: await issue("SYN-OBS-1"), intentId: "SYN-INT-1", ...CHECKOUT });
    const callId = await crashAfterCommit("OPERATION", order(await issue("SYN-OBS-1B"), "SYN-INT-1"));
    const r = await recover(callId);
    expect([r?.state, r?.result?.outcome]).toEqual(["COMMITTED", "IDENTITY_CONFLICT"]);
    expect(await orders()).toBe(1);
    expect(await obligations("SYN-CAP-1")).toBe(1);
    expect(await evidence(callId, "conflict")).toHaveLength(1);
  });

  it("OPERATION/REJECTED after restart keeps no claim or effect", async () => {
    const callId = await crashAfterCommit("OPERATION", order(await issue("SYN-OBS-2"), "SYN-INT-2", { nowMs: OBSERVED_AT + FRESHNESS + 1 }));
    const r = await recover(callId);
    expect([r?.state, r?.result?.outcome, r?.result?.reason]).toEqual(["COMMITTED", "REJECTED", "STALE"]);
    expect(await obligations("SYN-CAP-2")).toBe(0);
    expect(await orders()).toBe(0);
  });

  it("REJECTION_AUDIT/REJECTED after restart is recovered from its audit marker", async () => {
    const callId = await crashAfterCommit("REJECTION_AUDIT", order(await issue("SYN-OBS-1"), "SYN-INT-1", { acceptTestAuthority: false }));
    const r = await recover(callId);
    expect([r?.state, r?.boundary, r?.result?.outcome, r?.result?.reason]).toEqual(["COMMITTED", "REJECTION_AUDIT", "REJECTED", "TEST_AUTHORITY"]);
    expect(await obligations("SYN-CAP-1")).toBe(0);
    expect(await evidence(callId, "rejected")).toHaveLength(1);
  });

  it("ISSUANCE after restart reconstructs the evidence reference", async () => {
    const callId = await crashAfterCommit("ISSUANCE", { kind: "issue", observationId: "SYN-OBS-3" });
    const r = await recover(callId);
    const o = fixture.observations.find(x => x.observationId === "SYN-OBS-3")!;
    const expected = evidenceIdOf({ authority: o.authority, merchantId: "SYN-M-A", captureId: o.captureId, observationHash: o.observationHash });
    expect([r?.state, r?.boundary, r?.evidenceId]).toEqual(["COMMITTED", "ISSUANCE", expected]);
    expect(await n("SELECT count(*) AS n FROM ordertruth_guard.outbox WHERE event_id = $1", [observationEventId("SYN-M-A", expected)])).toBe(1);
  });

  it("missing required evidence after restart stays STILL_UNKNOWN", async () => {
    const created = await crashAfterCommit("OPERATION", order(await issue("SYN-OBS-1"), "SYN-INT-1"));
    await env.db.client.query(`DELETE FROM ordertruth_guard.outbox_deliveries WHERE event_id =
      (SELECT outcome_record->>'evidenceEventId' FROM ordertruth_guard.commit_markers WHERE call_id = $1)`, [created]);
    const issued = await crashAfterCommit("ISSUANCE", { kind: "issue", observationId: "SYN-OBS-3" });
    await env.db.client.query(`DELETE FROM ordertruth_guard.outbox_deliveries WHERE event_id =
      (SELECT outcome_record->>'observationEventId' FROM ordertruth_guard.commit_markers WHERE call_id = $1)`, [issued]);
    const guard = await guardWith();
    const recovered = await guard.recoverPending({ olderThanMs: 0 });
    expect(recovered.find(x => x.callId === created)?.state).toBe("STILL_UNKNOWN");
    expect(recovered.find(x => x.callId === issued)?.state).toBe("STILL_UNKNOWN");
    expect((await guard.resolve(created)).result).toBeUndefined();
  });

  it("a marker holding another call's outcome record stays STILL_UNKNOWN", async () => {
    const guard = await guardWith(), cap = await issue("SYN-OBS-1");
    const y = await guard.createOrderOnce({ capture: cap, intentId: "SYN-INT-1", ...CHECKOUT });
    const x = await guard.createOrderOnce({ capture: cap, intentId: "SYN-INT-1", ...WEBHOOK });
    const z = await guard.createOrderOnce({ capture: { ...cap, amountMinor: "1" }, intentId: "SYN-INT-1", ...WEBHOOK });
    expect([y.outcome, x.outcome, z.reason]).toEqual(["CREATED", "REUSED", "BAD_MAC"]);
    for (const victim of [x.callId, z.callId]) await env.db.client.query(`UPDATE ordertruth_guard.commit_markers
      SET outcome_record = (SELECT outcome_record FROM ordertruth_guard.commit_markers WHERE call_id = $2) WHERE call_id = $1`, [victim, y.callId]);
    expect((await guard.resolve(y.callId)).state).toBe("COMMITTED");        // control: the record's own call still confirms
    expect((await guard.resolve(x.callId)).state).toBe("STILL_UNKNOWN");
    expect((await guard.resolve(z.callId)).state).toBe("STILL_UNKNOWN");
  });

  it("a rejection record with its attempted effect erased stays STILL_UNKNOWN", async () => {
    const lying = { ...V_A_CONFIG, createOrder: { ...V_A_CONFIG.createOrder,
      sql: "INSERT INTO shop.orders (intent_id, paypal_order_id, capture_id, amount_minor, currency, created_by_path) VALUES ($1, $2, $3, 0, $5, $6) "
        + "RETURNING id, intent_id, paypal_order_id, capture_id, $4::text AS amount_minor, currency" } };
    const guard = await guardWith({ config: lying });
    const r = await guard.createOrderOnce({ capture: await issue("SYN-OBS-1"), intentId: "SYN-INT-1", ...CHECKOUT });
    expect(r.reason).toBe("STATEMENT_POSTCONDITION");
    expect((await guard.resolve(r.callId)).state).toBe("COMMITTED");
    await env.db.client.query(`UPDATE ordertruth_guard.commit_markers SET outcome_record = jsonb_set(outcome_record, '{attemptedResultIds}', '[]')
      WHERE call_id = $1`, [r.callId]);
    expect((await guard.resolve(r.callId)).state).toBe("STILL_UNKNOWN");
  });

  it("a tampered outcome record stays STILL_UNKNOWN", async () => {
    const callId = await crashAfterCommit("OPERATION", order(await issue("SYN-OBS-2"), "SYN-INT-2"));
    await env.db.client.query(`UPDATE ordertruth_guard.commit_markers SET outcome_record = jsonb_set(outcome_record, '{result,id}', '"not-an-order"') WHERE call_id = $1`, [callId]);
    expect((await recover(callId))?.state).toBe("STILL_UNKNOWN");
  });
});
