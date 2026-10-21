import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const PORT = "55432";
const USER = "ordertruth_dev";
const MARKER = "ordertruth-local-postgres-v1";

// Never consult the application's .env or an existing PostgreSQL service.
// This helper exclusively manages its own loopback development cluster.
export function localPostgres(command: string, root: string, bin?: string): string {
  if (!["start", "check", "stop"].includes(command)) throw new Error("Use start, check or stop");
  root = realpathSync(root);
  const work = join(root, ".work");
  const base = join(work, "postgres");
  const data = join(base, "data");
  const marker = join(base, "managed.json");
  const envFile = join(base, ".env");
  const bootstrap = join(base, "bootstrap");
  const passwordFile = join(bootstrap, ".env");
  for (const path of [work, base, data, marker, envFile, bootstrap, passwordFile]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Refusing symlink/junction in managed PostgreSQL path");
  }
  if (existsSync(base)) {
    if (!existsSync(marker) || readFileSync(marker, "utf8") !== MARKER) {
      throw new Error("Refusing unmanaged PostgreSQL directory; no files changed");
    }
  } else {
    if (command !== "start") throw new Error("Local PostgreSQL is not initialized; use start");
    mkdirSync(base, { recursive: true });
    writeFileSync(marker, MARKER, { flag: "wx" });
  }
  const configuredBin = bin ?? process.env.ORDERTRUTH_PG_BIN
    ?? (process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\18\\bin" : "");
  const executable = (name: string) => configuredBin ? join(configuredBin, name) : name;
  // Ignore ambient PGHOST/PGSERVICE/PGOPTIONS and other client overrides.
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG")));
  function run(name: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv; allowed?: number[]; quiet?: boolean } = {}): string {
    const result = spawnSync(executable(name), args, {
      encoding: "utf8", windowsHide: true, shell: false, timeout: 30_000,
      env: options.env ?? childEnv, ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.quiet ? { stdio: "ignore" as const } : {}),
    });
    // Do not relay child output on failure: database errors can contain credentials.
    if (result.error || !(options.allowed ?? [0]).includes(result.status ?? -1)) {
      throw new Error(`${name} failed (exit ${result.status ?? "unavailable"}); verify PostgreSQL 18 binaries and local port ${PORT}`);
    }
    return result.stdout?.trim() ?? "";
  }
  if (!run("initdb", ["--version"]).match(/PostgreSQL\) 18\./)) throw new Error("PostgreSQL 18 is required for this local checkpoint");
  if (!existsSync(envFile)) {
    if (command !== "start") throw new Error("Managed local credentials are absent; use start");
    if (existsSync(data)) throw new Error("Missing credentials for existing cluster; refusing to replace them");
    const password = randomBytes(32).toString("hex");
    writeFileSync(envFile, `PGHOST=127.0.0.1\nPGPORT=${PORT}\nPGUSER=${USER}\nPGPASSWORD=${password}\nPGDATABASE=ordertruth\nDATABASE_URL=postgresql://${USER}:${password}@127.0.0.1:${PORT}/ordertruth\n`, { mode: 0o600, flag: "wx" });
  }
  const env = parseEnv(readFileSync(envFile, "utf8"));
  if (env.PGHOST !== "127.0.0.1" || env.PGPORT !== PORT || env.PGUSER !== USER
      || env.PGDATABASE !== "ordertruth" || !/^[a-f0-9]{64}$/.test(env.PGPASSWORD ?? "")) {
    throw new Error("Invalid managed credentials; refusing another host, port or identity");
  }
  const clientEnv = { ...childEnv, PGHOST: env.PGHOST, PGPORT: env.PGPORT, PGUSER: env.PGUSER,
    PGPASSWORD: env.PGPASSWORD, PGDATABASE: env.PGDATABASE, PGCONNECT_TIMEOUT: "5" };
  const sql = (query: string, database = "ordertruth") => run("psql", ["-X", "-w", "-v", "ON_ERROR_STOP=1", "-At", "-d", database], { env: clientEnv, input: query });
  if (!existsSync(join(data, "PG_VERSION"))) {
    if (command !== "start") throw new Error("Local cluster is not initialized; use start");
    if (existsSync(data) && readdirSync(data).length) throw new Error("Refusing incomplete nonempty cluster; inspect it manually");
    mkdirSync(bootstrap, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(passwordFile, env.PGPASSWORD!, { flag: "wx", mode: 0o600 });
      run("initdb", ["-D", data, "-U", USER, "--auth=scram-sha-256", "--encoding=UTF8", "--locale=C", `--pwfile=${passwordFile}`]);
    } finally { if (existsSync(passwordFile)) unlinkSync(passwordFile); }
  }
  if (command === "stop") {
    run("pg_ctl", ["stop", "-D", data, "-m", "fast", "-w", "-t", "15"], { allowed: [0, 3] });
    return "Managed local PostgreSQL stopped; committed data retained";
  }
  if (command === "start") {
    const status = spawnSync(executable("pg_ctl"), ["status", "-D", data], { encoding: "utf8", windowsHide: true, env: childEnv, timeout: 5_000 });
    // On Windows a detached server can retain pg_ctl's captured pipe handles.
    // Its output already goes to server.log; don't wait for inherited pipes to close.
    if (status.status === 3) run("pg_ctl", ["start", "-D", data, "-l", join(base, "server.log"), "-w", "-t", "15", "-o", `-h 127.0.0.1 -p ${PORT}`], { quiet: true });
    else if (status.status !== 0) throw new Error("Cannot establish managed cluster status");
    if (sql("SELECT count(*) FROM pg_database WHERE datname='ordertruth';", "postgres") === "0") {
      sql("CREATE DATABASE ordertruth;", "postgres");
    }
  }
  const actual = sql("SELECT current_database(), current_user, inet_server_addr(), current_setting('port'), current_setting('fsync'), current_setting('synchronous_commit');");
  if (actual !== `ordertruth|${USER}|127.0.0.1|${PORT}|on|on`) throw new Error("Local database identity/durability settings did not match");
  return `Local PostgreSQL ready on 127.0.0.1:${PORT}; credentials remain in ignored .work/postgres/.env`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(localPostgres(process.argv[2] ?? "check", resolve(dirname(fileURLToPath(import.meta.url)), ".."))); }
  catch (error) { console.error(error instanceof Error ? error.message : "Local PostgreSQL setup failed"); process.exitCode = 1; }
}
