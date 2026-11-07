import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { assertPostgresTestTarget } from "../../scripts/qualification-safety.ts";
import { createPostgresPool } from "../../src/db/postgres.ts";

// Never inherit DATABASE_URL or borrow an existing cluster. This worktree's
// managed loopback cluster or GitHub's explicit disposable service is checked before migrations.
export const env = parseEnv(readFileSync(new URL("../../.work/postgres/.env", import.meta.url), "utf8"));
const url = new URL(env.DATABASE_URL!);
const mode = assertPostgresTestTarget(env,process.env);
if (mode === "managed-local" && readFileSync(new URL("../../.work/postgres/managed.json", import.meta.url), "utf8") !== "ordertruth-local-postgres-v1") {
  throw new Error("Owned disposable local PostgreSQL only");
}
const identity = createPostgresPool(url.href);
try {
  const actual = (await identity.query(`SELECT current_database() AS db,current_user AS usr,host(inet_server_addr()) AS host,
    current_setting('port') AS port,current_setting('data_directory') AS directory,current_setting('fsync') AS fsync,
    current_setting('synchronous_commit') AS synchronous_commit,current_setting('server_version_num') AS version`)).rows[0];
  const owned = mode === "managed-local"
    ? actual.usr === "ordertruth_dev" && actual.host === "127.0.0.1" && actual.port === url.port
      && realpathSync(actual.directory) === realpathSync(resolve(".work/postgres/data"))
    : actual.usr === "ordertruth_ci" && actual.port === "5432" && actual.directory === "/var/lib/postgresql/18/docker";
  if (!owned || actual.db !== "ordertruth" || Number(actual.version) < 180000 || Number(actual.version) >= 190000
    || actual.fsync !== "on" || actual.synchronous_commit !== "on") {
    throw new Error("Disposable PostgreSQL ownership/durability mismatch");
  }
} finally { await identity.end(); }
