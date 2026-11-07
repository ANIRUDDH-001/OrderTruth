import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { env } from "./local-db.ts";
import { createPostgresPool } from "../../src/db/postgres.ts";
import { migratePostgres } from "../../src/db/postgres-migrate.ts";
import { PostgresCheckoutStore } from "../../src/db/postgres-checkout.ts";
import { PostgresScenarioStore } from "../../src/merchant/postgres-scenarios.ts";
import { PostgresRecoveryService } from "../../src/merchant/postgres-recovery.ts";
import { createSessionAuth } from "../../src/server/auth.ts";
import { registerSessionApi } from "../../src/server/session-api.ts";
import { registerJudgeApi } from "../../src/server/judge-api.ts";

const pool = createPostgresPool(env.DATABASE_URL!);
const schema = `qual_${randomBytes(10).toString("hex")}`;
const store = new PostgresScenarioStore(pool, schema);
let attemptId: string;
let intentId: string;
beforeAll(async () => {
  await migratePostgres(pool, schema);
  for (const id of ["judge_a", "judge_b"]) await pool.query(`INSERT INTO ${schema}.ot_auth_user(id,name,email,"emailVerified","isAnonymous") VALUES($1,'Qualification',$2,false,true)`, [id, `${id}@example.invalid`]);
  const checkout = new PostgresCheckoutStore(pool, schema);
  const { intent, attempt } = await checkout.createCheckout(`qualification-${randomUUID()}`);
  attemptId = attempt.id; intentId = intent.id;
  await checkout.attachOrder(attempt.id, "QUALIFICATIONORDER");
  await checkout.recordReadback(attempt.id, { id: "QUALIFICATIONORDER", status: "COMPLETED", intent: "CAPTURE", purchase_units: [{ custom_id: intent.id,
    amount: { currency_code: "USD", value: "1.00" }, payments: { captures: [{ id: "QUALIFICATIONCAPTURE", status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } }] } }] }, "SYNTHETIC_QUALIFICATION");
});
afterAll(async () => { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });

it("serializes concurrent same-operation retries to one run, order and allocation", async () => {
  const key = randomUUID();
  const runs = await Promise.all(Array.from({ length: 5 }, () => store.createQualification("judge_a", attemptId, key)));
  expect(new Set(runs.map(r => r.id)).size).toBe(1);
  const run = runs[0]!;
  expect((await store.get("judge_a", run.id)).orders).toHaveLength(1);
  expect((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.scenario_admissions WHERE run_id=$1`, [run.id])).rows[0].n).toBe(1);
  // Retry must succeed before reading a now-missing/different source.
  expect((await store.createQualification("judge_a", "missing_source", key)).id).toBe(run.id);
  const restart = new PostgresScenarioStore(pool, schema);
  expect((await restart.lookupOperation("judge_a", key))?.run.id).toBe(run.id);
  expect(await restart.lookupOperation("judge_b", key)).toBeNull();
  const foreign = await restart.createQualification("judge_b", attemptId, key);
  expect(foreign.id).not.toBe(run.id);
  await expect(store.get("judge_b", run.id)).rejects.toThrow(/not found/);
  await expect(store.createQualification("judge_a", attemptId, "invalid")).rejects.toThrow(/operation/i);
});
it("keeps a read-only missing lookup unknown while an admitted creation is still in flight", async () => {
  const key = randomUUID(); const blocker = await pool.connect();
  let pending: ReturnType<PostgresScenarioStore["createQualification"]> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(`SELECT id FROM ${schema}.payment_attempts WHERE id=$1 FOR UPDATE`,[attemptId]);
    pending = store.createQualification("judge_a",attemptId,key);
    const lock = JSON.stringify([schema,"scenario-operation","judge_a",key]);
    let acquired = false;
    for (let n=0;n<100;n++) {
      const result = await pool.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS free",[lock]);
      if (!result.rows[0].free) { acquired = true; break; }
      await new Promise(resolve => setTimeout(resolve,10));
    }
    expect(acquired).toBe(true);
    expect(await store.lookupOperation("judge_a",key)).toBeNull();
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  const committed = await pending!;
  expect((await store.lookupOperation("judge_a",key))?.run.id).toBe(committed.id);
});

it("recovers admission after lease expiry while preserving history and operation identities", async () => {
  // Existing allocations are isolated using a separate freshly created schema in the final-slot test below.
  const isolated = `qual_${randomBytes(10).toString("hex")}`;
  await migratePostgres(pool, isolated);
  try {
    // Copy only synthetic fixtures through the normal qualification setup into a fresh store.
    await pool.query(`INSERT INTO ${isolated}.ot_auth_user SELECT * FROM ${schema}.ot_auth_user WHERE id='judge_a'`);
    const checkout = new PostgresCheckoutStore(pool, isolated);
    const f = await checkout.createCheckout(`qualification-capacity-${randomUUID()}`);
    await checkout.attachOrder(f.attempt.id, "CAPACITYORDER");
    await checkout.recordReadback(f.attempt.id, { id: "CAPACITYORDER", status: "COMPLETED", intent: "CAPTURE", purchase_units: [{ custom_id: f.intent.id,
      amount: { currency_code: "USD", value: "1.00" }, payments: { captures: [{ id: "CAPACITYCAPTURE", status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } }] } }] }, "SYNTHETIC_QUALIFICATION");
    const bounded = new PostgresScenarioStore(pool, isolated, { global: 2, perUser: 2, leaseMs: 1000 });
    const key = randomUUID(); const first = await bounded.createQualification("judge_a", f.attempt.id, key);
    const final = await Promise.allSettled([bounded.createQualification("judge_a", f.attempt.id, randomUUID()), bounded.createQualification("judge_a", f.attempt.id, randomUUID())]);
    expect(final.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(final.filter(r => r.status === "rejected")).toHaveLength(1);
    await expect(bounded.createQualification("judge_a", f.attempt.id, randomUUID())).rejects.toThrow(/admission limit/);
    expect((await bounded.createQualification("judge_a", "missing", key)).id).toBe(first.id);
    // Real wall clock expiry; never disable immutability to fake capacity release.
    await new Promise(resolve => setTimeout(resolve, 1100));
    await bounded.createQualification("judge_a", f.attempt.id, randomUUID());
    expect((await bounded.get("judge_a", first.id)).orders).toHaveLength(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${isolated}.scenario_runs`)).rows[0].n).toBe(3);
    await expect(pool.query(`DELETE FROM ${isolated}.scenario_runs WHERE id=$1`, [first.id])).rejects.toThrow(/append-only/);
    await expect(pool.query(`UPDATE ${isolated}.scenario_operations SET operation_id=$2 WHERE run_id=$1`, [first.id, randomUUID()])).rejects.toThrow(/append-only/);
  } finally { await pool.query(`DROP SCHEMA ${isolated} CASCADE`); }
});

it("persists explicit check progress and reopens the same concurrently executed receipt on a new pool", async () => {
  const run = await store.createQualification("judge_a", attemptId, randomUUID());
  expect((await store.get("judge_a", run.id)).latestCheck).toBeNull();
  await store.injectDuplicate("judge_a", run.id);
  const service = new PostgresRecoveryService(pool, schema, { runId: run.id, userId: "judge_a" });
  const checked = await service.check("org_reference", intentId);
  expect((await store.get("judge_a", run.id)).latestCheck).toMatchObject({ result: "VIOLATED", activeOrderCount: 2, incidentId: checked.incidentId });
  const plan = await service.plan("org_reference", checked.incidentId!, "judge_a");
  await service.approveSession("org_reference", plan.id, plan.plan_sha256);
  const outcomes = await Promise.all([service.execute("org_reference", plan.id), service.execute("org_reference", plan.id)]);
  expect(outcomes[0]).toEqual(outcomes[1]); expect(outcomes[0]!.outcome).toBe("SUCCEEDED");
  expect(outcomes[0]!.provider_before_sha256).toBe(outcomes[0]!.provider_after_sha256);
  const reopened = createPostgresPool(env.DATABASE_URL!);
  try {
    const verification = await new PostgresRecoveryService(reopened, schema, { runId: run.id, userId: "judge_a" }).verify("org_reference", plan.id);
    expect(verification.receipt).toEqual(outcomes[0]); expect(verification.verifiedCurrent).toBe(true);
  } finally { await reopened.end(); }
});

it("reconciles creation after a real lost HTTP response and reports unknown instead of false noncommit", async () => {
  const origin = "http://127.0.0.1:3333";
  const authPool = createPostgresPool(env.DATABASE_URL!); authPool.options.options += ` -c search_path=${schema},pg_catalog`;
  const secret = randomBytes(32).toString("hex");
  let drop = true;
  let authFailure: { name: string; code: unknown } | null = null;
  const build = () => {
    const app = Fastify({ logger: false });
    const auth = createSessionAuth(authPool, origin, secret);
    const handler = auth.handler;
    auth.handler = async req => {
      try { return await handler(req); }
      catch (error) { authFailure = { name: error instanceof Error ? error.name : "unknown",code: (error as { code?: string }).code ?? null }; throw error; }
    };
    registerSessionApi(app, auth, origin);
    registerJudgeApi(app, { pool, schema, auth, origin, sourceAttemptId: attemptId });
    app.addHook("onSend", async (req, reply, payload) => {
      if (drop && req.method === "POST" && req.url === "/api/scenarios" && reply.statusCode === 200) { drop = false; reply.raw.destroy(); }
      return payload;
    });
    return app;
  };
  // Test-only adapter preserves SYNTHETIC_QUALIFICATION; never relabel fixture evidence as PayPal.
  const adapter = vi.spyOn(PostgresScenarioStore.prototype, "create").mockImplementation(function(this: PostgresScenarioStore, user, attempt, key) {
    return this.createQualification(user, attempt, key);
  });
  let app: FastifyInstance = build();
  try {
    let base = await app.listen({ host: "127.0.0.1", port: 0 });
    const signed = await app.inject({ method: "POST", url: "/api/auth/sign-in/anonymous", headers: { origin }, payload: {} });
    expect({ status: signed.statusCode,authFailure }).toEqual({ status: 200,authFailure: null });
    expect(signed.cookies.length).toBeGreaterThan(0);
    const cookie = signed.cookies.map(c => `${c.name}=${c.value}`).join("; ");
    const key = randomUUID();
    expect((await app.inject({ url: `/api/scenario-operations/${key}`, headers: { cookie } })).json()).toMatchObject({ outcome: "UNKNOWN", scenario: null });
    await expect(fetch(`${base}/api/scenarios`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ operationId: key }) })).rejects.toThrow();
    const committed = (await app.inject({ url: `/api/scenario-operations/${key}`, headers: { cookie } })).json();
    expect(committed.outcome).toBe("COMMITTED");
    await app.close(); app = build(); base = await app.listen({ host: "127.0.0.1", port: 0 });
    const retry = await fetch(`${base}/api/scenarios`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ operationId: key }) });
    expect(retry.status).toBe(200); expect((await retry.json()).run.id).toBe(committed.scenario.run.id);
    expect((await app.inject({ method: "POST", url: "/api/scenarios", headers: { origin, cookie }, payload: {} })).statusCode).toBe(400);
    const malformed = await app.inject({ method: "POST",url: "/api/scenarios",headers: { origin,cookie,"content-type": "application/json" },payload: "{" });
    expect(malformed.statusCode).toBe(400); expect(malformed.json().outcome).toBe("REJECTED");
    expect((await app.inject({ url: "/api/scenario-operations/invalid", headers: { cookie } })).statusCode).toBe(400);
    const secondKey = randomUUID();
    const read = vi.spyOn(PostgresScenarioStore.prototype,"get").mockRejectedValueOnce(new Error("Synthetic post-commit read failure"));
    const failedRead = await app.inject({ method: "POST",url: "/api/scenarios",headers: { origin,cookie },payload: { operationId: secondKey } });
    read.mockRestore();
    expect(failedRead.statusCode).toBe(503); expect(failedRead.json()).toMatchObject({ outcome: "UNKNOWN",code: "CREATION_OUTCOME_UNKNOWN" });
    const recovered = (await app.inject({ url: `/api/scenario-operations/${secondKey}`,headers: { cookie } })).json();
    expect(recovered.outcome).toBe("COMMITTED");
    expect(recovered.scenario.run.id).not.toBe(committed.scenario.run.id);
  } finally { adapter.mockRestore(); await app.close(); await authPool.end(); }
});
