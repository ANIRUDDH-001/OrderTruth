import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresPool } from "../../src/db/postgres.ts";
import { migratePostgres } from "../../src/db/postgres-migrate.ts";
import { PostgresCheckoutStore } from "../../src/db/postgres-checkout.ts";
import { PostgresCheckoutService } from "../../src/postgres-checkout-service.ts";
import { PayPalError, type PayPalCall } from "../../src/paypal/client.ts";
import type { OrderReadback } from "../../src/domain/checkout.ts";

const env = parseEnv(readFileSync(new URL("../../.work/postgres/.env", import.meta.url), "utf8"));
if (env.PGHOST !== "127.0.0.1" || env.PGPORT !== "55432" || env.PGDATABASE !== "ordertruth") throw new Error("Managed local PostgreSQL only");
const pool = createPostgresPool(env.DATABASE_URL!);
const schema = `qual_${randomBytes(10).toString("hex")}`;
const store = new PostgresCheckoutStore(pool, schema);
beforeAll(() => migratePostgres(pool, schema));
afterAll(async () => { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });
const call = <T>(body: T, status = 200): PayPalCall<T> => ({ body, httpStatus: status, debugId: "synthetic-debug", durationMs: 2, requestId: null, correlationId: "synthetic-correlation" });

function fixture(options: { loseCaptureResponse?: boolean; failGetAfterCapture?: boolean } = {}) {
  const order = randomBytes(9).toString("hex").toUpperCase();
  const capture = randomBytes(9).toString("hex").toUpperCase();
  let intent = ""; let captured = false; let captureCalls = 0; let readCalls = 0;
  const requestIds: string[] = [];
  const provider = {
    async createOrder(body: unknown, requestId: string) {
      intent = (body as { purchase_units: Array<{ custom_id: string }> }).purchase_units[0]!.custom_id;
      requestIds.push(requestId);
      return call({ id: order, status: "CREATED", links: [] }, 201);
    },
    async getOrder() {
      readCalls++;
      if (captured && options.failGetAfterCapture) throw new PayPalError("timeout", "Synthetic readback timeout", { httpStatus: null, debugId: null, issues: [], durationMs: 1 });
      const raw: OrderReadback = { id: order, intent: "CAPTURE", status: captured ? "COMPLETED" : "APPROVED", purchase_units: [{ custom_id: intent, amount: { currency_code: "USD", value: "1.00" },
        ...(captured ? { payments: { captures: [{ id: capture, status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } }] } } : {}) }] };
      return call(raw);
    },
    async captureOrder(_id: string, requestId: string) {
      // External calls must not run while this app's database transaction is open.
      const active = await pool.query("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND state='idle in transaction' AND query LIKE '%payment_attempts%'");
      expect(active.rows[0].n).toBe(0);
      captureCalls++; requestIds.push(requestId); captured = true;
      if (options.loseCaptureResponse) throw new PayPalError("timeout", "Synthetic capture response lost", { httpStatus: null, debugId: null, issues: [], durationMs: 1 });
      // A POST result alone is never sufficient evidence of capture.
      return call({ id: order, status: "COMPLETED", links: [] }, 201);
    },
  };
  return { service: new PostgresCheckoutService(provider, store, "SYNTHETIC_QUALIFICATION"), another: () => new PostgresCheckoutService(provider, store, "SYNTHETIC_QUALIFICATION"), order, requestIds,
    captures: () => captureCalls, reads: () => readCalls };
}
it("uses server pricing and one durable capture claim across independent service instances", async () => {
  const f = fixture(); const key = `synthetic-checkout-${randomBytes(8).toString("hex")}`;
  const created = await f.service.create(key);
  expect(created.amount).toEqual({ currency: "USD", value: "1.00" });
  const outcomes = await Promise.all(Array.from({ length: 5 }, () => f.another().capture(f.order)));
  expect(f.captures()).toBe(1);
  expect(outcomes.some(o => o.state === "captured")).toBe(true);
  expect((await f.service.readback(f.order)).state).toBe("captured");
  expect((await pool.query(`SELECT summary_json FROM ${schema}.evidence WHERE operation='readback' AND attempt_id=$1`, [created.attemptId])).rows.every(r => JSON.parse(r.summary_json).provenance === "SYNTHETIC_QUALIFICATION")).toBe(true);
});
it("settles a lost capture response by GET without issuing another capture", async () => {
  const f = fixture({ loseCaptureResponse: true }); await f.service.create(`synthetic-checkout-${randomBytes(8).toString("hex")}`);
  expect((await f.service.capture(f.order)).state).toBe("captured");
  expect((await f.service.capture(f.order)).state).toBe("captured");
  expect(f.captures()).toBe(1); expect(f.reads()).toBeGreaterThanOrEqual(2);
  const errors = (await pool.query(`SELECT summary_json FROM ${schema}.evidence WHERE operation='capture_order_error' AND attempt_id=(SELECT id FROM ${schema}.payment_attempts WHERE paypal_order_id=$1)`, [f.order])).rows;
  expect(errors).toHaveLength(1);
  expect(JSON.parse(errors[0]!.summary_json)).toMatchObject({ kind: "timeout", outcomeUnknown: true, provenance: "SYNTHETIC_QUALIFICATION" });
});
it("never claims capture from a POST when authoritative GET is unavailable", async () => {
  const f = fixture({ failGetAfterCapture: true }); await f.service.create(`synthetic-checkout-${randomBytes(8).toString("hex")}`);
  await expect(f.service.capture(f.order)).rejects.toMatchObject({ code: "outcome_unknown" });
  await expect(f.service.capture(f.order)).rejects.toMatchObject({ code: "outcome_unknown" });
  expect(f.captures()).toBe(1);
  const row = (await pool.query(`SELECT state FROM ${schema}.payment_attempts WHERE paypal_order_id=$1`, [f.order])).rows[0];
  expect(row.state).not.toBe("captured");
});
