/**
 * OrderTruth v3 guard schema (spec §5.1, §5.2a). Applies packages/guard/sql/guard-v1.sql verbatim to a merchant
 * database and binds it to exactly one merchant tenant. Never used on the OrderTruth cloud database.
 */
import { readFileSync } from "node:fs";
import type { ClientBase } from "pg";
import { validateIdentifier } from "./identity.ts";

export const GUARD_SCHEMA = "ordertruth_guard";
const MIGRATION_V1 = new URL("../sql/guard-v1.sql", import.meta.url);

export function guardMigrationV1(): string {
  return readFileSync(MIGRATION_V1, "utf8");
}

/** Idempotent. Serialized by an advisory lock; refuses a database already installed for a different merchant. */
export async function migrateGuard(client: ClientBase, merchantId: string): Promise<void> {
  if (!validateIdentifier(merchantId)) throw new Error("migrateGuard: invalid merchant id");
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ordertruth_guard:migrate', 0))");
    // The generated key matches obligationKeyP1 only where length() counts code points, i.e. in a UTF8 database.
    const encoding = (await client.query<{ server_encoding: string }>("SHOW server_encoding")).rows[0]?.server_encoding;
    if (encoding !== "UTF8") throw new Error(`migrateGuard: requires a UTF8 merchant database (found ${encoding ?? "unknown"})`);
    if ((await client.query<{ s: string | null }>("SELECT to_regnamespace('ordertruth')::text AS s")).rows[0]?.s !== null)
      throw new Error("migrateGuard: refusing a database that holds the OrderTruth cloud schema \"ordertruth\"");
    await client.query(guardMigrationV1());
    const inserted = await client.query(
      "INSERT INTO ordertruth_guard.installation (merchant_id) VALUES ($1) ON CONFLICT (singleton) DO NOTHING RETURNING merchant_id", [merchantId]);
    if (inserted.rowCount === 0) {
      const existing = (await client.query<{ merchant_id: string }>("SELECT merchant_id FROM ordertruth_guard.installation")).rows[0]?.merchant_id;
      if (existing !== merchantId) throw new Error("ordertruth_guard installation belongs to another merchant");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
