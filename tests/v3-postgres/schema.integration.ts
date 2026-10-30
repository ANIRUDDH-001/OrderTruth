import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GUARD_SCHEMA, guardMigrationV1, migrateGuard } from "../../packages/guard/src/schema.ts";
import { obligationKeyP1, validateIdentifier } from "../../packages/guard/src/identity.ts";
import { createDisposableDatabase, type DisposableDatabase } from "./harness.ts";

let db: DisposableDatabase;
beforeAll(async () => { db = await createDisposableDatabase(); });
afterAll(async () => { await db?.drop(); });

const INSERT = `INSERT INTO ordertruth_guard.obligations (merchant_id, operation_kind, paypal_env, payee_merchant_id, capture_id, intent_id,
    claimed_by_call_id, origin, fingerprint, authority, provenance, contract_version, sdk_version, path_id, site_id, build_id)
  VALUES ($1, 'CREATE_ORDER', 'sandbox', $2, $3, $4, $5, 'NEW', 'fp', 'TEST', 'SYNTHETIC_FIXTURE', 'OT_V3_OBLIGATION@0.1.0', 'test', 'p', 's', 'b')
  RETURNING obligation_key`;
const sqlState = async (p: Promise<unknown>) => p.then(() => ({ code: "none", constraint: undefined as string | undefined }),
  (e: { code?: string; constraint?: string }) => ({ code: e.code ?? "unknown", constraint: e.constraint }));

/** mulberry32: small seeded PRNG so a failing parity case can be replayed from its printed seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Includes a combining mark (NFD é), a BOM and the replacement character, alongside separators and astral characters.
const ALPHABET = ["a", "Z", "0", "-", "_", "|", ":", "é", "é", "﻿", "�", "中", "\u{1D11E}", "\u{1F600}"];
/** Exactly `length` code points (some alphabet entries, like NFD é, are two code points). */
const identifier = (next: () => number, length: number) => {
  let s = "";
  while ([...s].length < length) s += ALPHABET[Math.floor(next() * ALPHABET.length)]!;
  return [...s].slice(0, length).join("");
};

describe("guard migration v1 on PostgreSQL 18", () => {
  it("generated key expression is accepted by PG18", async () => {
    const version = (await db.client.query("SHOW server_version_num")).rows[0].server_version_num as string;
    expect(Number(version)).toBeGreaterThanOrEqual(180000);
    expect(Number(version)).toBeLessThan(190000);
    await migrateGuard(db.client, "SYN-M-A");
    await migrateGuard(db.client, "SYN-M-A");          // idempotent for the same merchant
    expect(GUARD_SCHEMA).toBe("ordertruth_guard");
    expect(guardMigrationV1()).toContain("GENERATED ALWAYS AS");
    const generated = await db.client.query(`SELECT attgenerated FROM pg_attribute WHERE attrelid = 'ordertruth_guard.obligations'::regclass AND attname = 'obligation_key'`);
    expect(generated.rows[0].attgenerated).toBe("s");
  });

  it("key parity: astral, separators, max length", async () => {
    const seed = Number(process.env.V3_PARITY_SEED ?? 20261030);
    const next = rng(seed), seen = new Set<string>(), cases: Array<{ payee: string; capture: string }> = [
      { payee: "\u{1D11E}".repeat(128), capture: "c".repeat(128) },            // maximum length in code points
      { payee: "a|1:b", capture: "c" }, { payee: "a", capture: "1:b|c" },      // separator-bearing collision probe
    ];
    while (cases.length < 200) {
      const payee = identifier(next, 1 + Math.floor(next() * 128)), capture = identifier(next, 1 + Math.floor(next() * 128));
      if (!seen.has(`${payee}\u0000${capture}`)) { seen.add(`${payee}\u0000${capture}`); cases.push({ payee, capture }); }
    }
    const mismatches: unknown[] = [];
    for (const [i, c] of cases.entries()) {
      expect(validateIdentifier(c.payee) && validateIdentifier(c.capture), `seed ${seed} case ${i} must be a valid identifier`).toBe(true);
      const sqlKey = (await db.client.query(INSERT, ["SYN-M-A", c.payee, c.capture, `I-${i}`, `call-${i}`])).rows[0].obligation_key as string;
      const tsKey = obligationKeyP1({ paypalEnv: "sandbox", payeeMerchantId: c.payee, captureId: c.capture, unit: "primary" });
      if (sqlKey !== tsKey) mismatches.push({ i, ...c, sqlKey, tsKey });
    }
    expect(mismatches, `seed ${seed}`).toEqual([]);
  });

  it("rejects a missing capture identity (NOT NULL in the P1-only migration)", async () => {
    // Plan Task 2 expects 23514 from the spec's nullable-column CHECK form; the committed, smoke-verified guard-v1.sql
    // declares the P1 identity columns NOT NULL, which PostgreSQL reports as 23502. Recorded as a checkpoint deviation.
    const r = await db.client.query(INSERT, ["SYN-M-A", "SYN-PAYEE-1", null, "I-null", "call-null"]).then(() => null, (e: { code?: string; column?: string }) => e);
    expect([r?.code, r?.column]).toEqual(["23502", "capture_id"]);
  });

  it("rejects empty or oversized identity parts", async () => {
    const cases: Array<[payee: string, capture: string]> = [["SYN-PAYEE-1", ""], ["", "SYN-CAP-E"], ["SYN-PAYEE-1", "c".repeat(129)]];
    for (const [payee, capture] of cases) {
      const r = await sqlState(db.client.query(INSERT, ["SYN-M-A", payee, capture, `I-len-${payee.length}-${capture.length}`, "call-len"]));
      expect(r.code, JSON.stringify([payee.length, capture.length])).toBe("23514");
    }
  });

  it("records the schema version and binds every delivery, intent and marker row to the merchant", async () => {
    expect((await db.client.query("SELECT schema_version FROM ordertruth_guard.installation")).rows).toEqual([{ schema_version: 1 }]);
    const columns = await db.client.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'ordertruth_guard'`);
    const has = (table: string, column: string) => columns.rows.find(c => c.table_name === table && c.column_name === column);
    for (const table of ["obligations", "capture_evidence", "outbox", "outbox_deliveries", "commit_intents", "commit_markers"])
      expect(has(table, "merchant_id")?.is_nullable, `${table}.merchant_id`).toBe("NO");
    for (const table of ["obligations", "capture_evidence", "outbox"])
      for (const column of ["contract_version", "sdk_version", "build_id"]) expect(has(table, column)?.is_nullable, `${table}.${column}`).toBe("NO");
  });

  it("rejects a second capture for the same intent through the partial unique index", async () => {
    await db.client.query(INSERT, ["SYN-M-A", "SYN-PAYEE-1", "SYN-CAP-X1", "I-dup", "call-x1"]);
    const r = await sqlState(db.client.query(INSERT, ["SYN-M-A", "SYN-PAYEE-1", "SYN-CAP-X2", "I-dup", "call-x2"]));
    expect(r).toEqual({ code: "23505", constraint: "obligations_p1_intent" });
  });

  it("refuses to migrate a database installed for another merchant", async () => {
    await expect(migrateGuard(db.client, "SYN-M-B")).rejects.toThrow(/installation belongs to another merchant/);
    expect((await db.client.query("SELECT merchant_id FROM ordertruth_guard.installation")).rows).toEqual([{ merchant_id: "SYN-M-A" }]);
  });
});

describe("guard migration v1 refuses unsafe targets", () => {
  it("refuses a database that is not UTF8, where length() would count bytes and break key parity", async () => {
    const ascii = await createDisposableDatabase({ encoding: "SQL_ASCII" });
    try {
      await expect(migrateGuard(ascii.client, "SYN-M-A")).rejects.toThrow(/UTF8/);
      expect((await ascii.client.query("SELECT to_regnamespace('ordertruth_guard') AS s")).rows[0].s).toBeNull();
    } finally { await ascii.drop(); }
  });
  it("refuses a database that holds the OrderTruth cloud schema", async () => {
    const cloud = await createDisposableDatabase();
    try {
      await cloud.client.query("CREATE SCHEMA ordertruth");
      await expect(migrateGuard(cloud.client, "SYN-M-A")).rejects.toThrow(/cloud schema/);
      expect((await cloud.client.query("SELECT to_regnamespace('ordertruth_guard') AS s")).rows[0].s).toBeNull();
    } finally { await cloud.drop(); }
  });
});
