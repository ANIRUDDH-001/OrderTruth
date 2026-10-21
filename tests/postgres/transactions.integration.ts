import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool, withTransaction } from "../../src/db/postgres.ts";

// Deliberately cannot use DATABASE_URL from the shell/application or a hosted DB.
const env = parseEnv(readFileSync(new URL("../../.work/postgres/.env", import.meta.url), "utf8"));
if (env.PGHOST !== "127.0.0.1" || env.PGPORT !== "55432" || env.PGDATABASE !== "ordertruth") {
  throw new Error("Qualification requires the managed loopback database");
}
const url = env.DATABASE_URL!;
const schema = `qual_${randomBytes(10).toString("hex")}`;
const observer = new pg.Pool({ host: "127.0.0.1", port: 55432, database: "ordertruth", user: env.PGUSER, password: env.PGPASSWORD, max: 2 });
let pool: pg.Pool;
beforeAll(async () => {
  await observer.query(`CREATE SCHEMA ${schema}`);
  await observer.query(`CREATE TABLE ${schema}.facts (id text PRIMARY KEY, value integer NOT NULL)`);
  await observer.query(`INSERT INTO ${schema}.facts VALUES ('commit',0),('rollback',0),('race',0),('terminate',0)`);
  pool = createPostgresPool(url);
});
afterAll(async () => {
  if (pool) await pool.end();
  // Only the unique schema created above is disposable, never application tables.
  if (!/^qual_[a-f0-9]{20}$/.test(schema)) throw new Error("Unsafe qualification schema");
  await observer.query(`DROP SCHEMA ${schema} CASCADE`);
  await observer.end();
});

describe("real local PostgreSQL transaction boundary", () => {
  it("binds statements to one connection and publishes only committed changes", async () => {
    await withTransaction(pool, async client => {
      const first = await client.query("SELECT pg_backend_pid() AS pid");
      await client.query(`UPDATE ${schema}.facts SET value=1 WHERE id='commit'`);
      expect((await observer.query(`SELECT value FROM ${schema}.facts WHERE id='commit'`)).rows[0].value).toBe(0);
      const last = await client.query("SELECT pg_backend_pid() AS pid");
      expect(last.rows[0].pid).toBe(first.rows[0].pid);
    });
    expect((await observer.query(`SELECT value FROM ${schema}.facts WHERE id='commit'`)).rows[0].value).toBe(1);
  });
  it("rolls back a correction when execution fails before commit", async () => {
    await expect(withTransaction(pool, async client => {
      await client.query(`UPDATE ${schema}.facts SET value=1 WHERE id='rollback'`);
      throw new Error("controlled precommit interruption");
    })).rejects.toThrow("controlled precommit interruption");
    expect((await observer.query(`SELECT value FROM ${schema}.facts WHERE id='rollback'`)).rows[0].value).toBe(0);
  });
  it("serializes conflicting writers from independent transactions", async () => {
    let unlocked!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>(resolve => { unlocked = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const first = withTransaction(pool, async client => {
      const row = await client.query(`SELECT value, pg_backend_pid() AS pid FROM ${schema}.facts WHERE id='race' FOR UPDATE`);
      locked();
      await gate;
      await client.query(`UPDATE ${schema}.facts SET value=$1 WHERE id='race'`, [row.rows[0].value + 1]);
      return row.rows[0].pid;
    });
    await acquired;
    const second = withTransaction(pool, async client => {
      const row = await client.query(`SELECT value, pg_backend_pid() AS pid FROM ${schema}.facts WHERE id='race' FOR UPDATE`);
      await client.query(`UPDATE ${schema}.facts SET value=$1 WHERE id='race'`, [row.rows[0].value + 1]);
      return row.rows[0].pid;
    });
    unlocked();
    const pids = await Promise.all([first, second]);
    expect(pids[0]).not.toBe(pids[1]);
    expect((await observer.query(`SELECT value FROM ${schema}.facts WHERE id='race'`)).rows[0].value).toBe(2);
  });
  it("rolls back on actual connection termination and discards the dead client", async () => {
    await expect(withTransaction(pool, async client => {
      const { rows } = await client.query("SELECT pg_backend_pid() AS pid");
      await client.query(`UPDATE ${schema}.facts SET value=1 WHERE id='terminate'`);
      await observer.query("SELECT pg_terminate_backend($1)", [rows[0].pid]);
      await client.query("SELECT 1");
    })).rejects.toThrow();
    expect((await observer.query(`SELECT value FROM ${schema}.facts WHERE id='terminate'`)).rows[0].value).toBe(0);
    expect((await withTransaction(pool, client => client.query("SELECT 1 AS ready"))).rows[0].ready).toBe(1);
  });
  it("retrieves committed facts through a fresh connection pool", async () => {
    const fresh = createPostgresPool(url);
    try { expect((await fresh.query(`SELECT value FROM ${schema}.facts WHERE id='commit'`)).rows[0].value).toBe(1); }
    finally { await fresh.end(); }
  });
  it("refuses integers outside JavaScript's exact range instead of rounding money or identities", async () => {
    await expect(pool.query("SELECT '9007199254740993'::bigint AS unsafe_value")).rejects.toThrow(/exact range/);
  });
});
