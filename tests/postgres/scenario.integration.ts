import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it,vi } from "vitest";
import { createPostgresPool } from "../../src/db/postgres.ts";
import { migratePostgres } from "../../src/db/postgres-migrate.ts";
import { PostgresCheckoutStore } from "../../src/db/postgres-checkout.ts";
import { PostgresScenarioStore } from "../../src/merchant/postgres-scenarios.ts";
import { PostgresRecoveryService } from "../../src/merchant/postgres-recovery.ts";
import { PostgresInvestigationStore } from "../../src/ai/postgres-investigation.ts";
import { PostgresInvestigationService } from "../../src/ai/postgres-investigation-service.ts";
import { prepareEvidenceEgress } from "../../src/ai/evidence-egress.ts";

import { env } from "./local-db.ts";
const pool = createPostgresPool(env.DATABASE_URL!);
const schema = `qual_${randomBytes(10).toString("hex")}`;
const scenarios = new PostgresScenarioStore(pool, schema);
const checkout = new PostgresCheckoutStore(pool, schema);
beforeAll(async () => {
  await migratePostgres(pool, schema);
  for (const id of ["synthetic_judge_a", "synthetic_judge_b"]) await pool.query(`INSERT INTO ${schema}.ot_auth_user(id,name,email,"emailVerified","isAnonymous") VALUES($1,'Synthetic judge',$2,false,true)`, [id, `${id}@example.invalid`]);
});
afterAll(async () => { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });
async function payment() {
  const suffix = randomBytes(8).toString("hex").toUpperCase();
  const { intent, attempt } = await checkout.createCheckout(`synthetic-scenario-${suffix}`);
  await checkout.attachOrder(attempt.id, `ORDER${suffix}`);
  await checkout.recordReadback(attempt.id, { id: `ORDER${suffix}`, status: "COMPLETED", intent: "CAPTURE", purchase_units: [{ custom_id: intent.id, amount: { currency_code: "USD", value: "1.00" }, payments: { captures: [{ id: `CAPTURE${suffix}`, status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } }] } }] }, "SYNTHETIC_QUALIFICATION");
  return { intent, attempt };
}
it("isolates controlled merchant runs while referencing one immutable payment observation", async () => {
  const f = await payment();
  // The production admission path must reject these synthetic observations.
  await expect(scenarios.create("synthetic_judge_a", f.attempt.id)).rejects.toThrow(/genuine/i);
  const a = await scenarios.createQualification("synthetic_judge_a", f.attempt.id);
  const b = await scenarios.createQualification("synthetic_judge_b", f.attempt.id);
  expect(a.id).not.toBe(b.id); expect(a.source_evidence_seq).toBe(b.source_evidence_seq);
  await scenarios.injectDuplicate("synthetic_judge_a", a.id);
  expect((await scenarios.get("synthetic_judge_a", a.id)).orders).toHaveLength(2);
  expect((await scenarios.get("synthetic_judge_b", b.id)).orders).toHaveLength(1);
  const investigations = new PostgresInvestigationStore(pool,schema);
  const beforeDiagnostic = await investigations.evidence("synthetic_judge_a",a.id);
  expect(beforeDiagnostic.some(e => e.source === "MERCHANT_DIAGNOSTIC")).toBe(false);
  expect(JSON.stringify(beforeDiagnostic)).not.toMatch(/CONTROLLED_DUPLICATE_WRITE|DUPLICATE_ORDER_RACE|cause_at_plan|fault_injection_id/);
  const diagnostic = await investigations.diagnostic("synthetic_judge_a",a.id,"IDEMPOTENCY_KEYS");
  expect(diagnostic.source).toBe("MERCHANT_DIAGNOSTIC");
  expect(diagnostic.facts.distinctKeys).toBe(2);
  expect((await investigations.evidence("synthetic_judge_a",a.id)).some(e => e.id === diagnostic.id)).toBe(true);
  await expect(investigations.diagnostic("synthetic_judge_b",a.id,"HANDLER_TIMING")).rejects.toThrow(/not found/i);
  let modelCalls = 0;
  const ai = new PostgresInvestigationService(pool,schema,{ model: "synthetic-model",dailyLimit: 1,userDailyLimit: 3,minIntervalMs: 0,
    infer: async evidence => {
      modelCalls++; await new Promise(resolve => setTimeout(resolve,25));
      return { ok: true,result: { summary: "Synthetic model result.",hypotheses: [{ explanation: "The merchant write identities may differ.",status: "HYPOTHESIS",confidence: "LOW",evidenceIds: evidence.slice(0,2).map(e => e.id) }],nextDiagnostic: "HANDLER_TIMING",diagnosticReason: "Compare recorded merchant handler intervals." },error: null,usage: { promptTokens: 10,outputTokens: 20,totalTokens: 30 },latencyMs: 25,httpStatus: 200 };
    } });
  const results = await Promise.all(Array.from({ length: 5 },() => ai.investigate("synthetic_judge_a",a.id)));
  expect(modelCalls).toBe(1); expect(results.filter(r => r.status === "FRESH")).toHaveLength(1);
  const cached = await ai.investigate("synthetic_judge_a",a.id);
  expect(cached.status).toBe("CACHED"); expect(cached.freshModelExecution).toBe(false);
  const originalHistory = await ai.history("synthetic_judge_a",a.id);
  expect(originalHistory?.status).toBe("CACHED");
  await expect(ai.history("synthetic_judge_b",a.id)).rejects.toThrow(/not found/i);
  await investigations.diagnostic("synthetic_judge_a",a.id,"HANDLER_TIMING");
  const exhausted = await ai.investigate("synthetic_judge_a",a.id);
  expect(exhausted.status).toBe("UNAVAILABLE"); expect(exhausted.reason).toBe("APP_DAILY_BUDGET");
  expect(exhausted.baseline.kind).toBe("RULES_BASED"); expect(modelCalls).toBe(1);
  await expect(scenarios.injectDuplicate("synthetic_judge_b", a.id)).rejects.toThrow(/not found/i);
  await expect(scenarios.get("synthetic_judge_a", b.id)).rejects.toThrow(/not found/i);
  expect((await pool.query(`SELECT count(*)::integer AS n FROM ${schema}.payment_attempts WHERE id=$1`, [f.attempt.id])).rows[0].n).toBe(1);
  const reset = await scenarios.createQualification("synthetic_judge_a", f.attempt.id);
  expect(reset.id).not.toBe(a.id); expect((await scenarios.get("synthetic_judge_a", a.id)).orders).toHaveLength(2);
  const first = new PostgresRecoveryService(pool, schema, { runId: a.id, userId: "synthetic_judge_a" });
  const second = new PostgresRecoveryService(pool, schema, { runId: b.id, userId: "synthetic_judge_b" });
  const checked = await first.check("org_reference", f.intent.id);
  expect((await second.check("org_reference", f.intent.id)).result).toBe("HOLDS");
  await expect(second.plan("org_reference", checked.incidentId!, "synthetic-judge")).rejects.toThrow(/not found/i);
  const plan = await first.plan("org_reference", checked.incidentId!, "synthetic-judge");
  await first.approveSession("org_reference", plan.id, plan.plan_sha256);
  await expect(second.execute("org_reference", plan.id)).rejects.toThrow(/not found/i);
  expect((await first.execute("org_reference", plan.id)).outcome).toBe("SUCCEEDED");
  expect((await first.verify("org_reference", plan.id)).verifiedCurrent).toBe(true);
  const history = await new PostgresInvestigationService(pool,schema,{ model: "synthetic-model",dailyLimit: 0,userDailyLimit: 0,minIntervalMs: 0,infer: async () => { throw new Error("No inference during history read"); } }).history("synthetic_judge_a",a.id);
  expect(history?.evidence).toEqual(originalHistory?.evidence);
  expect(history?.freshModelExecution).toBe(false);
  expect(modelCalls).toBe(1);
  expect((await scenarios.get("synthetic_judge_b", b.id)).orders.filter(o => o.effective_status === "placed")).toHaveLength(1);
});
it("projects real database evidence through the gateway and persists provider cooldown across service instances",async () => {
  const f = await payment(); const run = await scenarios.createQualification("synthetic_judge_a",f.attempt.id);
  await scenarios.injectDuplicate("synthetic_judge_a",run.id);
  const store = new PostgresInvestigationStore(pool,schema);
  for (const kind of ["HANDLER_TIMING","IDEMPOTENCY_KEYS","MERCHANT_WRITE_OUTCOMES"] as const) await store.diagnostic("synthetic_judge_a",run.id,kind);
  const evidence = await store.evidence("synthetic_judge_a",run.id);
  const payload = prepareEvidenceEgress(evidence).payload;
  expect(payload).not.toContain(run.id); expect(payload).not.toContain("keySha256"); expect(payload).toContain("relation");
  let calls = 0;
  const settings = { model: "synthetic-circuit",dailyLimit: 20,userDailyLimit: 10,minIntervalMs: 0,
    infer: async () => { calls++; return { ok: false,result: null,error: "QUOTA_OR_RATE_LIMIT",usage: { promptTokens: null,outputTokens: null,totalTokens: null },httpStatus: 429,latencyMs: 1 }; } };
  expect((await new PostgresInvestigationService(pool,schema,settings).investigate("synthetic_judge_a",run.id)).reason).toBe("QUOTA_OR_RATE_LIMIT");
  const blocked = await new PostgresInvestigationService(pool,schema,settings).investigate("synthetic_judge_a",run.id);
  expect(blocked.reason).toBe("PROVIDER_CIRCUIT_OPEN"); expect(calls).toBe(1);
  const count = (await pool.query(`SELECT count(*)::int AS n FROM ${schema}.ai_investigations WHERE model=$1`,[settings.model])).rows[0].n;
  expect(count).toBe(1);
  const clock = vi.spyOn(Date,"now").mockReturnValue(Date.now()+65_000);
  try { await new PostgresInvestigationService(pool,schema,settings).investigate("synthetic_judge_a",run.id); expect(calls).toBe(2); }
  finally { clock.mockRestore(); }
});
