import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresPool } from "../../src/db/postgres.ts";
import { migratePostgres } from "../../src/db/postgres-migrate.ts";
import { PostgresWebhookInbox } from "../../src/webhooks/postgres-inbox.ts";
import { EventSchema, summarizeEvent } from "../../src/webhooks/event.ts";
import { captureEvent, signedHeaders, TEST_WEBHOOK_ID } from "../helpers/webhook-fixtures.ts";
import { WebhookIntake } from "../../src/webhooks/intake.ts";
import { silentLogger } from "../fake-paypal.ts";
import { PostgresCheckoutStore } from "../../src/db/postgres-checkout.ts";
import { PostgresCheckoutService } from "../../src/postgres-checkout-service.ts";
import { WebhookProcessor } from "../../src/webhooks/processor.ts";

import { env } from "./local-db.ts";
const pool = createPostgresPool(env.DATABASE_URL!);
const schema = `qual_${randomBytes(10).toString("hex")}`;
const inbox = new PostgresWebhookInbox(pool, schema, "SYNTHETIC_QUALIFICATION");
beforeAll(() => migratePostgres(pool, schema));
afterAll(async () => { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });
const summary = () => summarizeEvent(EventSchema.parse(captureEvent({ orderId: "SYNTHETICORDER1", captureId: "SYNTHETICCAPTURE1" })));
const delivery = (id: string) => inbox.recordDelivery({ claimedEventId: id, claimedEventType: "PAYMENT.CAPTURE.COMPLETED", bodySha256: "a".repeat(64), bodyBytes: 100, correlationId: "synthetic-webhook", nowMs: Date.now() });
it("keeps authenticated intake available at rejection saturation without growing rejected or duplicate storage", async () => {
  const schema = `qual_${randomBytes(10).toString("hex")}`;
  await migratePostgres(pool,schema);
  try {
    await pool.query(`INSERT INTO ${schema}.webhook_deliveries(state,claimed_event_id,body_sha256,body_bytes,correlation_id,received_at_ms,created_at,updated_at)
      SELECT 'received_unverified',NULL,repeat('a',64),1,'synthetic-saturation',0,'2026-11-07T00:00:00.000Z','2026-11-07T00:00:00.000Z' FROM generate_series(1,5000)`);
    await pool.query(`UPDATE ${schema}.webhook_deliveries SET state='rejected',reason='synthetic invalid signature' WHERE correlation_id='synthetic-saturation'`);
    let calls = 0;
    const restarted = new PostgresWebhookInbox(pool,schema,"SYNTHETIC_QUALIFICATION");
    const intake = new WebhookIntake(restarted, { verify: async () => { calls++; return { status: "SUCCESS", durationMs: 1, debugId: "synthetic" }; } }, {
      webhookId: TEST_WEBHOOK_ID, maxTransmissionAgeMs: 300_000, maxFutureSkewMs: 30_000, log: silentLogger(),
    });
    const before = (await pool.query(`SELECT count(*)::int AS n FROM ${schema}.webhook_deliveries`)).rows[0].n;
    expect((await intake.receive(Buffer.from("{}"),{},"synthetic-bad")).status).toBe(400);
    expect(calls).toBe(0);
    const raw = JSON.stringify(captureEvent({ orderId: "SATURATIONORDER", captureId: "SATURATIONCAPTURE" }));
    const accepted = await intake.receive(Buffer.from(raw),signedHeaders(raw),"synthetic-signed");
    expect(accepted.status).toBe(200); expect(accepted.body.result).toBe("accepted");
    const proofBefore = (await pool.query(`SELECT * FROM ${schema}.evidence WHERE evidence_class='PAYPAL_VERIFIED_WEBHOOK' ORDER BY seq`)).rows;
    const duplicates = await Promise.all(Array.from({ length: 5 },() => intake.receive(Buffer.from(raw),signedHeaders(raw),"synthetic-redelivery")));
    expect(duplicates.every(r => r.status === 200 && r.body.result === "duplicate")).toBe(true);
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.webhook_deliveries`)).rows[0].n).toBe(before+1);
    expect((await pool.query(`SELECT * FROM ${schema}.evidence WHERE evidence_class='PAYPAL_VERIFIED_WEBHOOK' ORDER BY seq`)).rows).toEqual(proofBefore);
    const reject = new WebhookIntake(restarted,{ verify: async () => ({ status: "FAILURE", durationMs: 1, debugId: null }) }, {
      webhookId: TEST_WEBHOOK_ID,maxTransmissionAgeMs: 300_000,maxFutureSkewMs: 30_000,log: silentLogger(),
    });
    expect((await reject.receive(Buffer.from(raw),signedHeaders(raw),"synthetic-invalid-signature")).status).toBe(400);
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.webhook_deliveries`)).rows[0].n).toBe(before+1);
  } finally { await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
});
it("deduplicates concurrent verified deliveries atomically with one event and one evidence row", async () => {
  const s = summary(); const ids = await Promise.all(Array.from({ length: 6 }, () => delivery(s.id)));
  const results = await Promise.all(ids.map(id => inbox.acceptVerified(id, s, { ms: 1, debugId: "synthetic" }, "synthetic-webhook")));
  expect(results.filter(r => r === "accepted")).toHaveLength(1);
  expect(results.filter(r => r === "duplicate")).toHaveLength(5);
  expect((await inbox.getEvent(s.id))?.deliveries).toBe(6);
  expect((await pool.query(`SELECT count(*)::integer AS n FROM ${schema}.evidence WHERE evidence_class='PAYPAL_VERIFIED_WEBHOOK' AND summary_json::jsonb->'event'->>'id'=$1`, [s.id])).rows[0].n).toBe(1);
});
it("reclaims an expired lease after restart and refuses completion by the old worker", async () => {
  // Drain the earlier test's pending event before this independent case.
  for (;;) { const row = await inbox.claimNext(Date.now(), 1000); if (!row) break; await inbox.finishEvent(row.event_id, row.process_attempts, "ignored", { outcome: "synthetic qualification" }); }
  const s = summary(); await inbox.acceptVerified(await delivery(s.id), s, { ms: 1, debugId: null }, "synthetic-webhook");
  const now = Date.now(); const first = await inbox.claimNext(now, 100);
  expect(first?.event_id).toBe(s.id);
  expect(await inbox.claimNext(now + 50, 100)).toBeUndefined();
  const restarted = new PostgresWebhookInbox(pool, schema, "SYNTHETIC_QUALIFICATION");
  const second = await restarted.claimNext(now + 101, 100);
  expect(second?.process_attempts).toBe(first!.process_attempts + 1);
  expect(await inbox.finishEvent(s.id, first!.process_attempts, "processed", { outcome: "stale worker" })).toBe(false);
  expect(await restarted.finishEvent(s.id, second!.process_attempts, "processed", { outcome: "synthetic resumed processing" })).toBe(true);
});
it("never creates an event or verified evidence from a rejected delivery", async () => {
  const s = summary(); const id = await delivery(s.id);
  await inbox.finishUnverified(id, "rejected", "synthetic invalid signature");
  await expect(inbox.acceptVerified(id, s, { ms: 1, debugId: null }, "synthetic-webhook")).rejects.toThrow();
  expect(await inbox.getEvent(s.id)).toBeUndefined();
});
it("awaits durable acceptance before returning success and returns 503 on a failed commit", async () => {
  // Explicit verifier stub. This tests persistence, not genuine signatures.
  const intake = new WebhookIntake(inbox, { verify: async () => ({ status: "SUCCESS", durationMs: 1, debugId: null }) }, {
    webhookId: TEST_WEBHOOK_ID, maxTransmissionAgeMs: 300_000, maxFutureSkewMs: 30_000, log: silentLogger(),
  });
  const event = captureEvent({ orderId: "SYNTHETICORDER2", captureId: "SYNTHETICCAPTURE2" });
  const raw = JSON.stringify(event);
  const response = await intake.receive(Buffer.from(raw), signedHeaders(raw), "synthetic-intake");
  expect(response.status).toBe(200);
  expect((await inbox.getEvent(event.id))?.state).toBe("verified_pending");
  await pool.query(`CREATE FUNCTION ${schema}.qualification_reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic event write failure'; END $$;
    CREATE TRIGGER qualification_reject_event BEFORE INSERT ON ${schema}.webhook_events FOR EACH ROW EXECUTE FUNCTION ${schema}.qualification_reject_event()`);
  const failed = captureEvent({ orderId: "SYNTHETICORDER3", captureId: "SYNTHETICCAPTURE3" }); const failedRaw = JSON.stringify(failed);
  try {
    const result = await intake.receive(Buffer.from(failedRaw), signedHeaders(failedRaw), "synthetic-intake-failure");
    expect(result.status).toBe(503);
    expect(await inbox.getEvent(failed.id)).toBeUndefined();
    // Verification-before-persistence publishes no partial delivery/event on failure.
    expect(result.body.delivery).toBeUndefined();
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.webhook_deliveries WHERE claimed_event_id=$1`,[failed.id])).rows[0].n).toBe(0);
  } finally { await pool.query(`DROP TRIGGER qualification_reject_event ON ${schema}.webhook_events`); }
});
it("processes a verified event only after agreeing GET and preserves state on disagreement", async () => {
  for (;;) { const row = await inbox.claimNext(Date.now(), 1000); if (!row) break; await inbox.finishEvent(row.event_id, row.process_attempts, "ignored", { outcome: "synthetic qualification" }); }
  const store = new PostgresCheckoutStore(pool, schema);
  for (const agrees of [true, false]) {
    const { intent, attempt } = await store.createCheckout(`synthetic-webhook-${randomBytes(8).toString("hex")}`);
    const order = randomBytes(9).toString("hex").toUpperCase(); const capture = randomBytes(9).toString("hex").toUpperCase();
    await store.attachOrder(attempt.id, order);
    const service = new PostgresCheckoutService({
      createOrder: async () => { throw new Error("Unexpected financial operation"); },
      captureOrder: async () => { throw new Error("Webhook must never capture"); },
      getOrder: async () => ({ body: { id: order, intent: "CAPTURE", status: "COMPLETED", purchase_units: [{ custom_id: intent.id, amount: { currency_code: "USD", value: "1.00" },
        payments: { captures: [{ id: capture, status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } }] } }] }, httpStatus: 200, debugId: null, requestId: null, correlationId: "synthetic", durationMs: 1 }),
    }, store, "SYNTHETIC_QUALIFICATION");
    const s = summarizeEvent(EventSchema.parse(captureEvent({ orderId: order, captureId: capture, customId: intent.id, value: agrees ? "1.00" : "2.00" })));
    await inbox.acceptVerified(await delivery(s.id), s, { ms: 1, debugId: null }, "synthetic-processor");
    const processor = new WebhookProcessor(inbox, service, { log: silentLogger() });
    expect(await processor.drain()).toBe(1);
    expect((await inbox.getEvent(s.id))?.state).toBe(agrees ? "processed" : "disagreed");
    expect((await store.byOrder(order)).attempt.state).toBe(agrees ? "captured" : "awaiting_buyer_approval");
  }
});
