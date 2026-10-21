import type { Pool } from "pg";
import { withTransaction } from "./postgres.ts";
import { POSTGRES_SCHEMA_V1 } from "./postgres-schema.ts";
import { POSTGRES_SCHEMA_V2 } from "./postgres-guards.ts";

export async function migratePostgres(pool: Pool, schema: string): Promise<void> {
  if (schema !== "ordertruth" && !/^qual_[a-f0-9]{20}$/.test(schema)) throw new Error("Use the owned OrderTruth schema or an isolated qualification schema");
  await withTransaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`ordertruth-migrate:${schema}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query("SELECT set_config('search_path',$1,true)", [`${schema},pg_catalog`]);
    const journal = await client.query("SELECT to_regclass($1) AS name", [`${schema}.ordertruth_postgres_migrations`]);
    if (!journal.rows[0].name) {
      const tables = await client.query("SELECT count(*)::integer AS n FROM pg_tables WHERE schemaname=$1", [schema]);
      if (tables.rows[0].n !== 0) throw new Error("Refusing to migrate unmanaged nonempty schema");
      await client.query("CREATE TABLE ordertruth_postgres_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    }
    const version = (await client.query("SELECT coalesce(max(version),0) AS version FROM ordertruth_postgres_migrations")).rows[0].version;
    if (version > 2) throw new Error("Database schema is newer than this application");
    if (version === 0) {
      await client.query(POSTGRES_SCHEMA_V1);
      await client.query("INSERT INTO ordertruth_postgres_migrations(version) VALUES(1)");
    }
    if (version < 2) {
      await client.query(POSTGRES_SCHEMA_V2);
      await client.query("INSERT INTO ordertruth_postgres_migrations(version) VALUES(2)");
    }
  });
}
