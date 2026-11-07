import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { env } from "./local-db.ts";
import { createPostgresPool, withTransaction } from "../../src/db/postgres.ts";
import { migratePostgres } from "../../src/db/postgres-migrate.ts";
import { POSTGRES_SCHEMA_V1 } from "../../src/db/postgres-schema.ts";
import { POSTGRES_SCHEMA_V2 } from "../../src/db/postgres-guards.ts";
import { POSTGRES_AUTH_V3 } from "../../src/db/postgres-auth-schema.ts";
import { POSTGRES_SCENARIOS_V4 } from "../../src/db/postgres-scenario-schema.ts";
import { POSTGRES_BROWSER_APPROVAL_V5 } from "../../src/db/postgres-browser-approval.ts";
import { POSTGRES_INVESTIGATION_V6 } from "../../src/db/postgres-investigation-schema.ts";
import { POSTGRES_INVESTIGATION_HISTORY_V7 } from "../../src/db/postgres-investigation-history.ts";
import { POSTGRES_DEMO_LIMITS_V8 } from "../../src/db/postgres-demo-limits.ts";
import { PostgresCheckoutStore } from "../../src/db/postgres-checkout.ts";
import { PostgresScenarioStore } from "../../src/merchant/postgres-scenarios.ts";

const pool = createPostgresPool(env.DATABASE_URL!);
const owned: string[] = [];
afterAll(async () => {
  for (const schema of owned) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
});
async function version8(createdAt: string) {
  const schema = `qual_${randomBytes(10).toString("hex")}`; owned.push(schema);
  await withTransaction(pool,async c => {
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.query("SELECT set_config('search_path',$1,true)",[`${schema},pg_catalog`]);
    await c.query("CREATE TABLE ordertruth_postgres_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
    const steps = [POSTGRES_SCHEMA_V1,POSTGRES_SCHEMA_V2,POSTGRES_AUTH_V3,POSTGRES_SCENARIOS_V4,POSTGRES_BROWSER_APPROVAL_V5,
      POSTGRES_INVESTIGATION_V6,POSTGRES_INVESTIGATION_HISTORY_V7,POSTGRES_DEMO_LIMITS_V8];
    for (const [i,sql] of steps.entries()) { await c.query(sql); await c.query("INSERT INTO ordertruth_postgres_migrations(version) VALUES($1)",[i+1]); }
  });
  await pool.query(`INSERT INTO ${schema}.ot_auth_user(id,name,email,"emailVerified","isAnonymous") VALUES('legacy','Synthetic legacy','legacy@example.invalid',false,true)`);
  const checkout = new PostgresCheckoutStore(pool,schema);
  const f = await checkout.createCheckout(`qualification-migration-${randomUUID()}`);
  await checkout.attachOrder(f.attempt.id,"MIGRATIONORDER");
  await checkout.recordReadback(f.attempt.id,{ id: "MIGRATIONORDER",intent: "CAPTURE",status: "COMPLETED",purchase_units: [{ custom_id: f.intent.id,
    amount: { currency_code: "USD",value: "1.00" },payments: { captures: [{ id: "MIGRATIONCAPTURE",status: "COMPLETED",amount: { currency_code: "USD",value: "1.00" } }] },
  }] },"SYNTHETIC_QUALIFICATION");
  const evidence = (await pool.query(`SELECT seq FROM ${schema}.evidence WHERE attempt_id=$1 AND evidence_class='PAYPAL_API_READBACK'`,[f.attempt.id])).rows[0].seq;
  await pool.query(`INSERT INTO ${schema}.scenario_runs VALUES('legacy_run','legacy',$1,$2,'SYNTHETIC_QUALIFICATION','CONTROLLED_MERCHANT_SCENARIO',$3)`,[f.attempt.id,evidence,createdAt]);
  return { schema,attempt: f.attempt.id };
}
it("upgrades populated V8 atomically, expires old admission without deleting history and replays V9",async () => {
  const { schema,attempt } = await version8("2026-01-01T00:00:00.000Z");
  const before = (await pool.query(`SELECT * FROM ${schema}.scenario_runs`)).rows;
  await Promise.all([migratePostgres(pool,schema),migratePostgres(pool,schema)]);
  await migratePostgres(pool,schema);
  expect((await pool.query(`SELECT * FROM ${schema}.scenario_runs`)).rows).toEqual(before);
  expect((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.scenario_admissions WHERE expires_at>clock_timestamp()`)).rows[0].n).toBe(0);
  const store = new PostgresScenarioStore(pool,schema);
  expect((await store.get("legacy","legacy_run")).run.id).toBe("legacy_run");
  const run = await store.createQualification("legacy",attempt,randomUUID());
  expect(run.id).not.toBe("legacy_run");
  await expect(pool.query(`INSERT INTO ${schema}.scenario_operations VALUES('legacy',$1,'legacy_run')`,["invalid"])).rejects.toThrow(/check constraint/);
});
it("rolls all V9 DDL and journal changes back if a legacy timestamp cannot be migrated",async () => {
  const { schema } = await version8("invalid_legacy_time");
  await expect(migratePostgres(pool,schema)).rejects.toThrow(/timestamp/);
  expect((await pool.query(`SELECT max(version) AS v FROM ${schema}.ordertruth_postgres_migrations`)).rows[0].v).toBe(8);
  expect((await pool.query("SELECT to_regclass($1) AS table_name",[`${schema}.scenario_operations`])).rows[0].table_name).toBeNull();
  expect((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.scenario_runs`)).rows[0].n).toBe(1);
});
