import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGuard, type Guard } from "../../packages/guard/src/guard.ts";
import { migrateGuard } from "../../packages/guard/src/schema.ts";
import { createTestCaptureAuthority } from "../../packages/guard/src/testing/index.ts";
import { createLabWebhookJournal } from "../../src/merchant/lab-webhook-journal.ts";
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
async function deps(withGuard: boolean): Promise<MerchantDeps> {
  const capability = await createTestCaptureAuthority({ pools: { op: pool, aux }, merchantId: "SYN-M-A", fixture, key: testKey }).issue("SYN-OBS-1");
  if (!withGuard) return { pool, afterCheck: barrier(K1), capability };
  const guard = await createGuard({ pool, auxConnectionString: auxUrl(), auxMax: 2, merchantId: "SYN-M-A", buildId: "lab-test", paypalEnv: "sandbox", capabilityKey,
    config: V_A_CONFIG, freshnessMs: 365 * 24 * 3600_000, timeouts: { lockMs: 5000, statementMs: 10_000, connectionMs: 5000 }, acceptTestAuthority: true, testAuthorityKey: testKey });
  guards.push(guard);
  return { pool, afterCheck: barrier(K1), capability, guard };
}
describe("offline durable Lab event journal with actual PostgreSQL writers", () => {
  for (const variant of [{ name: "cross-path", module: cross, guarded: false, expected: 2 }, { name: "corrected", module: fix, guarded: true, expected: 1 }]) {
    it(`${variant.name}: checkout then journalled webhook and restarted replay`, async () => {
      const d = { ...await deps(variant.guarded), afterCheck: async () => {} };
      const input = { intentId: "SYN-INT-1", observationId: "SYN-OBS-1" };
      expect(await variant.module.handleCheckoutReturn(d, input)).toMatchObject({ ok: true });
      const journal = await createLabWebhookJournal(pool, "SYN-SCOPE");
      const eventId = "WH-SYNTHETIC-EVENT1";
      const write = async () => ({ outcome: "written" as const, eventId, provenance: "MOCK_READBACK" as const,
        result: await variant.module.handleCaptureWebhook({ ...d, pool: journal.writerPool }, input) });
      expect(await journal.once(eventId, write)).toMatchObject({ outcome: "written" });
      const restarted = await createLabWebhookJournal(pool, "SYN-SCOPE");
      expect(await restarted.once(eventId, async () => { throw new Error("replay invoked writer"); })).toEqual({ outcome: "replay", eventId });
      expect(await orders()).toBe(variant.expected);
      const state = (await db.client.query("SELECT * FROM shop.orders ORDER BY created_at")).rows;
      mkdirSync(".work/runs/handoff-20261105/webhook", { recursive: true });
      writeFileSync(`.work/runs/handoff-20261105/webhook/${variant.name}.json`, JSON.stringify({ provenance: "SYNTHETIC_FIXTURE", limitation: "Journal/writer integration only; no signature verification or provider call in this test", eventId, state }, null, 2));
    });
  }
  it("serializes independent journal instances and rolls back failed vulnerable writes", async () => {
    const d = { ...await deps(false), afterCheck: async () => {} };
    const input = { intentId: "SYN-INT-1", observationId: "SYN-OBS-1" };
    const journal = await createLabWebhookJournal(pool, "SYN-SCOPE");
    const second = await createLabWebhookJournal(pool, "SYN-SCOPE");
    const eventId = "WH-SYNTHETIC-EVENT2";
    const write = async (j: typeof journal) => ({ outcome: "written" as const, eventId, provenance: "MOCK_READBACK" as const,
      result: await cross.handleCaptureWebhook({ ...d, pool: j.writerPool }, input) });
    await expect(journal.once(eventId, async () => { await write(journal); throw new Error("SYN rollback"); })).rejects.toThrow("SYN rollback");
    expect(await orders()).toBe(0);
    expect((await db.client.query("SELECT * FROM lab_webhook.receipts")).rows).toHaveLength(0);
    const results = await Promise.all([journal.once(eventId, () => write(journal)), second.once(eventId, () => write(second))]);
    expect(results.map(r => r.outcome).sort()).toEqual(["replay", "written"]);
    expect(await orders()).toBe(1);
  });
});
