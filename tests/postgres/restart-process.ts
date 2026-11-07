import { randomBytes,randomUUID } from "node:crypto";
import { readFileSync,writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { env } from "./local-db.ts";
import { createPostgresPool } from "../../src/db/postgres.ts";
import { migratePostgres } from "../../src/db/postgres-migrate.ts";
import { PostgresCheckoutStore } from "../../src/db/postgres-checkout.ts";
import { PostgresScenarioStore } from "../../src/merchant/postgres-scenarios.ts";
import { PostgresRecoveryService } from "../../src/merchant/postgres-recovery.ts";
const pool = createPostgresPool(env.DATABASE_URL!);
try {
  if (process.argv[2] === "prepare") {
    const schema = `qual_${randomBytes(10).toString("hex")}`;
    await migratePostgres(pool,schema);
    await pool.query(`INSERT INTO ${schema}.ot_auth_user(id,name,email,"emailVerified","isAnonymous") VALUES('restart','Synthetic','restart@example.invalid',false,true)`);
    const checkout = new PostgresCheckoutStore(pool,schema);
    const f = await checkout.createCheckout(`qualification-restart-${randomUUID()}`);
    await checkout.attachOrder(f.attempt.id,"RESTARTORDER");
    await checkout.recordReadback(f.attempt.id,{ id: "RESTARTORDER",status: "COMPLETED",intent: "CAPTURE",purchase_units: [{ custom_id: f.intent.id,amount: { currency_code: "USD",value: "1.00" },payments: { captures: [{ id: "RESTARTCAPTURE",status: "COMPLETED",amount: { currency_code: "USD",value: "1.00" } }] } }] },"SYNTHETIC_QUALIFICATION");
    const store = new PostgresScenarioStore(pool,schema); const operationId = randomUUID();
    const run = await store.createQualification("restart",f.attempt.id,operationId);
    await store.injectDuplicate("restart",run.id);
    const service = new PostgresRecoveryService(pool,schema,{ runId: run.id,userId: "restart" });
    const checked = await service.check("org_reference",f.intent.id);
    const plan = await service.plan("org_reference",checked.incidentId!,"restart");
    await service.approveSession("org_reference",plan.id,plan.plan_sha256);
    const receipt = await service.execute("org_reference",plan.id); assert.equal(receipt.outcome,"SUCCEEDED");
    writeFileSync(".work/restart-proof.json",JSON.stringify({ schema,operationId,runId: run.id,planId: plan.id,receipt }));
    console.log("PREPARED: synthetic operation and successful merchant-only receipt persisted; client process exits");
  } else {
    const f = JSON.parse(readFileSync(".work/restart-proof.json","utf8"));
    if (!/^qual_[a-f0-9]{20}$/.test(f.schema)) throw new Error("Unsafe disposable schema");
    await migratePostgres(pool,f.schema);
    assert.equal((await new PostgresScenarioStore(pool,f.schema).lookupOperation("restart",f.operationId))?.run.id,f.runId);
    const verified = await new PostgresRecoveryService(pool,f.schema,{ runId: f.runId,userId: "restart" }).verify("org_reference",f.planId);
    assert.deepEqual(verified.receipt,f.receipt); assert.equal(verified.verifiedCurrent,true);
    console.log("VERIFIED: after PostgreSQL stop/start and a fresh Node process, operation resolves same run and same receipt verifies current");
    await pool.query(`DROP SCHEMA ${f.schema} CASCADE`);
    console.log("CLEANED: owned disposable restart-proof schema only");
  }
} finally { await pool.end(); }
