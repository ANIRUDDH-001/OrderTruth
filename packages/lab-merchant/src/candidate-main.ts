/**
 * Gate A candidate entry point (plan Task 8). Runs ONE command in the unprivileged candidate container and prints ONE JSON
 * line, {"claim": …, "pid": …}. The line is a claim only: the verifier decides from its own observer SQL, never from this.
 *
 *   node packages/lab-merchant/src/candidate-main.ts '<json>'      (or 'b64:<base64 of the JSON>', which avoids shell quoting)
 *   {candidate, op: "checkout_return" | "webhook" | "construct" | "recover", intentId?, observationId?, barrierKey?, claimBarrierKey?,
 *    crashAt?: "beforeCommit", merchantDb?: "merchant_a" | "merchant_b", guardMode?: "verifier" | "off", paypalEnv?, resolveDeadlineMs?}
 *
 * Environment: PGHOST_OP/PGPORT_OP (the fault proxy), PGHOST_AUX/PGPORT_AUX (PostgreSQL directly), PGUSER, PGPASSWORD,
 * OT_TEST_AUTHORITY_KEY and OT_CAPABILITY_KEY (hex, per run, never printed), ORDERTRUTH_GUARD_MODE=verifier.
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { createGuard, type Guard, type GuardOptions } from "../../guard/src/guard.ts";
import { createTestCaptureAuthority, type SyntheticFixture } from "../../guard/src/testing/index.ts";
import type { GuardConfig } from "../../guard/src/config.ts";
import type { Handler, MerchantDeps } from "./types.ts";
import { V_A_CONFIG } from "./v-a/ordertruth.config.ts";

type Input = { candidate: string; op: "checkout_return" | "webhook" | "construct" | "recover"; intentId?: string; observationId?: string;
  barrierKey?: number; claimBarrierKey?: number; crashAt?: "beforeCommit"; merchantDb?: "merchant_a" | "merchant_b";
  guardMode?: "verifier" | "off"; paypalEnv?: string; resolveDeadlineMs?: number };
type CandidateModule = { handleCheckoutReturn: Handler; handleCaptureWebhook: Handler; config?: GuardConfig };

const MODULES: Record<string, string> = {
  ORIGINAL: "./v-a/original.ts", REFERENCE_FIX: "./v-a/reference-fix.ts",
  NC1: "./nc/nc1-event-id-dedup.ts", NC2: "./nc/nc2-suppress.ts", NC3: "./nc/nc3-key-on-path.ts", NC6: "./nc/nc6-hardcoded-capture.ts",
  NC7: "./nc/nc7-oracle-probe.ts", NC8: "./nc/nc8-fake-evidence.ts", NC9: "./nc/nc9-lying-returning.ts", NC10: "./nc/nc10-dml-cte.ts", NC12: "./nc/nc12-fake-report.ts",
};
const USES_GUARD = new Set(["REFERENCE_FIX", "NC6", "NC7", "NC9", "NC10"]);
const OPS = new Set(["checkout_return", "webhook", "construct", "recover"]);

const emit = (claim: unknown) => console.log(JSON.stringify({ claim, pid: process.pid }));
const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`candidate: ${name} is not set`);
  return v;
};
const key = (name: string) => {
  const k = Buffer.from(env(name), "hex");
  if (k.length < 32) throw new Error(`candidate: ${name} must be at least 32 bytes of hex`);
  return k;
};
const errorClaim = (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error),
  code: (error as { code?: unknown } | null)?.code ?? (error instanceof Error ? error.name : "Error") });

async function main(): Promise<unknown> {
  const raw = process.argv[2] ?? "";
  const input = JSON.parse(raw.startsWith("b64:") ? Buffer.from(raw.slice(4), "base64").toString("utf8") : raw) as Input;
  const path = MODULES[input.candidate];
  if (!path) throw new Error(`candidate: unknown candidate ${String(input.candidate)}`);
  if (!OPS.has(input.op)) throw new Error(`candidate: unknown op ${String(input.op)}`);
  const merchantB = input.merchantDb === "merchant_b";
  const merchantId = merchantB ? "SYN-M-B" : "SYN-M-A";
  const base = { user: env("PGUSER"), password: env("PGPASSWORD"), database: merchantB ? env("PGDATABASE_B", "merchant_b") : env("PGDATABASE_A", "merchant_a"),
    connectionTimeoutMillis: 5000 };
  const aux = { ...base, host: env("PGHOST_AUX"), port: Number(env("PGPORT_AUX", "5432")) };
  const opPool = new pg.Pool({ ...base, host: env("PGHOST_OP"), port: Number(env("PGPORT_OP", "6432")), max: 4 });
  const auxPool = new pg.Pool({ ...aux, max: 2 });
  opPool.on("error", () => {}); auxPool.on("error", () => {});
  const testKey = key("OT_TEST_AUTHORITY_KEY"), capabilityKey = key("OT_CAPABILITY_KEY");
  if (input.guardMode === "off") delete process.env.ORDERTRUTH_GUARD_MODE;
  const verifier = process.env.ORDERTRUTH_GUARD_MODE === "verifier";
  let guard: Guard | undefined;
  try {
    const mod = await import(path) as CandidateModule;
    /** Blocks on the verifier's advisory lock `k` (on its own direct connection), then lets go immediately. */
    const barrier = (k: number | undefined) => async () => {
      if (k === undefined) return;
      const c = new pg.Client({ ...aux, application_name: "ot-barrier" });
      await c.connect();
      try { await c.query("SELECT pg_advisory_lock($1)", [k]); await c.query("SELECT pg_advisory_unlock($1)", [k]); } finally { await c.end(); }
    };
    const testHooks: NonNullable<GuardOptions["testHooks"]> = {
      ...(input.claimBarrierKey !== undefined ? { afterClaim: barrier(input.claimBarrierKey) } : {}),
      ...(input.crashAt === "beforeCommit" ? { beforeCommit: async () => { process.kill(process.pid, "SIGKILL"); } } : {}) };
    const auxUrl = `postgres://${encodeURIComponent(base.user)}:${encodeURIComponent(base.password)}@${aux.host}:${aux.port}/${encodeURIComponent(base.database)}`;
    const makeGuard = () => createGuard({ pool: opPool, auxConnectionString: auxUrl, auxMax: 2, merchantId, buildId: "gate-a-lab",
      paypalEnv: (input.paypalEnv ?? "sandbox") as "sandbox", capabilityKey, config: mod.config ?? V_A_CONFIG, freshnessMs: 365 * 24 * 3600_000,
      timeouts: { lockMs: 5000, statementMs: 10_000, connectionMs: 5000 }, resolveDeadlineMs: input.resolveDeadlineMs ?? 5000,
      ...(verifier ? { acceptTestAuthority: true, testAuthorityKey: testKey } : {}), testHooks });

    if (input.op === "construct") { guard = await makeGuard(); return { ok: true, constructed: true }; }
    if (input.op === "recover") { guard = await makeGuard(); return { ok: true, recovered: await guard.recoverPending({ olderThanMs: 0 }) }; }

    if (!input.intentId || !input.observationId) throw new Error("candidate: intentId and observationId are required");
    const fixture = JSON.parse(readFileSync(new URL("../../guard/fixtures/synthetic-fixture.json", import.meta.url), "utf8")) as SyntheticFixture;
    const authority = createTestCaptureAuthority({ pools: { op: opPool, aux: auxPool }, merchantId, fixture, key: testKey });
    const capability = await authority.issue(input.observationId);
    if (USES_GUARD.has(input.candidate)) guard = await makeGuard();
    const deps: MerchantDeps = { pool: opPool, afterCheck: barrier(input.barrierKey), capability, issue: id => authority.issue(id), ...(guard ? { guard } : {}) };
    const handler = input.op === "checkout_return" ? mod.handleCheckoutReturn : mod.handleCaptureWebhook;
    return await handler(deps, { intentId: input.intentId, observationId: input.observationId });
  } finally {
    await guard?.close().catch(() => {});
    await Promise.all([opPool.end().catch(() => {}), auxPool.end().catch(() => {})]);
  }
}

main().then(claim => { emit(claim); process.exit(0); }, error => { emit(errorClaim(error)); process.exit(0); });
