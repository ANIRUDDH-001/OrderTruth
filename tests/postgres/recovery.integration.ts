import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresPool } from "../../src/db/postgres.ts";
import { migratePostgres } from "../../src/db/postgres-migrate.ts";
import { PostgresCheckoutStore } from "../../src/db/postgres-checkout.ts";
import { PostgresRecoveryService } from "../../src/merchant/postgres-recovery.ts";
import Fastify from "fastify";
import { registerPostgresRecoveryApi } from "../../src/merchant/postgres-api.ts";
import { PostgresWebhookInbox } from "../../src/webhooks/postgres-inbox.ts";
import { captureEvent } from "../helpers/webhook-fixtures.ts";
import { EventSchema,summarizeEvent } from "../../src/webhooks/event.ts";

const env = parseEnv(readFileSync(new URL("../../.work/postgres/.env", import.meta.url), "utf8"));
if (env.PGHOST !== "127.0.0.1" || env.PGPORT !== "55432" || env.PGDATABASE !== "ordertruth") throw new Error("Managed local PostgreSQL only");
const pool = createPostgresPool(env.DATABASE_URL!);
const schema = `qual_${randomBytes(10).toString("hex")}`;
const checkout = new PostgresCheckoutStore(pool, schema);
const recovery = new PostgresRecoveryService(pool, schema);
const app = Fastify({ logger: false });
let base = "";
let dropNextExecutionResponse = false;
beforeAll(async () => {
  await migratePostgres(pool, schema);
  // Qualification identity only, injected into the required session adapter.
  // This test server never authenticates a real owner or judge.
  registerPostgresRecoveryApi(app, recovery, {
    resolveScope: async request => request.headers["x-qualification-actor"] === "owner"
      ? { organizationId: "org_reference", actorId: "qualification-actor" }
      : request.headers["x-qualification-actor"] === "foreign" ? { organizationId: "org_foreign", actorId: "qualification-foreign" } : null,
    approve: (scope, plan, hash) => recovery.approveQualification(scope.organizationId, plan, hash),
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (dropNextExecutionResponse && request.routeOptions.url === "/api/recovery/execute") {
      dropNextExecutionResponse = false;
      reply.raw.destroy(); // Real TCP response loss after the transaction returned.
    }
    return payload;
  });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
});
afterAll(async () => { await app.close(); await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });
async function post(path: string, body: unknown, actor = "owner") {
  return fetch(`${base}/api/recovery/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-qualification-actor": actor }, body: JSON.stringify(body) });
}

async function fixture() {
  const suffix = randomBytes(8).toString("hex");
  const { intent, attempt } = await checkout.createCheckout(`qualification-recovery-${suffix}`);
  const order = `SYNTHETIC_${suffix.toUpperCase()}`;
  const capture = `SYNTHETIC_CAPTURE_${suffix.toUpperCase()}`;
  await checkout.attachOrder(attempt.id, order);
  await checkout.recordReadback(attempt.id, { id: order, status: "COMPLETED", intent: "CAPTURE", purchase_units: [{
    custom_id: intent.id, amount: { currency_code: "USD", value: "1.00" },
    payments: { captures: [{ id: capture, status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } }] },
  }] }, "SYNTHETIC_QUALIFICATION");
  const insert = async (id: string) => {
    await pool.query(`INSERT INTO ${schema}.merchant_orders(id,organization_id,intent_id,attempt_id,paypal_order_id,capture_id,sku,currency,amount_minor,status,created_by_path,created_at)
      VALUES($1,'org_reference',$2,$3,$4,$5,$6,'USD',100,'placed','capture_return',$7)`,
    [id, intent.id, attempt.id, order, capture, intent.sku, new Date().toISOString()]);
  };
  await insert(`mo_${suffix}_1`); await insert(`mo_${suffix}_2`);
  return { intent, attempt, insert, suffix };
}
async function verifiedWebhook(f: Awaited<ReturnType<typeof fixture>>) {
  const attempt = (await pool.query(`SELECT * FROM ${schema}.payment_attempts WHERE id=$1`, [f.attempt.id])).rows[0];
  const inbox = new PostgresWebhookInbox(pool,schema,"SYNTHETIC_QUALIFICATION");
  const summary = summarizeEvent(EventSchema.parse(captureEvent({ orderId: attempt.paypal_order_id,captureId: attempt.capture_id,customId: f.intent.id })));
  const seq = await inbox.recordDelivery({ claimedEventId: summary.id,claimedEventType: summary.event_type,bodySha256: "b".repeat(64),bodyBytes: 100,correlationId: "synthetic-proof",nowMs: Date.now() });
  await inbox.acceptVerified(seq,summary,{ ms: 1,debugId: "synthetic" },"synthetic-proof");
  // Other tests in this file do not create webhook events; this is the only due one.
  const leased = await inbox.claimNext(Date.now(),1000); expect(leased?.event_id).toBe(summary.id);
  await inbox.finishEvent(summary.id,leased!.process_attempts,"processed",{ outcome: "synthetic agreeing readback",attemptId: f.attempt.id });
  return { summary,seq };
}
it("preserves the complete verified webhook proof during merchant-only repair", async () => {
  const f = await fixture(); await verifiedWebhook(f);
  const incident = await recovery.check("org_reference",f.intent.id);
  const plan = await recovery.plan("org_reference",incident.incidentId!,"qualification-actor");
  await recovery.approveQualification("org_reference",plan.id,plan.plan_sha256);
  const receipt = await recovery.execute("org_reference",plan.id);
  expect(receipt.outcome).toBe("SUCCEEDED");
  expect(receipt.provider_before_sha256).toBe(receipt.provider_after_sha256);
  expect((await recovery.verify("org_reference",plan.id)).verifiedCurrent).toBe(true);
});
it("refuses a contradictory webhook evidence link instead of repairing through uncertainty", async () => {
  const f = await fixture(); const event = await verifiedWebhook(f);
  await pool.query(`ALTER TABLE ${schema}.evidence DISABLE TRIGGER evidence_no_update`);
  try { await pool.query(`UPDATE ${schema}.evidence SET summary_json=jsonb_set(summary_json::jsonb,'{delivery_seq}','-1'::jsonb)::text WHERE evidence_class='PAYPAL_VERIFIED_WEBHOOK' AND summary_json::jsonb->'event'->>'id'=$1`, [event.summary.id]); }
  finally { await pool.query(`ALTER TABLE ${schema}.evidence ENABLE TRIGGER evidence_no_update`); }
  await expect(recovery.check("org_reference",f.intent.id)).rejects.toThrow(/provenance invalid/i);
  expect((await pool.query(`SELECT count(*)::integer AS n FROM ${schema}.merchant_order_voids v JOIN ${schema}.merchant_orders m ON m.id=v.order_id WHERE m.intent_id=$1`, [f.intent.id])).rows[0].n).toBe(0);
});
it("detects a real persisted duplicate and corrects it once with immutable provider evidence", async () => {
  const f = await fixture();
  const incident = await recovery.check("org_reference", f.intent.id);
  expect(incident.result).toBe("VIOLATED"); expect(incident.incidentId).toBeTruthy();
  const plan = await recovery.plan("org_reference", incident.incidentId!, "qualification-actor");
  await recovery.approveQualification("org_reference", plan.id, plan.plan_sha256);
  const outcomes = await Promise.all(Array.from({ length: 6 }, () => recovery.execute("org_reference", plan.id)));
  expect(outcomes[0]!.outcome).toBe("SUCCEEDED");
  expect(outcomes.every(o => JSON.stringify(o) === JSON.stringify(outcomes[0]))).toBe(true);
  expect(outcomes[0]!.provider_after_sha256).toBe(outcomes[0]!.provider_before_sha256);
  const count = await pool.query(`SELECT count(*)::integer AS n FROM ${schema}.merchant_orders m LEFT JOIN ${schema}.merchant_order_voids v ON v.order_id=m.id WHERE m.intent_id=$1 AND v.order_id IS NULL`, [f.intent.id]);
  expect(count.rows[0].n).toBe(1);
});
it("denies missing identity and foreign scope through the actual HTTP API", async () => {
  const f = await fixture();
  expect((await post("check", { intentId: f.intent.id }, "")).status).toBe(401);
  expect((await post("check", { intentId: f.intent.id }, "foreign")).status).toBe(404);
  expect((await post("check", { intentId: f.intent.id, organizationId: "org_reference" })).status).toBe(400);
});
it("completes plan, exact approval, correction and independently checked receipt over HTTP", async () => {
  const f = await fixture();
  const checked = await post("check", { intentId: f.intent.id }); expect(checked.status).toBe(200);
  const { incidentId } = await checked.json();
  const planned = await post("plan", { incidentId }); expect(planned.status).toBe(200);
  const plan = await planned.json();
  expect((await post("approve", { planId: plan.id, planSha256: "0".repeat(64) })).status).toBe(409);
  expect((await post("approve", { planId: plan.id, planSha256: plan.plan_sha256 })).status).toBe(200);
  const executed = await post("execute", { planId: plan.id }); expect(executed.status).toBe(200);
  expect((await executed.json()).outcome).toBe("SUCCEEDED");
  const verified = await fetch(`${base}/api/recovery/receipts/${plan.id}`, { headers: { "x-qualification-actor": "owner" } });
  const receipt = await verified.json();
  expect(receipt.verifiedCurrent).toBe(true);
  expect(receipt.current).toEqual({ activeOrders: 1, matchingKeeper: 1, providerUnchanged: true });
});
it("prevents competing approved plans from correcting the same incident twice", async () => {
  const f = await fixture(); const incident = await recovery.check("org_reference", f.intent.id);
  const first = await recovery.plan("org_reference", incident.incidentId!, "qualification-actor");
  const second = await recovery.plan("org_reference", incident.incidentId!, "qualification-actor");
  await recovery.approveQualification("org_reference", first.id, first.plan_sha256);
  await recovery.approveQualification("org_reference", second.id, second.plan_sha256);
  const outcomes = await Promise.all([recovery.execute("org_reference", first.id), recovery.execute("org_reference", second.id)]);
  expect(outcomes.map(o => o.outcome).sort()).toEqual(["REJECTED_STALE", "SUCCEEDED"]);
  expect((await pool.query(`SELECT count(*)::integer AS n FROM ${schema}.merchant_order_voids v JOIN ${schema}.merchant_orders m ON m.id=v.order_id WHERE m.intent_id=$1`, [f.intent.id])).rows[0].n).toBe(1);
});
it("refuses changed merchant facts after approval without partial correction", async () => {
  const f = await fixture(); const incident = await recovery.check("org_reference", f.intent.id);
  const plan = await recovery.plan("org_reference", incident.incidentId!, "qualification-actor");
  await recovery.approveQualification("org_reference", plan.id, plan.plan_sha256);
  await f.insert(`mo_${f.suffix}_late`);
  expect((await recovery.execute("org_reference", plan.id)).outcome).toBe("REJECTED_STALE");
  expect((await pool.query(`SELECT count(*)::integer AS n FROM ${schema}.merchant_order_voids v JOIN ${schema}.merchant_orders m ON m.id=v.order_id WHERE m.intent_id=$1`, [f.intent.id])).rows[0].n).toBe(0);
});
it("durably refuses corrupted plans before trusting their incident references", async () => {
  const f = await fixture(); const incident = await recovery.check("org_reference", f.intent.id);
  const other = await fixture(); const otherIncident = await recovery.check("org_reference", other.intent.id);
  const plan = await recovery.plan("org_reference", incident.incidentId!, "qualification-actor");
  // Simulate storage corruption only inside this disposable qualification schema.
  await pool.query(`ALTER TABLE ${schema}.repair_plans DISABLE TRIGGER repair_plans_no_update`);
  try { await pool.query(`UPDATE ${schema}.repair_plans SET incident_id=$2 WHERE id=$1`, [plan.id, otherIncident.incidentId]); }
  finally { await pool.query(`ALTER TABLE ${schema}.repair_plans ENABLE TRIGGER repair_plans_no_update`); }
  const outcomes = await Promise.all(Array.from({ length: 3 }, () => recovery.execute("org_reference", plan.id)));
  expect(outcomes[0]!.outcome).toBe("REJECTED_INTEGRITY");
  expect(outcomes.every(o => JSON.stringify(o) === JSON.stringify(outcomes[0]))).toBe(true);
  expect(await recovery.outcome("org_reference", plan.id)).toEqual(outcomes[0]);
  expect(outcomes[0]!.provider_before_sha256).toBe(outcomes[0]!.provider_after_sha256);
  expect((await pool.query(`SELECT count(*)::integer AS n FROM ${schema}.merchant_order_voids v JOIN ${schema}.merchant_orders m ON m.id=v.order_id WHERE m.intent_id=ANY($1)`, [[f.intent.id, other.intent.id]])).rows[0].n).toBe(0);
});
it("rolls the entire correction back when its PostgreSQL connection is terminated before commit", async () => {
  const f = await fixture(); const incident = await recovery.check("org_reference", f.intent.id);
  const plan = await recovery.plan("org_reference", incident.incidentId!, "qualification-actor");
  await recovery.approveQualification("org_reference", plan.id, plan.plan_sha256);
  await pool.query(`CREATE FUNCTION ${schema}.qualification_terminate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_terminate_backend(pg_backend_pid()); RETURN NEW; END $$;
    CREATE TRIGGER qualification_terminate BEFORE INSERT ON ${schema}.repair_outcomes FOR EACH ROW EXECUTE FUNCTION ${schema}.qualification_terminate()`);
  try { await expect(recovery.execute("org_reference", plan.id)).rejects.toThrow(); }
  finally { await pool.query(`DROP TRIGGER qualification_terminate ON ${schema}.repair_outcomes`); }
  expect(await recovery.outcome("org_reference", plan.id)).toBeNull();
  expect((await pool.query(`SELECT count(*)::integer AS n FROM ${schema}.merchant_order_voids v JOIN ${schema}.merchant_orders m ON m.id=v.order_id WHERE m.intent_id=$1`, [f.intent.id])).rows[0].n).toBe(0);
  expect((await recovery.execute("org_reference", plan.id)).outcome).toBe("SUCCEEDED");
});
it("recovers the same committed receipt after an actual lost HTTP response", async () => {
  const f = await fixture(); const incident = await recovery.check("org_reference", f.intent.id);
  const plan = await recovery.plan("org_reference", incident.incidentId!, "qualification-actor");
  await recovery.approveQualification("org_reference", plan.id, plan.plan_sha256);
  dropNextExecutionResponse = true;
  await expect(post("execute", { planId: plan.id })).rejects.toThrow();
  const stored = await recovery.outcome("org_reference", plan.id);
  expect(stored?.outcome).toBe("SUCCEEDED");
  expect((await (await post("execute", { planId: plan.id })).json())).toEqual(stored);
});
it("opens a repairable recurrence while retaining and replaying the original receipt", async () => {
  const f = await fixture(); const incident = await recovery.check("org_reference", f.intent.id);
  const plan = await recovery.plan("org_reference", incident.incidentId!, "qualification-actor");
  await recovery.approveQualification("org_reference", plan.id, plan.plan_sha256);
  const original = await recovery.execute("org_reference", plan.id);
  await f.insert(`mo_${f.suffix}_recurrence`);
  const recurrence = await recovery.check("org_reference", f.intent.id);
  expect(recurrence.incidentId).toBeTruthy(); expect(recurrence.incidentId).not.toBe(incident.incidentId);
  const next = await recovery.plan("org_reference", recurrence.incidentId!, "qualification-actor");
  expect(next.void_order_ids_json).toContain("recurrence");
  expect(await recovery.execute("org_reference", plan.id)).toEqual(original);
  expect((await recovery.verify("org_reference", plan.id)).verifiedCurrent).toBe(false);
});
it("serializes a late merchant insert behind repair and detects its new incident episode", async () => {
  const f = await fixture(); const incident = await recovery.check("org_reference", f.intent.id);
  const plan = await recovery.plan("org_reference", incident.incidentId!, "qualification-actor");
  await recovery.approveQualification("org_reference", plan.id, plan.plan_sha256);
  // Local, isolated qualification trigger; there is no runtime fault endpoint.
  await pool.query(`CREATE FUNCTION ${schema}.qualification_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$;
    CREATE TRIGGER qualification_pause AFTER INSERT ON ${schema}.merchant_order_voids FOR EACH ROW EXECUTE FUNCTION ${schema}.qualification_pause()`);
  const execution = recovery.execute("org_reference", plan.id);
  execution.catch(() => {});
  let late: Promise<void> | undefined;
  try {
    let observed = false;
    for (let i = 0; i < 100; i++) {
      const rows = await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE 'INSERT INTO merchant_order_voids%' LIMIT 1");
      if (rows.rowCount) { observed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(observed).toBe(true);
    late = f.insert(`mo_${f.suffix}_racing`);
    const original = await execution; await late;
    expect(original.outcome).toBe("SUCCEEDED");
    const recurrence = await recovery.check("org_reference", f.intent.id);
    expect(recurrence.incidentId).toBeTruthy(); expect(recurrence.incidentId).not.toBe(incident.incidentId);
    expect(await recovery.outcome("org_reference", plan.id)).toEqual(original);
    const current = await recovery.verify("org_reference", plan.id);
    expect(current.current.activeOrders).toBe(2); expect(current.verifiedCurrent).toBe(false);
  } finally {
    await Promise.allSettled([execution, late]);
    await pool.query(`DROP TRIGGER qualification_pause ON ${schema}.merchant_order_voids`);
  }
});
