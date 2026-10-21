import type { Pool } from "pg";
import { withTransaction } from "./postgres.ts";
import { POSTGRES_SCHEMA_V1 } from "./postgres-schema.ts";
import { POSTGRES_SCHEMA_V2 } from "./postgres-guards.ts";
import { POSTGRES_AUTH_V3 } from "./postgres-auth-schema.ts";
import { POSTGRES_SCENARIOS_V4 } from "./postgres-scenario-schema.ts";
import { POSTGRES_BROWSER_APPROVAL_V5 } from "./postgres-browser-approval.ts";
import { POSTGRES_INVESTIGATION_V6 } from "./postgres-investigation-schema.ts";
import { POSTGRES_INVESTIGATION_HISTORY_V7 } from "./postgres-investigation-history.ts";
import { POSTGRES_DEMO_LIMITS_V8 } from "./postgres-demo-limits.ts";

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
    if (version > 8) throw new Error("Database schema is newer than this application");
    if (version === 0) {
      await client.query(POSTGRES_SCHEMA_V1);
      await client.query("INSERT INTO ordertruth_postgres_migrations(version) VALUES(1)");
    }
    if (version < 2) {
      await client.query(POSTGRES_SCHEMA_V2);
      await client.query("INSERT INTO ordertruth_postgres_migrations(version) VALUES(2)");
    }
    if (version < 3) {
      await client.query(POSTGRES_AUTH_V3);
      await client.query("INSERT INTO ordertruth_postgres_migrations(version) VALUES(3)");
    }
    if (version < 4) {
      await client.query(POSTGRES_SCENARIOS_V4);
      await client.query("INSERT INTO ordertruth_postgres_migrations(version) VALUES(4)");
    }
    if (version < 5) {
      await client.query(POSTGRES_BROWSER_APPROVAL_V5);
      await client.query("INSERT INTO ordertruth_postgres_migrations(version) VALUES(5)");
    }
    if (version < 6) {
      await client.query(POSTGRES_INVESTIGATION_V6);
      await client.query("INSERT INTO ordertruth_postgres_migrations(version) VALUES(6)");
    }
    if (version < 7) {
      await client.query(POSTGRES_INVESTIGATION_HISTORY_V7);
      await client.query("INSERT INTO ordertruth_postgres_migrations(version) VALUES(7)");
    }
    if (version < 8) {
      await client.query(POSTGRES_DEMO_LIMITS_V8);
      await client.query("INSERT INTO ordertruth_postgres_migrations(version) VALUES(8)");
    }
  });
}
