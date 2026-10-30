/**
 * Gate A verifier controller (plan Task 10). Trusted; runs on the host and owns the fixtures, the fault proxy's control, the
 * observer role, the rungs and the report. Verdicts come only from rungs.ts (observer SQL, proxy events, the trusted
 * PostgreSQL log, exit statuses); candidates run unprivileged in their own container.
 *
 *   pnpm v3:verify:gate-a [-- --only L0,L1] [--candidate REFERENCE_FIX] [--runs N]
 *
 * Flow: refuse on manifest drift → per-run secrets (never logged; passed to compose only through this process's environment)
 * → compose build/up and image digests → roles and template databases → every rung on fresh clones, for ORIGINAL,
 * REFERENCE_FIX and each negative control's intended rung → repeat → compareForced → redacted evidence under
 * .work/v3/gate-a/<runId>/ → `compose down -v`, always.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { migrateGuard } from "../../guard/src/schema.ts";
import { SHOP_INTENTS_SQL, SHOP_SCHEMA_SQL } from "../../lab-merchant/src/schema.ts";
import { drift, manifestSha256, recordedManifest, subjectTreeSha, type Manifest } from "./manifest.ts";
import { rolesSql } from "./observer.ts";
import { accept, deriveNcObservation, evaluate, qualification, GATE_A_APPLICABLE, NC_INTENDED, type NcId, type NcResult, type RungId, type RungResult, type RunReport } from "./report.ts";
import { ORIGINAL_RUNGS, runRung, type CandidateId, type CandidateInput, type Db, type ExecResult, type HandlerClaim, type L0Shared, type ProxyRule, type RungContext } from "./rungs.ts";
import { closeClient, closePool, trustedClient, trustedPool } from "./trusted-db.ts";
import { cleanup, type Resources } from "./cleanup.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const COMPOSE = ["compose", "-f", "packages/verifier/docker/gate-a.compose.yml", "--profile", "l0"];
const arg = (name: string) => { const i = process.argv.lastIndexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const runs = Number(arg("--runs") ?? "2");
const only = arg("--only")?.split(",") as RungId[] | undefined;
const onlyCandidate = arg("--candidate") as CandidateId | undefined;
if (arg("--gate") !== "A") throw new Error("controller: --gate A is required");
if (!Number.isInteger(runs) || runs < 1 || runs > 5) throw new Error("controller: --runs must be 1–5");
if (only?.some(id => !GATE_A_APPLICABLE.includes(id))) throw new Error(`controller: unknown rung in --only ${only.join(",")}`);

const secret = () => randomBytes(24).toString("hex");
const secrets = { OT_PG_SUPERUSER_PASSWORD: secret(), OT_CANDIDATE_PASSWORD: secret(), OT_OBSERVER_PASSWORD: secret(), OT_PROXY_CONTROL_TOKEN: secret(),
  OT_TEST_AUTHORITY_KEY: randomBytes(32).toString("hex"), OT_CAPABILITY_KEY: randomBytes(32).toString("hex") };
const redact = (text: string) => Object.values(secrets).reduce((t, s) => t.split(s).join("[REDACTED]"), text);
const childEnv = { ...process.env, ...secrets };
const log = (line: string) => console.log(redact(line));

function run(cmd: string, args: string[], o: { timeoutMs?: number; quiet?: boolean } = {}): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: childEnv, windowsHide: true });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`timed out: ${cmd} ${args.slice(0, 6).join(" ")}`)); }, o.timeoutMs ?? 120_000);
    p.stdout.on("data", d => { stdout += d; }); p.stderr.on("data", d => { stderr += d; });
    p.on("error", e => { clearTimeout(timer); reject(e); });
    p.on("close", exit => { clearTimeout(timer); resolve({ exit, stdout, stderr }); });
  });
}
const compose = async (args: string[], timeoutMs = 600_000) => {
  const r = await run("docker", [...COMPOSE, ...args], { timeoutMs });
  if (r.exit !== 0) throw new Error(`docker compose ${args.join(" ")} failed (${String(r.exit)}): ${redact(r.stderr).slice(-2000)}`);
  return r;
};

// ---- PostgreSQL access (trusted): the superuser for setup, ot_observer for verdicts ----
let pgPort = 0;
const resolvePort = async () => { const out = (await compose(["port", "postgres", "5432"])).stdout.trim(); pgPort = Number(out.split(":").pop()); };
const base = () => ({ host: "127.0.0.1", port: pgPort, connectionTimeoutMillis: 10_000 });
const superuser = (database: string) => ({ ...base(), user: "postgres", password: secrets.OT_PG_SUPERUSER_PASSWORD, database });
const observers = new Map<Db, pg.Pool>();
async function withClient<T>(database: string, f: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = trustedClient(superuser(database));
  try { await c.connect(); return await f(c); } finally { await closeClient(c); }
}
const roles = (database: string) => rolesSql({ candidate_password: secrets.OT_CANDIDATE_PASSWORD, observer_password: secrets.OT_OBSERVER_PASSWORD, database });
async function waitForPostgres() {
  const end = Date.now() + 120_000;
  for (;;) {
    try { await resolvePort(); await withClient("postgres", c => c.query("SELECT 1")); return; } catch (error) {
      if (Date.now() > end) throw error;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}
async function bootstrap() {
  await withClient("postgres", c => c.query(roles("postgres").cluster));
  for (const [template, merchantId] of [["merchant_template", "SYN-M-A"], ["merchant_b_template", "SYN-M-B"]] as const) {
    await withClient("postgres", c => c.query(`CREATE DATABASE ${template} OWNER ot_setup TEMPLATE template0 ENCODING 'UTF8'`));
    await withClient(template, async c => {
      await c.query("SET ROLE ot_setup");                 // schemas and tables owned by ot_setup, never by the candidate
      await migrateGuard(c, merchantId);
      await c.query(SHOP_SCHEMA_SQL); await c.query(SHOP_INTENTS_SQL);
      await c.query("RESET ROLE");
      await c.query(roles(template).database);
    });
    // Finished templates accept no connections at all; only their clones grant CONNECT (review CP3 B1).
    await withClient("postgres", c => c.query(roles(template).template));
  }
}
async function fresh(dbs: Db[] = ["merchant_a"]) {
  for (const db of dbs) {
    const old = observers.get(db); observers.delete(db);
    if (old) await closePool(old);
    const template = db === "merchant_a" ? "merchant_template" : "merchant_b_template";
    await withClient("postgres", async c => {
      await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await c.query(`CREATE DATABASE ${db} OWNER ot_setup TEMPLATE ${template}`);
    });
    await withClient(db, c => c.query(roles(db).connect));
  }
}
function observer(db: Db = "merchant_a"): pg.Pool {
  let p = observers.get(db);
  if (!p) {
    p = trustedPool({ ...base(), user: "ot_observer", password: secrets.OT_OBSERVER_PASSWORD, database: db, max: 6, application_name: "ot-observer" });
    observers.set(db, p);
  }
  return p;
}
async function closeObservers() {
  const pools = [...observers.values()]; observers.clear();
  const results = await Promise.allSettled(pools.map(p => closePool(p)));
  const errors = results.filter(r => r.status === "rejected");
  if (errors.length) throw new AggregateError(errors.map(r => r.reason), "observer shutdown failed");
}
async function reconnect() { await waitForPostgres(); await closeObservers(); }

/** Query Docker directly after teardown; a failed readback never counts as an empty inventory. */
async function inventory(): Promise<Resources> {
  const filter = ["--filter", "label=com.docker.compose.project=ot-v3-gate-a"];
  const list = async (args: string[]) => {
    const r = await run("docker", args, { timeoutMs: 30_000 });
    if (r.exit !== 0) throw new Error(`resource inventory failed (${String(r.exit)}): ${redact(r.stderr).slice(-500)}`);
    return r.stdout.trim().split(/\r?\n/).filter(Boolean);
  };
  const [containers, volumes, networks] = await Promise.all([
    list(["ps", "-aq", ...filter]), list(["volume", "ls", "-q", ...filter]), list(["network", "ls", "-q", ...filter]),
  ]);
  return { containers, volumes, networks };
}

// ---- the candidate and the proxy, only through `docker compose exec` ----
const claims: unknown[] = [];
async function exec(input: CandidateInput): Promise<ExecResult> {
  const encoded = `b64:${Buffer.from(JSON.stringify(input)).toString("base64")}`;
  const r = await run("docker", [...COMPOSE, "exec", "-T", "candidate", "node", "--experimental-strip-types", "--no-warnings",
    "packages/lab-merchant/src/candidate-main.ts", encoded], { timeoutMs: 180_000 });
  let claim: HandlerClaim | null = null;
  try { claim = (JSON.parse(r.stdout.trim().split("\n").pop() ?? "") as { claim?: HandlerClaim }).claim ?? null; } catch { claim = null; }
  claims.push({ at: new Date().toISOString(), input, exit: r.exit, claim, stderr: redact(r.stderr).slice(-500) });
  return { claim, exit: r.exit };
}
const candidateShell = async (argv: string[]) => { const r = await run("docker", [...COMPOSE, "exec", "-T", "candidate", ...argv], { timeoutMs: 60_000 }); return { exit: r.exit, stdout: r.stdout }; };
// Runs inside the proxy container: the token never leaves that container's environment.
const CONTROL = "const [m,p,b]=process.argv.slice(1);fetch('http://127.0.0.1:7070'+p,{method:m,headers:{authorization:'Bearer '+process.env.PROXY_CONTROL_TOKEN,"
  + "'content-type':'application/json'},...(b?{body:Buffer.from(b,'base64').toString()}:{})}).then(async r=>{console.log(await r.text());process.exit(r.ok?0:4)},"
  + "e=>{console.error(String(e));process.exit(5)})";
async function control(method: "GET" | "POST", path: string, body?: unknown) {
  const args = [...COMPOSE, "exec", "-T", "faultproxy", "node", "-e", CONTROL, method, path, ...(body === undefined ? [] : [Buffer.from(JSON.stringify(body)).toString("base64")])];
  const r = await run("docker", args, { timeoutMs: 30_000 });
  if (r.exit !== 0) throw new Error(`proxy control ${method} ${path} failed (${String(r.exit)}): ${redact(r.stderr)}`);
  return JSON.parse(r.stdout) as unknown;
}
const proxyEvents: unknown[] = [];
const proxy: RungContext["proxy"] = {
  arm: async (rule: ProxyRule) => { await control("POST", "/arm", rule); },
  release: async () => { await control("POST", "/release"); },
  events: async () => (await control("GET", "/events")) as Array<{ boundary: string | null; action: string }>,
  reset: async () => { proxyEvents.push(...((await control("GET", "/events")) as unknown[])); await control("POST", "/reset"); },
};
/** Waits until compose reports the service healthy (PostgreSQL's health check fails while it is paused). */
async function waitHealthy(name: string, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const out = (await compose(["ps", "--format", "json", name])).stdout.trim();
    const rows = out.startsWith("[") ? JSON.parse(out) as Array<{ Health?: string }>
      : out.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l) as { Health?: string });
    if (rows.some(r => r.Health === "healthy")) return;
    if (Date.now() > end) throw new Error(`${name} did not become healthy within ${timeoutMs} ms`);
    await new Promise(r => setTimeout(r, 1000));
  }
}
async function waitForProxy(timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) { try { await control("GET", "/events"); return; } catch (error) { if (Date.now() > end) throw error; await new Promise(r => setTimeout(r, 500)); } }
}
async function service(action: "pause" | "unpause" | "stop" | "start" | "restart", name: "postgres" | "faultproxy") {
  if (name === "faultproxy" && (action === "stop" || action === "restart")) proxyEvents.push(...((await control("GET", "/events").catch(() => [])) as unknown[]));
  // `start` goes through `up --no-deps`: compose's own start refuses while a dependency's health check is still recovering.
  await compose(action === "start" ? ["up", "-d", "--no-deps", name] : [action, name], 180_000);
  if (name === "postgres" && action !== "pause") { await waitHealthy("postgres"); await reconnect(); }
  if (name === "faultproxy" && (action === "start" || action === "restart")) await waitForProxy();
}
/** Before every rung: both services reachable, repairing them if a previous rung left one down. */
async function ensureHealthy() {
  try { await withClient("postgres", c => c.query("SELECT 1")); } catch {
    log("controller: PostgreSQL unreachable before a rung; restoring it");
    await compose(["unpause", "postgres"]).catch(() => {});
    await compose(["up", "-d", "--no-deps", "postgres"], 180_000);
    await waitHealthy("postgres"); await reconnect();
  }
  try { await control("GET", "/events"); } catch {
    log("controller: fault proxy unreachable before a rung; restoring it");
    await compose(["up", "-d", "--no-deps", "faultproxy"], 180_000);
    await waitForProxy();
  }
}
const DENIAL = /user=ot_candidate\b.*ERROR:\s+permission denied for schema verifier_oracle/;
const oracleDenials = async () => (await compose(["logs", "--no-color", "postgres"])).stdout.split("\n").filter(l => DENIAL.test(l)).length;

// ---- L0's shared qualification step: once per run, in the read-only `l0` container ----
let l0Cache: Promise<L0Shared> | undefined;
async function runL0(): Promise<L0Shared> {
  const r = await run("docker", [...COMPOSE, "run", "--rm", "l0"], { timeoutMs: 900_000 });
  const lines = r.stdout.split("\n");
  const step = (name: string) => {
    const line = lines.find(l => l.startsWith(`L0 ${name} `));
    const detail = [line ?? `no ${name} line (container exit ${String(r.exit)})`, ...lines.filter(l => l.startsWith("L0-") && l.includes(name === "packages_typecheck" ? "tsc" : "vitest"))].join(" | ");
    return { ok: line === `L0 ${name} 0` && lines.includes("L0 node v22.18.0"), detail: redact(detail) };
  };
  return { packages_typecheck: step("packages_typecheck"), offline_tests: step("offline_tests") };
}

// ---- one complete run ----
function seeded(seed: number) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; }; }
async function runOnce(n: number, runId: string, manifestSha: string, environment: RunReport["environment"]): Promise<RunReport> {
  const seed = randomBytes(4).readUInt32BE(0);
  const records: Record<string, unknown> = {};
  l0Cache = undefined;
  const ctx: RungContext = { fresh, observer, exec, candidateShell, proxy, service, oracleDenials, l0: () => (l0Cache ??= runL0()), ensureHealthy, random: seeded(seed), seed: String(seed),
    record: (name, value) => { records[name] = value; } };
  const rungIds = only ?? [...GATE_A_APPLICABLE];
  const wants = (c: CandidateId) => !onlyCandidate || onlyCandidate === c;
  const candidates: Record<"ORIGINAL" | "REFERENCE_FIX", RungResult[]> = { ORIGINAL: [], REFERENCE_FIX: [] };
  for (const candidate of ["ORIGINAL", "REFERENCE_FIX"] as const) {
    if (!wants(candidate)) continue;
    for (const id of rungIds) {
      const r = candidate === "ORIGINAL" && !ORIGINAL_RUNGS.includes(id) ? { id, status: "NOT_APPLICABLE" as const, checks: [] } : await runRung(ctx, id, candidate);
      log(`run ${n} ${candidate} ${id}: ${r.status}${r.checks.filter(c => !c.ok).map(c => ` [${c.name}: ${c.detail}]`).join("")}`);
      candidates[candidate].push(r);
    }
  }
  const negativeControls: NcResult[] = [];
  for (const id of Object.keys(NC_INTENDED) as NcId[]) {
    const intended = NC_INTENDED[id];
    if (!wants(id) || !rungIds.includes(intended.rung)) continue;
    const result = await runRung(ctx, intended.rung, id);
    const nc: NcResult = { id, intended, result, observed: "PASSED", detail: result.checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`).join("; ") };
    nc.observed = deriveNcObservation(nc);
    log(`run ${n} ${id} ${intended.rung}/${intended.check}: ${nc.observed}`);
    negativeControls.push(nc);
  }
  const report: RunReport = { runId: `${runId}-run${n}`, validity: "VALID", invalidReasons: [], candidates, negativeControls, environment,
    limitations: ["Synthetic TEST authority only; no PayPal readback.", "A database frozen during the operation itself (before COMMIT) is bounded only by the merchant pool's client settings.",
      "Candidate code holds INSERT/UPDATE on guard tables by design; verdicts rest on observer state, not on candidate-written journals being authentic."] };
  const v = evaluate(report);
  report.validity = v.validity; report.invalidReasons = v.invalidReasons;
  const dir = `${ROOT}.work/v3/gate-a/${runId}/run-${n}`;
  mkdirSync(`${dir}/snapshots`, { recursive: true });
  writeFileSync(`${dir}/report.json`, redact(JSON.stringify({ ...report, acceptance: accept(report, { expectedManifestSha256: manifestSha }) }, null, 2)));
  for (const [name, value] of Object.entries(records)) writeFileSync(`${dir}/snapshots/${name}.json`, redact(JSON.stringify(value, null, 2)));
  return report;
}

// ---- main ----
async function main() {
  const recorded = recordedManifest();
  const drifted = drift(recorded);
  if (drifted.length) { console.error(`controller: refusing to run, manifest drift:\n  ${drifted.join("\n  ")}`); process.exitCode = 2; return; }
  const manifestSha = manifestSha256(recorded);
  // The expected manifest is anchored outside the working tree (review CP3 NB6): an operator-given hash, else the committed copy.
  const expectedArg = arg("--expect-manifest");
  const committed = await run("git", ["show", "HEAD:packages/verifier/verifier-manifest.json"]);
  let manifestAnchor = "uncommitted working tree (no committed manifest to anchor to)";
  if (expectedArg !== undefined) {
    if (expectedArg !== manifestSha) { console.error(`controller: refusing to run, manifest ${manifestSha} is not the expected ${expectedArg}`); process.exitCode = 2; return; }
    manifestAnchor = "operator-supplied --expect-manifest";
  } else if (committed.exit === 0) {
    if (manifestSha256(JSON.parse(committed.stdout) as Manifest) !== manifestSha) {
      console.error("controller: refusing to run, the working-tree manifest differs from the committed one"); process.exitCode = 2; return;
    }
    manifestAnchor = "committed HEAD:packages/verifier/verifier-manifest.json";
  }
  const runId = `gate-a-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const outDir = `${ROOT}.work/v3/gate-a/${runId}`;
  mkdirSync(outDir, { recursive: true });
  log(`controller: run ${runId}, manifest ${manifestSha}`);
  let verificationExit = 1;
  let summary: Record<string, unknown> | undefined;
  let verificationQualified = false;
  process.exitCode = 1; // qualification is provisional until finalization succeeds
  try {
    await compose(["build"], 1_800_000);
    await compose(["up", "-d", "--wait", "postgres", "faultproxy", "candidate"], 600_000);
    await waitForPostgres();
    await bootstrap();
    const images = Object.fromEntries(((JSON.parse((await compose(["images", "--format", "json"])).stdout || "[]")) as Array<{ Repository?: string; Tag?: string; ID?: string; ContainerName?: string }>)
      .map(i => [i.ContainerName ?? `${i.Repository ?? "?"}:${i.Tag ?? "?"}`, `${i.Repository ?? "?"}:${i.Tag ?? "?"}@${i.ID ?? "?"}`]));
    const git = await run("git", ["rev-parse", "HEAD"]), dirty = (await run("git", ["status", "--porcelain"])).stdout.trim() !== "";
    const environment: RunReport["environment"] = {
      candidateNode: (await candidateShell(["node", "-v"])).stdout.trim(),
      postgresVersion: await withClient("postgres", async c => String((await c.query("SHOW server_version")).rows[0].server_version)),
      images, controllerNode: process.version, manifestSha256: manifestSha, sourceCommit: `${git.stdout.trim()}${dirty ? "+dirty" : ""}`,
      subjectSha256: subjectTreeSha(), manifestAnchor };
    const reports: RunReport[] = [];
    for (let n = 1; n <= runs; n++) reports.push(await runOnce(n, runId, manifestSha, environment));
    const q = qualification(reports, { expectedManifestSha256: manifestSha, requestedRuns: runs, filtered: !!only || !!onlyCandidate });
    const { comparison, acceptance } = q;
    verificationQualified = q.qualifying;
    summary = { runId, partial: q.partial, qualifying: false, verificationQualified, qualificationReasons: q.reasons,
      cleanup: { status: "PENDING" }, manifestSha256: manifestSha, environment, comparison, acceptance: acceptance.map(a => ({ accepted: a.accepted, reasons: a.reasons })),
      validity: reports.map(r => r.validity), statuses: reports.map(r => Object.fromEntries(Object.entries(r.candidates).map(([k, rs]) => [k, Object.fromEntries(rs.map(x => [x.id, x.status]))]))),
      negativeControls: reports.map(r => Object.fromEntries(r.negativeControls.map(nc => [nc.id, nc.observed]))) };
    writeFileSync(`${outDir}/summary.json`, redact(JSON.stringify(summary, null, 2)));
    log(`controller: validity ${reports.map(r => r.validity).join(",")}; accepted ${acceptance.map(a => a.accepted).join(",")}; compareForced same=${comparison.same}`);
    for (const d of comparison.differences) log(`  differs: ${d}`);
    const smokeOk = reports.every(r => Object.values(r.candidates).every(rs => rs.every(x => x.status === "PASS" || x.status === "NOT_APPLICABLE")));
    verificationExit = only || onlyCandidate ? (smokeOk ? 0 : 1) : (q.qualifying ? 0 : 1);
  } finally {
    const finalized = await cleanup({
      evidence: async () => {
        // Attempt every evidence source even if one command or write fails.
        const results = await Promise.allSettled([
          compose(["logs", "--no-color", "postgres"], 30_000).then(r => { writeFileSync(`${outDir}/postgres.log`, redact(r.stdout)); }),
          Promise.resolve().then(() => { writeFileSync(`${outDir}/claims.jsonl`, claims.map(c => redact(JSON.stringify(c))).join("\n")); }),
          control("GET", "/events").then(events => { proxyEvents.push(...events as unknown[]); })
            .finally(() => { writeFileSync(`${outDir}/proxy-events.json`, redact(JSON.stringify(proxyEvents, null, 2))); }),
        ]);
        const failed = results.filter(r => r.status === "rejected");
        if (failed.length) throw new AggregateError(failed.map(r => r.reason), "evidence collection failed");
      },
      observers: closeObservers,
      down: () => run("docker", [...COMPOSE, "down", "-v", "--remove-orphans"], { timeoutMs: 300_000 }),
      inventory,
      record: result => {
        writeFileSync(`${outDir}/cleanup.json`, redact(JSON.stringify(result, null, 2)));
        if (summary) writeFileSync(`${outDir}/summary.json`, redact(JSON.stringify({ ...summary,
          qualifying: verificationQualified && result.ok, cleanup: result }, null, 2)));
      },
    });
    process.exitCode = finalized.ok ? verificationExit : 1;
    log(`controller: cleanup ${finalized.ok ? "PASS" : "FAIL"}; ${finalized.errors.join("; ")}; evidence in .work/v3/gate-a/${runId}/`);
  }
}

await main();
