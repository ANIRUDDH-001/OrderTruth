import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGuard, type Guard } from "../../packages/guard/src/guard.ts";
import { migrateGuard } from "../../packages/guard/src/schema.ts";
import { createTestCaptureAuthority } from "../../packages/guard/src/testing/index.ts";
import * as cross from "../../packages/lab-merchant/src/nc/nc3-key-on-path.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { SHOP_INTENTS_SQL, SHOP_SCHEMA_SQL } from "../../packages/lab-merchant/src/schema.ts";
import type { Handler, HandlerResult, MerchantDeps } from "../../packages/lab-merchant/src/types.ts";
import * as original from "../../packages/lab-merchant/src/v-a/original.ts";
import { V_A_CONFIG } from "../../packages/lab-merchant/src/v-a/ordertruth.config.ts";
import * as fix from "../../packages/lab-merchant/src/v-a/reference-fix.ts";
import { createDisposableDatabase, type DisposableDatabase } from "./harness.ts";
import { fixture, until } from "./setup.ts";

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
describe("Phase 1 frozen merchant defect matrix (synthetic PostgreSQL)", () => {
  const variants = [
    { name: "race", module: original, guarded: false, sequential: 1, overlap: 2 },
    { name: "cross-path", module: cross, guarded: false, sequential: 2, overlap: 2 },
    { name: "corrected", module: fix, guarded: true, sequential: 1, overlap: 1 },
    { name: "corrected-two-captures", module: fix, guarded: true, sequential: 2, overlap: 2 },
  ];
  for (const v of variants) for (const schedule of ["sequential", "overlap"] as const) {
    it(`${v.name}: ${schedule}`, async () => {
      const trace: Array<{ kind: string; [key: string]: unknown }> = [];
      const d = await deps(v.guarded);
      const second = v.name === "corrected-two-captures"
        ? { ...d, capability: await createTestCaptureAuthority({ pools: { op: pool, aux }, merchantId: "SYN-M-A", fixture, key: testKey }).issue("SYN-OBS-2") } : d;
      const input = { intentId: "SYN-INT-1", observationId: "SYN-OBS-1" };
      const wrap = (base: MerchantDeps, path: string): MerchantDeps => {
        const tracedPool = { query: async (sql: string, values: unknown[]) => {
          trace.push({ kind: "query-attempt", path, sql, values });
          const result = await pool.query(sql, values);
          trace.push({ kind: sql.startsWith("SELECT") ? "existence-check" : "write-result", path, rows: result.rows });
          return result;
        } } as unknown as pg.Pool;
        return { ...base, pool: tracedPool, afterCheck: async () => {
          trace.push({ kind: "barrier-arrival", path, captureId: base.capability!.captureId });
          if (schedule === "overlap") await base.afterCheck();
        } };
      };
      const call = async (path: "checkout_return" | "webhook", base: MerchantDeps) => {
        trace.push({ kind: "handler-start", path, captureId: base.capability!.captureId, intentId: base.capability!.intentId });
        const callInput = { intentId: base.capability!.intentId, observationId: base === second && second !== d ? "SYN-OBS-2" : input.observationId };
        const result = await (path === "checkout_return" ? v.module.handleCheckoutReturn : v.module.handleCaptureWebhook)(wrap(base, path), callInput);
        trace.push({ kind: "handler-result", path, result });
        return result;
      };
      let results: HandlerResult[];
      if (schedule === "overlap") {
        await db.client.query("SELECT pg_advisory_lock($1)", [K1]);
        const both = Promise.all([call("checkout_return", d), call("webhook", second)]);
        try { await until(async () => (await waiters(K1)) === 2); }
        finally { await db.client.query("SELECT pg_advisory_unlock($1)", [K1]); }
        results = await both;
      } else results = [await call("checkout_return", d), await call("webhook", second)];
      const rows = (await db.client.query("SELECT * FROM shop.orders ORDER BY created_at, id")).rows;
      expect(results.every(r => r.ok), JSON.stringify(results)).toBe(true);
      expect(rows).toHaveLength(v[schedule]);
      if (v.guarded) {
        expect(new Set(rows.map(r => r.capture_id)).size).toBe(rows.length);
        expect(results.every(r => r.ok && ["CREATED", "REUSED"].includes(r.guardOutcome!))).toBe(true);
        const replay = await v.module.handleCheckoutReturn({ ...d, afterCheck: async () => {} }, input);
        expect(replay).toMatchObject({ ok: true, created: false });
        expect((await db.client.query("SELECT * FROM shop.orders")).rows).toHaveLength(v[schedule]);
      }
      if (schedule === "overlap") expect(trace.filter(e => e.kind === "barrier-arrival")).toHaveLength(2);
      mkdirSync(".work/runs/handoff-20261105/matrix", { recursive: true });
      writeFileSync(`.work/runs/handoff-20261105/matrix/${v.name}-${schedule}.json`, JSON.stringify({ provenance: "SYNTHETIC_FIXTURE", variant: v.name, schedule, trace, results, rows }, null, 2));
    });
  }
});
