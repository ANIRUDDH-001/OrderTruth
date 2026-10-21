import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresPool } from "../../src/db/postgres.ts";
import { migratePostgres } from "../../src/db/postgres-migrate.ts";
import { PostgresCheckoutStore } from "../../src/db/postgres-checkout.ts";
import type { OrderReadback } from "../../src/domain/checkout.ts";

const env = parseEnv(readFileSync(new URL("../../.work/postgres/.env", import.meta.url), "utf8"));
if (env.PGHOST !== "127.0.0.1" || env.PGPORT !== "55432" || env.PGDATABASE !== "ordertruth") throw new Error("Managed local PostgreSQL only");
const pool = createPostgresPool(env.DATABASE_URL!);
const schema = `qual_${randomBytes(10).toString("hex")}`;
const store = new PostgresCheckoutStore(pool, schema);
beforeAll(() => migratePostgres(pool, schema));
afterAll(async () => { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });

function readback(intent: string, capture = "SYNTHETIC_CAPTURE"): OrderReadback {
  return { id: "SYNTHETIC_ORDER", status: "COMPLETED", intent: "CAPTURE", purchase_units: [{
    custom_id: intent, amount: { currency_code: "USD", value: "1.00" },
    payments: { captures: [{ id: capture, status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } }] },
  }] };
}
it("creates one checkout and stable financial request identities under concurrent retries", async () => {
  const rows = await Promise.all(Array.from({ length: 6 }, () => store.createCheckout("qualified-checkout-retry-0001")));
  expect(new Set(rows.map(r => r.intent.id)).size).toBe(1);
  expect(new Set(rows.map(r => r.attempt.create_request_id)).size).toBe(1);
  expect(new Set(rows.map(r => r.attempt.capture_request_id)).size).toBe(1);
  expect(rows[0]!.intent.amount_minor).toBe(100);
});
it("allows exactly one concurrent capture claim with an exact millisecond timestamp", async () => {
  const { intent, attempt } = await store.createCheckout("qualified-checkout-claim-0001");
  await store.attachOrder(attempt.id, "SYNTHETIC_ORDER");
  const raw = readback(intent.id); raw.status = "APPROVED"; delete raw.purchase_units![0]!.payments;
  await store.recordReadback(attempt.id, raw, "SYNTHETIC_QUALIFICATION");
  const claims = await Promise.all(Array.from({ length: 6 }, () => store.claimCapture(attempt.id, 1792572300000)));
  expect(claims.filter(Boolean)).toHaveLength(1);
  const { rows } = await pool.query(`SELECT capture_claims,capture_claimed_at_ms FROM ${schema}.payment_attempts WHERE id=$1`, [attempt.id]);
  expect(rows[0]).toMatchObject({ capture_claims: 1, capture_claimed_at_ms: 1792572300000 });
});
it("preserves accepted capture identity when a later observation contradicts it", async () => {
  const { intent, attempt } = await store.createCheckout("qualified-checkout-claim-0001");
  expect((await store.recordReadback(attempt.id, readback(intent.id), "SYNTHETIC_QUALIFICATION")).accepted).toBe(true);
  const conflict = await store.recordReadback(attempt.id, readback(intent.id, "SYNTHETIC_OTHER_CAPTURE"), "SYNTHETIC_QUALIFICATION");
  expect(conflict.accepted).toBe(false);
  expect(conflict.attempt.capture_id).toBe("SYNTHETIC_CAPTURE");
  expect(conflict.attempt.verdict_reasons).toMatch(/conflict/i);
  const { rows } = await pool.query(`SELECT summary_json FROM ${schema}.evidence WHERE attempt_id=$1 ORDER BY seq`, [attempt.id]);
  expect(rows).toHaveLength(3);
  expect(rows.every(r => JSON.parse(r.summary_json).provenance === "SYNTHETIC_QUALIFICATION")).toBe(true);
});
it("rolls back the provider observation when canonical interpretation cannot commit", async () => {
  const { intent, attempt } = await store.createCheckout("qualified-checkout-atomic-0001");
  await store.attachOrder(attempt.id, "SYNTHETIC_ORDER_ATOMIC");
  await pool.query(`CREATE FUNCTION ${schema}.qualification_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled metadata failure'; END $$;
    CREATE TRIGGER qualification_failure BEFORE UPDATE ON ${schema}.payment_attempts FOR EACH ROW EXECUTE FUNCTION ${schema}.qualification_failure()`);
  try {
    const raw = readback(intent.id); raw.id = "SYNTHETIC_ORDER_ATOMIC";
    await expect(store.recordReadback(attempt.id, raw, "SYNTHETIC_QUALIFICATION")).rejects.toThrow("controlled metadata failure");
    expect((await pool.query(`SELECT count(*)::integer AS n FROM ${schema}.evidence WHERE attempt_id=$1`, [attempt.id])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT state FROM ${schema}.payment_attempts WHERE id=$1`, [attempt.id])).rows[0].state).toBe("awaiting_buyer_approval");
  } finally { await pool.query(`DROP TRIGGER qualification_failure ON ${schema}.payment_attempts`); }
});
it("does not approve an unrelated provider order even if its status is APPROVED", async () => {
  const { intent, attempt } = await store.createCheckout("qualified-checkout-foreign-0001");
  await store.attachOrder(attempt.id, "SYNTHETIC_EXPECTED_ORDER");
  const raw = readback(intent.id); raw.status = "APPROVED"; delete raw.purchase_units![0]!.payments;
  const result = await store.recordReadback(attempt.id, raw, "SYNTHETIC_QUALIFICATION");
  expect(result.attempt.state).toBe("mismatch");
});
it("enforces established capture identity for every SQL writer", async () => {
  const { intent, attempt } = await store.createCheckout("qualified-canonical-identity-0001");
  await store.attachOrder(attempt.id, "SYNTHETIC_CANONICAL_ORDER");
  const raw = readback(intent.id, "SYNTHETIC_CANONICAL_CAPTURE"); raw.id = "SYNTHETIC_CANONICAL_ORDER";
  await store.recordReadback(attempt.id, raw, "SYNTHETIC_QUALIFICATION");
  await expect(pool.query(`UPDATE ${schema}.payment_attempts SET capture_id='CONFLICTING_CAPTURE' WHERE id=$1`, [attempt.id])).rejects.toThrow(/capture identity/);
});
