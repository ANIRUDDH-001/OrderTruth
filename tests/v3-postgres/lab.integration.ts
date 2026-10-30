import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGuard, type Guard } from "../../packages/guard/src/guard.ts";
import { migrateGuard } from "../../packages/guard/src/schema.ts";
import { createTestCaptureAuthority } from "../../packages/guard/src/testing/index.ts";
import * as nc2 from "../../packages/lab-merchant/src/nc/nc2-suppress.ts";
import { SHOP_INTENTS_SQL, SHOP_SCHEMA_SQL } from "../../packages/lab-merchant/src/schema.ts";
import type { Handler, HandlerResult, MerchantDeps } from "../../packages/lab-merchant/src/types.ts";
import * as original from "../../packages/lab-merchant/src/v-a/original.ts";
import { V_A_CONFIG } from "../../packages/lab-merchant/src/v-a/ordertruth.config.ts";
import * as fix from "../../packages/lab-merchant/src/v-a/reference-fix.ts";
import { createDisposableDatabase, type DisposableDatabase } from "./harness.ts";
import { fixture, runChild, until } from "./setup.ts";

const testKey = Buffer.alloc(32, 7), capabilityKey = Buffer.alloc(32, 9), K1 = 4101;
const previousMode = process.env.ORDERTRUTH_GUARD_MODE;
let db: DisposableDatabase, pool: pg.Pool, aux: pg.Pool;
const guards: Guard[] = [];
beforeAll(() => { process.env.ORDERTRUTH_GUARD_MODE = "verifier"; });
beforeEach(async () => {
  db = await createDisposableDatabase();
  await migrateGuard(db.client, "SYN-M-A");
  await db.client.query(SHOP_SCHEMA_SQL); await db.client.query(SHOP_INTENTS_SQL);
  pool = new pg.Pool({ ...db.config, max: 6, connectionTimeoutMillis: 5000 }); aux = new pg.Pool({ ...db.config, max: 2, connectionTimeoutMillis: 5000 });
  pool.on("error", () => {}); aux.on("error", () => {});
});
afterEach(async () => { while (guards.length) await guards.pop()!.close(); await pool.end(); await aux.end(); await db.drop(); });
afterAll(() => { if (previousMode === undefined) delete process.env.ORDERTRUTH_GUARD_MODE; else process.env.ORDERTRUTH_GUARD_MODE = previousMode; });

const auxUrl = () => `postgres://${encodeURIComponent(String(db.config.user))}:${encodeURIComponent(String(db.config.password))}@${String(db.config.host)}:${Number(db.config.port)}/${db.name}`;
const orders = async () => Number((await db.client.query("SELECT count(*) AS n FROM shop.orders WHERE intent_id = 'SYN-INT-1'")).rows[0].n);
/** The verifier's barrier, in miniature: handlers block on advisory lock `k` after their check until the test releases it. */
const barrier = (k: number) => async () => { const c = await aux.connect(); try { await c.query("SELECT pg_advisory_lock($1)", [k]); await c.query("SELECT pg_advisory_unlock($1)", [k]); } finally { c.release(); } };
const waiters = async (k: number) => Number((await db.client.query("SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND NOT granted", [k])).rows[0].n);
async function deps(withGuard: boolean): Promise<MerchantDeps> {
  const capability = await createTestCaptureAuthority({ pools: { op: pool, aux }, merchantId: "SYN-M-A", fixture, key: testKey }).issue("SYN-OBS-1");
  if (!withGuard) return { pool, afterCheck: barrier(K1), capability };
  const guard = await createGuard({ pool, auxConnectionString: auxUrl(), auxMax: 2, merchantId: "SYN-M-A", buildId: "lab-test", paypalEnv: "sandbox", capabilityKey,
    config: V_A_CONFIG, freshnessMs: 365 * 24 * 3600_000, timeouts: { lockMs: 5000, statementMs: 10_000, connectionMs: 5000 }, acceptTestAuthority: true, testAuthorityKey: testKey });
  guards.push(guard);
  return { pool, afterCheck: barrier(K1), capability, guard };
}
/** Return and webhook for SYN-INT-1, both held at the barrier after their check, then released together. */
async function race(m: { handleCheckoutReturn: Handler; handleCaptureWebhook: Handler }, d: MerchantDeps): Promise<HandlerResult[]> {
  await db.client.query("SELECT pg_advisory_lock($1)", [K1]);
  const input = { intentId: "SYN-INT-1", observationId: "SYN-OBS-1" };
  const both = Promise.all([m.handleCheckoutReturn(d, input), m.handleCaptureWebhook(d, input)]);
  await until(async () => (await waiters(K1)) === 2);
  await db.client.query("SELECT pg_advisory_unlock($1)", [K1]);
  return both;
}

describe("Gate A lab merchant (plan Task 8; host development signal)", () => {
  it("original duplicates under barrier", async () => {
    const results = await race(original, await deps(false));
    expect(results.every(r => r.ok && r.created)).toBe(true);
    expect(await orders()).toBe(2);
  });

  it("reference fix one order under barrier", async () => {
    const results = await race(fix, await deps(true));
    expect(results.map(r => r.ok ? r.guardOutcome : r.code).sort()).toEqual(["CREATED", "REUSED"]);
    expect(await orders()).toBe(1);
  });

  it("NC2 reports success with no order", async () => {
    const r = await nc2.handleCheckoutReturn(await deps(false), { intentId: "SYN-INT-1", observationId: "SYN-OBS-1" });
    expect(r.ok).toBe(true);
    expect(await orders()).toBe(0);
  });

  it("candidate-main prints one claim line; NC10 is refused at guard construction", async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { PGHOST_OP: String(db.config.host), PGPORT_OP: String(db.config.port), PGHOST_AUX: String(db.config.host), PGPORT_AUX: String(db.config.port),
      PGUSER: String(db.config.user), PGPASSWORD: String(db.config.password), PGDATABASE_A: db.name,
      OT_TEST_AUTHORITY_KEY: testKey.toString("hex"), OT_CAPABILITY_KEY: capabilityKey.toString("hex") });
    try {
      const main = fileURLToPath(new URL("../../packages/lab-merchant/src/candidate-main.ts", import.meta.url));
      const run = await runChild(main, JSON.stringify({ candidate: "REFERENCE_FIX", op: "checkout_return", intentId: "SYN-INT-1", observationId: "SYN-OBS-1" }));
      const lines = run.stdout.trim().split("\n");
      expect(lines, run.stderr).toHaveLength(1);
      expect(JSON.parse(lines[0]!).claim).toMatchObject({ ok: true, created: true, guardOutcome: "CREATED" });
      expect(run.stdout).not.toContain(testKey.toString("hex"));
      expect(await orders()).toBe(1);
      const nc10 = await runChild(main, JSON.stringify({ candidate: "NC10", op: "construct" }));
      expect(JSON.parse(nc10.stdout.trim()).claim).toMatchObject({ ok: false, code: "DATA_MODIFYING_CTE" });
    } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  });
});
