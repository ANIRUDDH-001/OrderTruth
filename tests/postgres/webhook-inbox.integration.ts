import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresPool } from "../../src/db/postgres.ts";
import { migratePostgres } from "../../src/db/postgres-migrate.ts";
import { PostgresWebhookInbox } from "../../src/webhooks/postgres-inbox.ts";
import { EventSchema, summarizeEvent } from "../../src/webhooks/event.ts";
import { captureEvent } from "../helpers/webhook-fixtures.ts";

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
