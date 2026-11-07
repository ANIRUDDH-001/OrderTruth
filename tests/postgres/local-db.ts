import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { createPostgresPool } from "../../src/db/postgres.ts";

// Never inherit DATABASE_URL or borrow an existing cluster. This worktree's
// separately provisioned loopback cluster is checked before any test migrates.
export const env = parseEnv(readFileSync(new URL("../../.work/postgres/.env", import.meta.url), "utf8"));
const url = new URL(env.DATABASE_URL!);
if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || !["55432","55435"].includes(url.port)
  || url.pathname !== "/ordertruth" || url.username !== "ordertruth_dev" || url.search || url.hash
  || env.PGHOST !== url.hostname || env.PGPORT !== url.port || env.PGDATABASE !== "ordertruth"
  || readFileSync(new URL("../../.work/postgres/managed.json", import.meta.url), "utf8") !== "ordertruth-local-postgres-v1") {
  throw new Error("C-core owned disposable local PostgreSQL only");
}
const identity = createPostgresPool(url.href);
try {
  const actual = (await identity.query(`SELECT current_database() AS db,current_user AS usr,host(inet_server_addr()) AS host,
    current_setting('port') AS port,current_setting('data_directory') AS directory,current_setting('fsync') AS fsync,
    current_setting('synchronous_commit') AS synchronous_commit`)).rows[0];
  if (actual.db !== "ordertruth" || actual.usr !== "ordertruth_dev" || actual.host !== "127.0.0.1" || actual.port !== url.port
    || realpathSync(actual.directory) !== realpathSync(resolve(".work/postgres/data")) || actual.fsync !== "on" || actual.synchronous_commit !== "on") {
    throw new Error("Disposable PostgreSQL ownership/durability mismatch");
  }
} finally { await identity.end(); }
