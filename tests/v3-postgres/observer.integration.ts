import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGuard, type Guard } from "../../packages/guard/src/guard.ts";
import { migrateGuard } from "../../packages/guard/src/schema.ts";
import { createTestCaptureAuthority } from "../../packages/guard/src/testing/index.ts";
import * as nc8 from "../../packages/lab-merchant/src/nc/nc8-fake-evidence.ts";
import { SHOP_INTENTS_SQL, SHOP_SCHEMA_SQL } from "../../packages/lab-merchant/src/schema.ts";
import type { MerchantDeps } from "../../packages/lab-merchant/src/types.ts";
import * as original from "../../packages/lab-merchant/src/v-a/original.ts";
import { V_A_CONFIG } from "../../packages/lab-merchant/src/v-a/ordertruth.config.ts";
import * as fix from "../../packages/lab-merchant/src/v-a/reference-fix.ts";
import { holdBarrier, waitForLockWait } from "../../packages/verifier/src/barrier.ts";
import { assertClaimCorroborated, assertObligationsBackedByOrders, assertOneMatchingOrder, rolesSql, snapshot } from "../../packages/verifier/src/observer.ts";
import { adminConfig, createDisposableDatabase, type DisposableDatabase } from "./harness.ts";
import { fixture } from "./setup.ts";

const testKey = Buffer.alloc(32, 7), capabilityKey = Buffer.alloc(32, 9), K1 = 5101;
const passwords = { candidate_password: randomBytes(12).toString("hex"), observer_password: randomBytes(12).toString("hex") };
const previousMode = process.env.ORDERTRUTH_GUARD_MODE;
let db: DisposableDatabase, candidate: pg.Pool, observer: pg.Pool;
const guards: Guard[] = [];
const as = (user: string, password: string, max = 4) => { const p = new pg.Pool({ ...db.config, user, password, max, connectionTimeoutMillis: 5000 }); p.on("error", () => {}); return p; };
beforeAll(() => { process.env.ORDERTRUTH_GUARD_MODE = "verifier"; });
beforeEach(async () => {
  db = await createDisposableDatabase();
  await migrateGuard(db.client, "SYN-M-A");
  await db.client.query(SHOP_SCHEMA_SQL); await db.client.query(SHOP_INTENTS_SQL);
  const roles = rolesSql({ ...passwords, database: db.name });
  await db.client.query(roles.cluster); await db.client.query(roles.database); await db.client.query(roles.connect);
  candidate = as("ot_candidate", passwords.candidate_password); observer = as("ot_observer", passwords.observer_password);
});
afterEach(async () => { while (guards.length) await guards.pop()!.close(); await candidate.end(); await observer.end(); await db.drop(); });
afterAll(() => { if (previousMode === undefined) delete process.env.ORDERTRUTH_GUARD_MODE; else process.env.ORDERTRUTH_GUARD_MODE = previousMode; });

const SYN_1 = { captureId: "SYN-CAP-1", amountMinor: "1000", currency: "USD", paypalOrderId: "SYN-ORD-1" };
const auxUrl = () => `postgres://ot_candidate:${passwords.candidate_password}@${String(db.config.host)}:${Number(db.config.port)}/${db.name}`;
async function deps(withGuard: boolean): Promise<MerchantDeps> {
  const aux = as("ot_candidate", passwords.candidate_password, 2);
  const capability = await createTestCaptureAuthority({ pools: { op: candidate, aux }, merchantId: "SYN-M-A", fixture, key: testKey }).issue("SYN-OBS-1");
  await aux.end();
  const afterCheck = async () => { const c = await candidate.connect(); try { await c.query("SELECT pg_advisory_lock($1)", [K1]); await c.query("SELECT pg_advisory_unlock($1)", [K1]); } finally { c.release(); } };
  if (!withGuard) return { pool: candidate, afterCheck, capability };
  const guard = await createGuard({ pool: candidate, auxConnectionString: auxUrl(), auxMax: 2, merchantId: "SYN-M-A", buildId: "observer-test", paypalEnv: "sandbox",
    capabilityKey, config: V_A_CONFIG, freshnessMs: 365 * 24 * 3600_000, timeouts: { lockMs: 5000, statementMs: 10_000, connectionMs: 5000 },
    acceptTestAuthority: true, testAuthorityKey: testKey });
  guards.push(guard);
  return { pool: candidate, afterCheck, capability, guard };
}
const input = { intentId: "SYN-INT-1", observationId: "SYN-OBS-1" };

describe("verifier observer, barriers and roles (plan Task 9)", () => {
  it("snapshot reports 2 orders after a forced duplicate, and assertOneMatchingOrder fails", async () => {
    const d = await deps(false);
    const barrier = await holdBarrier(observer, K1);
    const both = Promise.all([original.handleCheckoutReturn(d, input), original.handleCaptureWebhook(d, input)]);
    await barrier.waitForWaiters(2, 5000);
    await barrier.release();
    await both;
    const s = await snapshot(observer);
    expect(s.ordersByIntent["SYN-INT-1"]).toHaveLength(2);
    expect(assertOneMatchingOrder(s, "SYN-INT-1", SYN_1).ok).toBe(false);
  });

  it("a reference-fix order is one matching order, backed and corroborated", async () => {
    const r = await fix.handleCheckoutReturn(await deps(true), input);
    const s = await snapshot(observer);
    expect(assertOneMatchingOrder(s, "SYN-INT-1", SYN_1)).toMatchObject({ ok: true });
    expect(assertOneMatchingOrder(s, "SYN-INT-1", { ...SYN_1, amountMinor: "999" }).ok).toBe(false);
    expect(assertObligationsBackedByOrders(s).ok).toBe(true);
    expect(r.ok && r.guardOutcome === "CREATED" && r.callId
      && assertClaimCorroborated({ kind: "guarded", guardOutcome: "CREATED", callId: r.callId, orderId: r.orderId, intentId: "SYN-INT-1", captureId: "SYN-CAP-1" }, s).ok).toBe(true);
    expect(s.markers.some(m => m.boundary === "OPERATION" && m.outcome === "CREATED")).toBe(true);
    expect(s.outboxKinds.claimed).toBe(1);
  });

  it("assertObligationsBackedByOrders fails for NC8-style rows, and their claim isn't corroborated", async () => {
    const r = await nc8.handleCheckoutReturn(await deps(false), input);
    const s = await snapshot(observer);
    expect(assertObligationsBackedByOrders(s).ok).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.ok && assertClaimCorroborated({ kind: "state_only", orderId: r.orderId, intentId: "SYN-INT-1", captureId: "SYN-CAP-1" }, s).ok).toBe(false);
    expect(r.ok && r.callId && assertClaimCorroborated({ kind: "guarded", guardOutcome: "CREATED", callId: r.callId, orderId: r.orderId,
      intentId: "SYN-INT-1", captureId: "SYN-CAP-1" }, s).ok).toBe(false);
  });

  it("assertClaimCorroborated fails for a claimed order that has no row", async () => {
    expect(assertClaimCorroborated({ kind: "state_only", orderId: "no-such-order", intentId: "SYN-INT-1", captureId: "SYN-CAP-1" }, await snapshot(observer)).ok).toBe(false);
  });

  // Review R2: the claimed outcome, call, obligation and order must be bound together, not merely each exist somewhere.
  it("guarded claims bind outcome, call, obligation and order; unrelated records never corroborate", async () => {
    const d = await deps(true), guard = d.guard!;
    const two = await createTestCaptureAuthority({ pools: { op: candidate, aux: candidate }, merchantId: "SYN-M-A", fixture, key: testKey }).issue("SYN-OBS-2");
    const a = await fix.handleCheckoutReturn(d, input);                                         // CREATED, SYN-INT-1
    const b = await fix.handleCheckoutReturn({ ...d, capability: two }, { intentId: "SYN-INT-2", observationId: "SYN-OBS-2" });   // CREATED, SYN-INT-2
    const reuse = await fix.handleCaptureWebhook(d, input);                                     // REUSED of a
    const audit = await guard.createOrderOnce({ capture: { ...d.capability!, amountMinor: "1" }, intentId: "SYN-INT-1", pathId: "webhook", siteId: "webhook:order-write" });
    if (!a.ok || !b.ok || !reuse.ok || !a.callId || !b.callId || !reuse.callId) throw new Error("setup failed");
    expect([a.guardOutcome, b.guardOutcome, reuse.guardOutcome, audit.outcome, audit.reason]).toEqual(["CREATED", "CREATED", "REUSED", "REJECTED", "BAD_MAC"]);
    const s = await snapshot(observer);
    const one = { intentId: "SYN-INT-1", captureId: "SYN-CAP-1" }, second = { intentId: "SYN-INT-2", captureId: "SYN-CAP-2" };
    const ok = (claim: Parameters<typeof assertClaimCorroborated>[0]) => assertClaimCorroborated(claim, s).ok;
    // legitimate claims
    expect(ok({ kind: "guarded", guardOutcome: "CREATED", callId: a.callId, orderId: a.orderId, ...one })).toBe(true);
    expect(ok({ kind: "guarded", guardOutcome: "CREATED", callId: b.callId, orderId: b.orderId, ...second })).toBe(true);
    expect(ok({ kind: "guarded", guardOutcome: "REUSED", callId: reuse.callId, orderId: a.orderId, ...one })).toBe(true);
    expect(ok({ kind: "guarded", guardOutcome: "REJECTED", callId: audit.callId, ...one })).toBe(true);
    expect(ok({ kind: "state_only", orderId: a.orderId, ...one })).toBe(true);
    // crossed pairs, wrong intent, wrong outcome
    expect(ok({ kind: "guarded", guardOutcome: "CREATED", callId: a.callId, orderId: b.orderId, ...one })).toBe(false);
    expect(ok({ kind: "guarded", guardOutcome: "CREATED", callId: b.callId, orderId: a.orderId, ...second })).toBe(false);
    expect(ok({ kind: "guarded", guardOutcome: "CREATED", callId: a.callId, orderId: a.orderId, ...second })).toBe(false);
    expect(ok({ kind: "guarded", guardOutcome: "REUSED", callId: a.callId, orderId: a.orderId, ...one })).toBe(false);
    expect(ok({ kind: "guarded", guardOutcome: "CREATED", callId: reuse.callId, orderId: a.orderId, ...one })).toBe(false);
    // the review probe: an existing order with an unrelated REJECTION_AUDIT marker
    expect(ok({ kind: "guarded", guardOutcome: "CREATED", callId: audit.callId, orderId: a.orderId, ...one })).toBe(false);
    expect(ok({ kind: "guarded", guardOutcome: "REJECTED", callId: audit.callId, orderId: a.orderId, ...one })).toBe(false);
    // state-only: the order must match the intent and capture
    expect(ok({ kind: "state_only", orderId: a.orderId, ...second })).toBe(false);
  });

  it("ot_candidate is denied the oracle, deletes and triggers (42501); ot_observer is read-only", async () => {
    const code = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string }) => e.code);
    expect(await code(candidate.query("SELECT * FROM verifier_oracle.expected"))).toBe("42501");
    expect(await code(candidate.query("DELETE FROM ordertruth_guard.obligations"))).toBe("42501");
    expect(await code(candidate.query("CREATE TRIGGER t BEFORE INSERT ON shop.orders FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()"))).toBe("42501");
    expect(await code(candidate.query("TRUNCATE shop.orders"))).toBe("42501");
    expect(await code(candidate.query("CREATE TABLE shop.extra (x int)"))).toBe("42501");
    expect(await code(candidate.query("SELECT pg_has_role('ot_candidate', 'pg_read_all_stats', 'MEMBER') AS m").then(r => { if (r.rows[0].m) throw { code: "HAS_STATS" }; })))
      .toBe("OK");
    expect(await code(observer.query("INSERT INTO shop.orders (intent_id, paypal_order_id, capture_id, amount_minor, currency, created_by_path) VALUES ('x','x','x',1,'USD','x')")))
      .toBe("42501");
    expect(await code(observer.query("SELECT count(*) FROM verifier_oracle.expected"))).toBe("OK");
  });

  // Review CP3 B1: a candidate that can write a template poisons every later clone; nor may it reach postgres or template1.
  it("templates, postgres and template1 refuse the candidate; a clone of the template grants it CONNECT", async () => {
    const admin = new pg.Client(adminConfig()); await admin.connect();
    const clone = `${db.name}_clone`;
    const connectAs = async (database: string) => {
      const c = new pg.Client({ ...db.config, user: "ot_candidate", password: passwords.candidate_password, database, connectionTimeoutMillis: 5000 });
      return c.connect().then(async () => { await c.end(); return "connected"; }, (e: { code?: string }) => e.code ?? "error");
    };
    try {
      await admin.query(rolesSql({ ...passwords, database: db.name }).template);
      expect(await connectAs(db.name)).toBe("55000");          // not accepting connections
      expect(await connectAs("postgres")).toBe("42501");
      expect(await connectAs("template1")).toBe("42501");
      await candidate.end(); await observer.end(); await db.client.end();
      await admin.query(`CREATE DATABASE ${clone} TEMPLATE ${db.name}`);
      const c = new pg.Client({ ...adminConfig(), database: clone }); await c.connect();
      await c.query(rolesSql({ ...passwords, database: clone }).connect); await c.end();
      expect(await connectAs(clone)).toBe("connected");
      candidate = as("ot_candidate", passwords.candidate_password); observer = as("ot_observer", passwords.observer_password);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${clone} WITH (FORCE)`).catch(() => {});
      await admin.query(`ALTER DATABASE ${db.name} WITH ALLOW_CONNECTIONS true`).catch(() => {});
      await admin.end();
    }
  });

  it("waitForLockWait sees a tagged backend waiting on a lock", async () => {
    const holder = await candidate.connect(), waiter = await candidate.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1)", [K1 + 1]);
      await waiter.query("SET application_name = 'ot:OPERATION'");
      const blocked = waiter.query("SELECT pg_advisory_lock($1)", [K1 + 1]);
      await waitForLockWait(observer, "ot:OPERATION", 5000);
      await holder.query("SELECT pg_advisory_unlock($1)", [K1 + 1]);
      await blocked;
      await waiter.query("SELECT pg_advisory_unlock($1)", [K1 + 1]);
      await expect(waitForLockWait(observer, "ot:OPERATION", 300)).rejects.toThrow(/timed out/);
    } finally { holder.release(); waiter.release(); }
  });
});
