import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
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

const env = parseEnv(readFileSync(new URL("../../.work/postgres/.env", import.meta.url), "utf8"));
if (env.PGHOST !== "127.0.0.1" || env.PGPORT !== "55432" || env.PGDATABASE !== "ordertruth") throw new Error("Managed local PostgreSQL only");
const pool = createPostgresPool(env.DATABASE_URL!);
const schema = `qual_${randomBytes(10).toString("hex")}`;
const inbox = new PostgresWebhookInbox(pool, schema, "SYNTHETIC_QUALIFICATION");
beforeAll(() => migratePostgres(pool, schema));
afterAll(async () => { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });
const summary = () => summarizeEvent(EventSchema.parse(captureEvent({ orderId: "SYNTHETICORDER1", captureId: "SYNTHETICCAPTURE1" })));
const delivery = (id: string) => inbox.recordDelivery({ claimedEventId: id, claimedEventType: "PAYMENT.CAPTURE.COMPLETED", bodySha256: "a".repeat(64), bodyBytes: 100, correlationId: "synthetic-webhook", nowMs: Date.now() });
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
    expect((await inbox.getDelivery(result.body.delivery!))?.state).toBe("retryable_failure");
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
