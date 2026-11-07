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
import { buildMaintenanceApp } from "../../src/server/maintenance-app.ts";
import { buildHostedApp } from "../../src/server/hosted-app.ts";
import { loadPostgresConfig } from "../../src/config.ts";
import { PostgresRecoveryService } from "../../src/merchant/postgres-recovery.ts";
import { PostgresWebhookInbox } from "../../src/webhooks/postgres-inbox.ts";
import {rehearseLocalBackup} from "../../scripts/release-backup-local.ts";

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
  await pool.query(`INSERT INTO ${schema}.ot_auth_session(id,"expiresAt",token,"createdAt","updatedAt","userId") VALUES('legacy_session',now()+interval '1 day','synthetic-local-only',now(),now(),'legacy')`);
  await new PostgresWebhookInbox(pool,schema,"SYNTHETIC_QUALIFICATION").recordDelivery({claimedEventId:"LOCAL_RELEASE_EVENT",claimedEventType:"PAYMENT.CAPTURE.COMPLETED",bodySha256:"a".repeat(64),bodyBytes:100,correlationId:"LOCAL_RELEASE_ONLY",nowMs:Date.now()});
  for(const id of ["legacy_order_a","legacy_order_b"]) await pool.query(`INSERT INTO ${schema}.merchant_orders(id,organization_id,intent_id,attempt_id,paypal_order_id,capture_id,sku,currency,amount_minor,status,created_by_path,created_at)
    VALUES($1,'org_reference',$2,$3,'MIGRATIONORDER','MIGRATIONCAPTURE',$4,'USD',100,'placed','capture_return',$5)`,[id,f.intent.id,f.attempt.id,f.intent.sku,new Date().toISOString()]);
  const recovery=new PostgresRecoveryService(pool,schema);
  const checked=await recovery.check("org_reference",f.intent.id);
  const plan=await recovery.plan("org_reference",checked.incidentId!,"local-release-test");
  await recovery.approveQualification("org_reference",plan.id,plan.plan_sha256);
  await recovery.execute("org_reference",plan.id);
  return { schema,attempt: f.attempt.id };
}
async function existingRows(schema:string){
  const tables=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",[schema])).rows;
  const rows:Record<string,unknown>={};
  for(const {tablename} of tables) if(tablename!=="ordertruth_postgres_migrations") rows[tablename]=(await pool.query(`SELECT to_jsonb(t)::text AS row FROM ${schema}."${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
  return rows;
}
it("upgrades populated V8 atomically, expires old admission without deleting history and replays V9",async () => {
  const { schema,attempt } = await version8("2026-01-01T00:00:00.000Z");
  const before = (await pool.query(`SELECT * FROM ${schema}.scenario_runs`)).rows;
  const preserved=await existingRows(schema);
  if(process.env.ORDERTRUTH_REHEARSE_BACKUP==="true") {
    const restored=await rehearseLocalBackup(schema);
    expect(restored.rowAndSequenceAndConstraintEquality).toBe(true);
    expect(restored.corruptArchiveRejected).toBe(true);
  }
  await Promise.all([migratePostgres(pool,schema),migratePostgres(pool,schema)]);
  await migratePostgres(pool,schema);
  expect((await pool.query(`SELECT * FROM ${schema}.scenario_runs`)).rows).toEqual(before);
  const after=await existingRows(schema);
  for(const table of Object.keys(preserved)) expect(after[table],table).toEqual(preserved[table]);
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

it("holds populated V8 without migrating, refuses incompatible startup, then rolls forward under maintenance",async()=>{
  const {schema}=await version8("2026-01-01T00:00:00.000Z");
  const config=loadPostgresConfig({DATABASE_URL:env.DATABASE_URL,APP_ORIGIN:"http://127.0.0.1:3333",AUTH_SECRET:"local-release-qualification-secret-only-32bytes",
    PAYPAL_ENV:"sandbox",PAYPAL_API_BASE:"https://api-m.sandbox.paypal.com",PAYPAL_CLIENT_ID:"synthetic",PAYPAL_CLIENT_SECRET:"synthetic"});
  const before=(await pool.query(`SELECT * FROM ${schema}.evidence ORDER BY seq`)).rows;
  await expect(buildHostedApp(config,{schema,staticFiles:false,migration:"check"})).rejects.toThrow(/V9 schema required/);
  const bridge=await buildMaintenanceApp(env.DATABASE_URL!,schema);
  try{
    for(const url of ["/api/scenarios","/api/orders/OLD/capture","/api/paypal/webhook","/api/auth/sign-in/anonymous"]){
      const r=await bridge.inject({method:"POST",url,payload:{}});expect(r.statusCode).toBe(503);expect(r.headers["retry-after"]).toBe("30");
    }
    expect((await bridge.inject("/api/release/status")).json()).toEqual({maintenance:true,activeRequests:0,quiescent:true});
    expect((await pool.query(`SELECT max(version) AS v FROM ${schema}.ordertruth_postgres_migrations`)).rows[0].v).toBe(8);
    await migratePostgres(pool,schema);
  }finally{await bridge.close();}
  const closed=await buildHostedApp(config,{schema,staticFiles:false,migration:"check",maintenance:()=>true});
  try{expect((await closed.inject("/api/readiness")).statusCode).toBe(503);}finally{await closed.close();}
  const resumed=await buildHostedApp(config,{schema,staticFiles:false,migration:"check"});
  try{expect((await resumed.inject("/api/readiness")).json().ready).toBe(true);}finally{await resumed.close();}
  expect((await pool.query(`SELECT * FROM ${schema}.evidence ORDER BY seq`)).rows).toEqual(before);
  expect((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.ot_auth_user WHERE id='legacy'`)).rows[0].n).toBe(1);
});
