import { randomBytes } from "node:crypto";
import pg from "pg";

/** Disposable-database harness for v3 tests (plan: Task 2 "Database harness"). Refuses anything but a local or compose PostgreSQL. */
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "postgres"]);
const ALLOWED_DATABASE = /^(postgres|otg_[0-9a-f]{20})$/;

export function adminConfig(): pg.ClientConfig {
  const raw = process.env.V3_PG_URL;
  if (!raw) throw new Error("V3_PG_URL is not set; v3 database tests run only against a disposable PostgreSQL");
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres";
  if (!ALLOWED_HOSTS.has(url.hostname)) throw new Error(`refusing V3_PG_URL host ${url.hostname}`);
  if (!ALLOWED_DATABASE.test(database)) throw new Error(`refusing V3_PG_URL database ${database}`);
  return { host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database,
    connectionTimeoutMillis: 10_000, statement_timeout: 30_000 };
}

export type DisposableDatabase = { name: string; config: pg.ClientConfig; client: pg.Client; drop(): Promise<void> };

/** UTF8 from template0 by default (key parity relies on PostgreSQL counting code points); SQL_ASCII only to test the refusal. */
export async function createDisposableDatabase(o: { encoding?: "UTF8" | "SQL_ASCII" } = {}): Promise<DisposableDatabase> {
  const admin = new pg.Client(adminConfig());
  await admin.connect();
  const name = `otg_${randomBytes(10).toString("hex")}`;
  const encoding = o.encoding === "SQL_ASCII" ? "ENCODING 'SQL_ASCII' LOCALE 'C'" : "ENCODING 'UTF8'";
  try {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ${encoding}`);
    const config = { ...adminConfig(), database: name };
    const client = new pg.Client(config);
    await client.connect();
    return { name, config, client, async drop() {
      await client.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    } };
  } catch (error) {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
    throw error;
  }
}
