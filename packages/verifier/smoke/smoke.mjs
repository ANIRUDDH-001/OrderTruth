// Gate A Checkpoint 0 smoke run (docs/superpowers/plans/2026-10-30-ordertruth-v3-gate-a.md, Task 0.2).
// Runs only inside the disposable smoke container: Node 22.18.0, postgres:18 on an internal network.
// Writes /out/smoke.json and exits 0 only if every assertion holds.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";

const results = { startedAt: new Date().toISOString(), assertions: {}, details: {} };
const assert = (name, ok, detail) => { results.assertions[name] = Boolean(ok); if (detail !== undefined) results.details[name] = detail; };
const connect = async (database, applicationName) => {
  const client = new pg.Client({ host: process.env.PGHOST, user: process.env.PGUSER, password: process.env.PGPASSWORD,
    database, application_name: applicationName, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
  await client.connect();
  return client;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MERCHANT = "SYN-M-A";
const row = (payee, capture, intent, callId) => [MERCHANT, "sandbox", payee, capture, intent, callId];
const INSERT = `INSERT INTO ordertruth_guard.obligations (merchant_id, operation_kind, paypal_env, payee_merchant_id, capture_id, intent_id,
    claimed_by_call_id, origin, fingerprint, authority, provenance, contract_version, sdk_version, path_id, site_id, build_id)
  VALUES ($1, 'CREATE_ORDER', $2, $3, $4, $5, $6, 'NEW', 'smoke', 'TEST', 'SYNTHETIC_FIXTURE', 'OT_V3_OBLIGATION@0.1.0', 'smoke', 'smoke', 'smoke', 'smoke')
  ON CONFLICT (merchant_id, operation_kind, obligation_key) DO NOTHING
  RETURNING obligation_key`;

let admin;
let database;
try {
  // 1–2. Runtime and pinned package manager (pnpm version recorded during the frozen-lockfile image build).
  assert("node_22_18_0", process.version === "v22.18.0", process.version);
  const pnpmVersion = readFileSync("/app/.pnpm-version", "utf8").trim();
  assert("pnpm_11_4_0_frozen_install", pnpmVersion === "11.4.0", pnpmVersion);

  // 3. PostgreSQL 18.
  admin = await connect("postgres", "ot-smoke-admin");
  const version = (await admin.query("SELECT version() AS v")).rows[0].v;
  assert("postgres_18", /PostgreSQL 18\./.test(version), version);

  // 4. The exact migration applies to a fresh database (twice: it must be idempotent).
  database = `otg_${randomBytes(10).toString("hex")}`;
  await admin.query(`CREATE DATABASE ${database}`);
  const a = await connect(database, "ot-smoke-A");
  const sql = readFileSync("/app/packages/guard/sql/guard-v1.sql", "utf8");
  let migrationError = null;
  try { await a.query(sql); await a.query(sql); } catch (error) { migrationError = `${error.code ?? ""} ${error.message}`; }
  assert("guard_v1_applies", migrationError === null, migrationError ?? "applied twice");
  if (migrationError !== null) throw new Error(`migration failed: ${migrationError}`);
  await a.query("INSERT INTO ordertruth_guard.installation (merchant_id) VALUES ($1)", [MERCHANT]);

  // 5. Fixed key vectors (the Task 1 vectors), plus the collision probe.
  const vectors = [
    { payee: "SYN-PAYEE-1", capture: "SYN-CAP-1", intent: "SYN-INT-1", expected: "v1|P1|7:sandbox|11:SYN-PAYEE-1|9:SYN-CAP-1|7:primary" },
    { payee: "SYN-PAYEE-1", capture: "\u{1D11E}a", intent: "SYN-INT-2", expected: "v1|P1|7:sandbox|11:SYN-PAYEE-1|2:\u{1D11E}a|7:primary" },
    { payee: "a|1:b", capture: "c", intent: "SYN-INT-3", expected: "v1|P1|7:sandbox|5:a|1:b|1:c|7:primary" },
  ];
  const observed = [];
  for (const v of vectors) {
    const r = await a.query(INSERT, row(v.payee, v.capture, v.intent, `smoke-${v.intent}`));
    observed.push({ expected: v.expected, actual: r.rows[0]?.obligation_key ?? null });
  }
  assert("key_vectors_match", observed.every(o => o.actual === o.expected), observed);
  const sibling = await a.query(INSERT, row("a", "1:b|c", "SYN-INT-4", "smoke-SYN-INT-4"));
  const siblingKey = sibling.rows[0]?.obligation_key ?? null;
  assert("collision_probe_distinct", siblingKey !== null && siblingKey !== vectors[2].expected, { probe: vectors[2].expected, sibling: siblingKey });

  // 6. Concurrent claim on one key: B blocks on A's uncommitted claim, then gets no row after A commits.
  const b = await connect(database, "ot-smoke-B");
  const key = row("SYN-PAYEE-1", "SYN-CAP-9", "SYN-INT-9", "smoke-A-claim");
  await a.query("BEGIN");
  const claimA = await a.query(INSERT, key);
  const bClaim = b.query(INSERT, [...key.slice(0, 5), "smoke-B-claim"]).then(r => ({ rowCount: r.rowCount }), e => ({ error: `${e.code} ${e.message}` }));
  let sawLockWait = false;
  for (let i = 0; i < 100 && !sawLockWait; i++) {
    const w = await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND application_name = 'ot-smoke-B' AND wait_event_type = 'Lock'", [database]);
    sawLockWait = w.rowCount === 1;
    if (!sawLockWait) await sleep(100);
  }
  await a.query("COMMIT");
  const resultB = await bClaim;
  const count = (await a.query("SELECT count(*)::int AS n, min(claimed_by_call_id) AS by FROM ordertruth_guard.obligations WHERE capture_id = 'SYN-CAP-9'")).rows[0];
  assert("claim_a_inserted", claimA.rowCount === 1, claimA.rowCount);
  assert("claim_b_waited_on_lock", sawLockWait);
  assert("claim_b_no_row_after_commit", resultB.rowCount === 0 && !resultB.error, resultB);
  assert("exactly_one_obligation", count.n === 1 && count.by === "smoke-A-claim", count);
  await a.end();
  await b.end();
} catch (error) {
  results.error = `${error.code ?? ""} ${error.message}`.trim();
} finally {
  if (admin && database) { try { await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); results.droppedDatabase = database; } catch (error) { results.dropError = error.message; } }
  if (admin) await admin.end().catch(() => {});
  results.finishedAt = new Date().toISOString();
  results.passed = !results.error && Object.values(results.assertions).length >= 10 && Object.values(results.assertions).every(Boolean);
  writeFileSync("/out/smoke.json", `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify({ passed: results.passed, assertions: results.assertions, error: results.error ?? null }));
  process.exitCode = results.passed ? 0 : 1;
}
