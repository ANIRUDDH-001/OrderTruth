import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresPool, withTransaction } from "../../src/db/postgres.ts";
import { migratePostgres } from "../../src/db/postgres-migrate.ts";

const env = parseEnv(readFileSync(new URL("../../.work/postgres/.env", import.meta.url), "utf8"));
if (env.PGHOST !== "127.0.0.1" || env.PGPORT !== "55432" || env.PGDATABASE !== "ordertruth") throw new Error("Managed local PostgreSQL only");
const pool = createPostgresPool(env.DATABASE_URL!);
const schema = `qual_${randomBytes(10).toString("hex")}`;
beforeAll(async () => { await pool.query(`CREATE SCHEMA ${schema}`); });
afterAll(async () => {
  if (!/^qual_[a-f0-9]{20}$/.test(schema)) throw new Error("Unsafe qualification cleanup");
  await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});

it("installs the translated schema on real PostgreSQL with all guarded tables", async () => {
  await migratePostgres(pool, schema);
  const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname=$1", [schema]);
  expect(tables.rows.map(r => r.tablename)).toEqual(expect.arrayContaining([
    "checkout_intents", "payment_attempts", "evidence", "merchant_orders", "incidents",
    "repair_plans", "repair_approvals", "repair_executions", "repair_outcomes", "incident_resolutions", "webhook_events",
  ]));
});

it("retains state transitions, money checks and append-only evidence", async () => {
  await withTransaction(pool, async c => {
    await c.query("SELECT set_config('search_path',$1,true)", [`${schema},pg_catalog`]);
    await c.query("INSERT INTO checkout_intents(id,sku,currency,amount_minor,correlation_id,created_at) VALUES('CI1','SKU','USD',100,'CORR','2026-10-21T00:00:00.000Z')");
    await c.query("INSERT INTO payment_attempts(id,intent_id,create_request_id,capture_request_id,state,created_at,updated_at) VALUES('PA1','CI1','CREATE1','CAPTURE1','created','2026-10-21T00:00:00.000Z','2026-10-21T00:00:00.000Z')");
    await c.query("UPDATE payment_attempts SET capture_claimed_at_ms=$1 WHERE id='PA1'", [1792572300000]);
    const claim = await c.query("SELECT capture_claimed_at_ms FROM payment_attempts WHERE id='PA1'");
    expect(claim.rows[0].capture_claimed_at_ms).toBe(1792572300000);
    await c.query("SAVEPOINT invalid_state");
    await expect(c.query("UPDATE payment_attempts SET state='captured' WHERE id='PA1'")).rejects.toThrow(/illegal attempt state transition/);
    await c.query("ROLLBACK TO SAVEPOINT invalid_state");
    await c.query("UPDATE payment_attempts SET state='awaiting_buyer_approval' WHERE id='PA1'");
    await c.query("UPDATE payment_attempts SET state='captured',paypal_order_id='SYNTHETIC_ORDER',capture_id='SYNTHETIC_CAPTURE',capture_status='COMPLETED',captured_minor=100,captured_currency='USD' WHERE id='PA1'");
    await c.query("INSERT INTO evidence(attempt_id,evidence_class,operation,correlation_id,summary_json,created_at) VALUES('PA1','PAYPAL_API_READBACK','synthetic_qualification','CORR','{\"provenance\":\"SYNTHETIC_QUALIFICATION\"}','2026-10-21T00:00:00.000Z')");
    await c.query("SAVEPOINT immutable");
    await expect(c.query("UPDATE evidence SET summary_json='{}'")).rejects.toThrow(/append-only/);
    await c.query("ROLLBACK TO SAVEPOINT immutable");
    await c.query("SAVEPOINT money");
    await expect(c.query("INSERT INTO merchant_orders(id,organization_id,intent_id,attempt_id,paypal_order_id,capture_id,sku,currency,amount_minor,status,created_by_path,created_at) VALUES('MO1','org_reference','CI1','PA1','SYNTHETIC_ORDER','SYNTHETIC_CAPTURE','SKU','USD',999,'placed','capture_return','2026-10-21T00:00:00.000Z')")).rejects.toThrow(/must match/);
    await c.query("ROLLBACK TO SAVEPOINT money");
  });
});

it("runs migrations concurrently and replays them without re-seeding", async () => {
  await Promise.all([migratePostgres(pool, schema), migratePostgres(pool, schema)]);
  expect((await pool.query(`SELECT count(*)::integer AS n FROM ${schema}.payment_attempts`)).rows[0].n).toBe(1);
  const triggers = await pool.query("SELECT count(*)::integer AS n FROM information_schema.triggers WHERE trigger_schema=$1", [schema]);
  // Original/PG guards, scenario maps, browser approval, handler and diagnostic events.
  expect(triggers.rows[0].n).toBe(85);
});
