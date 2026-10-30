import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CommitEvidenceInconsistent, CommitOutcomeUnknown, NotCommittedEstablished, recoverPending, resolveCall, runGuardTx,
  type GuardPools, type OutcomeRecord } from "../../packages/guard/src/commit.ts";
import { migrateGuard } from "../../packages/guard/src/schema.ts";
import { startFaultProxy, type FaultProxy } from "../../packages/verifier/src/proxy.ts";
import { createDisposableDatabase, type DisposableDatabase } from "./harness.ts";
import { runChild } from "./setup.ts";

let db: DisposableDatabase, proxy: FaultProxy, pools: GuardPools;
const previousMode = process.env.ORDERTRUTH_GUARD_MODE;
const opConfig = (): pg.PoolConfig => ({ ...db.config, host: "127.0.0.1", port: proxy.port, max: 4, connectionTimeoutMillis: 5000 });
const auxConfig = (): pg.PoolConfig => ({ ...db.config, max: 2, connectionTimeoutMillis: 5000 });
beforeAll(async () => {
  process.env.ORDERTRUTH_GUARD_MODE = "verifier";
  db = await createDisposableDatabase();
  await migrateGuard(db.client, "SYN-M-A");
  await db.client.query("CREATE TABLE public.effects (call_id text PRIMARY KEY)");
  proxy = await startFaultProxy({ listenPort: 0, controlPort: 0, target: { host: String(db.config.host), port: Number(db.config.port) } });
  pools = { op: new pg.Pool(opConfig()), aux: new pg.Pool(auxConfig()) };
  // Backends are terminated on purpose in these tests; an idle pooled client's error must not crash the run.
  pools.op.on("error", () => {}); pools.aux.on("error", () => {});
});
afterEach(() => { proxy.release(); proxy.reset(); });
afterAll(async () => {
  await pools?.op.end(); await pools?.aux.end(); await proxy?.close(); await db?.drop();
  if (previousMode === undefined) delete process.env.ORDERTRUTH_GUARD_MODE; else process.env.ORDERTRUTH_GUARD_MODE = previousMode;
});

const effect = async (tx: pg.PoolClient, { callId }: { callId: string }) => {
  await tx.query("INSERT INTO public.effects (call_id) VALUES ($1)", [callId]);
  return { value: `value-${callId}`, outcomeRecord: { outcome: "TEST_EFFECT", callId } as OutcomeRecord };
};
/** The test boundary's mandatory confirmation: the recorded outcome names this call and its effect row exists. */
const confirm = async (r: OutcomeRecord, aux: pg.PoolClient) =>
  r.outcome === "TEST_EFFECT" && typeof r.callId === "string" && (await aux.query("SELECT 1 FROM public.effects WHERE call_id = $1", [r.callId])).rowCount === 1;
const identity = { merchantId: "SYN-M-A", test: true };
const until = async (check: () => boolean | Promise<boolean>, ms = 5000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error("timed out"); await new Promise(r => setTimeout(r, 20)); } };
const marker = async (callId: string) => (await db.client.query("SELECT outcome_record FROM ordertruth_guard.commit_markers WHERE call_id = $1", [callId])).rows[0];
const effectExists = async (callId: string) => (await db.client.query("SELECT 1 FROM public.effects WHERE call_id = $1", [callId])).rowCount === 1;
const heldIntent = async () => (await db.client.query<{ call_id: string; backend_pid: number }>(
  `SELECT i.call_id, i.backend_pid FROM ordertruth_guard.commit_intents i LEFT JOIN ordertruth_guard.commit_markers m USING (call_id)
   WHERE m.call_id IS NULL AND i.resolved_state IS NULL ORDER BY i.created_at DESC LIMIT 1`)).rows[0]!;
const backendGone = async (pid: number) => (await db.client.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid])).rowCount === 0;

describe("commit journal and resolution (spec §5.3e)", () => {
  it("committed marker resolves without backend termination", async () => {
    const r = await runGuardTx(pools, "OPERATION", identity, effect, { confirm });
    expect(r.resolved).toBeUndefined();
    const resolved = await resolveCall(pools, r.callId, { deadlineMs: 300, confirm });   // the pooled backend is still alive and idle
    expect(resolved.state).toBe("COMMITTED");
    expect(resolved.outcomeRecord).toMatchObject({ outcome: "TEST_EFFECT", callId: r.callId, boundary: "OPERATION", merchantId: "SYN-M-A", identity });
  });

  it("lost ack after server commit resolves COMMITTED from durable marker", async () => {
    proxy.arm({ boundary: "OPERATION", mode: "drop-commit-ack" });
    const r = await runGuardTx(pools, "OPERATION", identity, effect, { confirm });
    expect(r.resolved).toBe(true);
    expect(r.value).toBe(`value-${r.callId}`);
    expect((await marker(r.callId))?.outcome_record).toMatchObject({ outcome: "TEST_EFFECT", callId: r.callId, boundary: "OPERATION" });
    expect(await effectExists(r.callId)).toBe(true);
    expect(proxy.events().some(e => e.action === "commit-ack-dropped")).toBe(true);
  });

  it("commit never reached server resolves NOT_COMMITTED_ESTABLISHED after fresh read", async () => {
    proxy.arm({ boundary: "OPERATION", mode: "drop-before-commit" });
    let callId = "";
    const error = await runGuardTx(pools, "OPERATION", identity, async (tx, ctx) => { callId = ctx.callId; return effect(tx, ctx); }, { confirm }).then(() => null, e => e);
    expect(error).toBeInstanceOf(NotCommittedEstablished);
    expect(await marker(callId)).toBeUndefined();
    expect(await effectExists(callId)).toBe(false);
    expect((await db.client.query("SELECT resolved_state FROM ordertruth_guard.commit_intents WHERE call_id = $1", [callId])).rows[0].resolved_state).toBe("NOT_COMMITTED_ESTABLISHED");
  });

  it("marker absent, then commit-and-exit, then backend gone, resolves COMMITTED", async () => {
    proxy.arm({ boundary: "OPERATION", mode: "hold-commit" });
    const pending = runGuardTx(pools, "OPERATION", identity, effect, { confirm });
    await until(() => proxy.events().some(e => e.action === "commit-held"));
    const intent = await heldIntent();
    const resolved = await resolveCall(pools, intent.call_id, { deadlineMs: 5000, confirm, hooks: { afterFirstMarkerRead: async () => {
      // The first read saw no marker. Now let the transaction commit, and its backend exit, before termination is checked.
      proxy.release();
      await until(() => proxy.events().some(e => e.action === "commit-complete" && e.boundary === "OPERATION"));
      await db.client.query("SELECT pg_terminate_backend($1)", [intent.backend_pid]);
      await until(() => backendGone(intent.backend_pid));
    } } });
    expect(resolved.state).toBe("COMMITTED");                        // only a fresh marker read after termination can see this
    expect(await effectExists(intent.call_id)).toBe(true);
    await pending.then(() => {}, e => { expect(e).not.toBeInstanceOf(NotCommittedEstablished); });
  });

  it("backend alive stays STILL_UNKNOWN", async () => {
    proxy.arm({ boundary: "OPERATION", mode: "hold-commit" });
    const pending = runGuardTx(pools, "OPERATION", identity, effect, { confirm });
    await until(() => proxy.events().some(e => e.action === "commit-held"));
    const intent = await heldIntent();
    expect((await resolveCall(pools, intent.call_id, { deadlineMs: 300, confirm })).state).toBe("STILL_UNKNOWN");
    proxy.release();
    await pending;
    expect((await resolveCall(pools, intent.call_id, { deadlineMs: 300, confirm })).state).toBe("COMMITTED");
  });

  it("invisible backend stays unknown", async () => {
    await db.client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ot_limited') THEN CREATE ROLE ot_limited LOGIN PASSWORD 'ot-limited-disposable'; END IF; END $$`);
    await db.client.query(`GRANT USAGE ON SCHEMA ordertruth_guard TO ot_limited; GRANT SELECT ON ordertruth_guard.commit_intents, ordertruth_guard.commit_markers TO ot_limited`);
    const limited = new pg.Pool({ ...auxConfig(), user: "ot_limited", password: "ot-limited-disposable" });
    try {
      // First prove the permission behaviour this test relies on: ot_limited can't see another role's backend_start.
      const probe = await pools.op.connect();
      const pid = (await probe.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      expect((await limited.query("SELECT backend_start FROM pg_stat_activity WHERE pid = $1", [pid])).rows[0]?.backend_start ?? null).toBeNull();
      probe.release();
      proxy.arm({ boundary: "OPERATION", mode: "hold-commit" });
      const pending = runGuardTx(pools, "OPERATION", identity, effect, { confirm });
      await until(() => proxy.events().some(e => e.action === "commit-held"));
      const intent = await heldIntent();
      const resolved = await resolveCall({ op: pools.op, aux: limited }, intent.call_id, { deadlineMs: 300, confirm });
      expect(resolved.state).toBe("STILL_UNKNOWN");
      expect(resolved.reason).toMatch(/visibility/);
      proxy.release();
      await pending;
    } finally { await limited.end(); }
  });

  it("contradictory xact status raises inconsistent", async () => {
    const r = await runGuardTx(pools, "OPERATION", identity, effect, { confirm });
    const resolved = await resolveCall(pools, r.callId, { deadlineMs: 300, confirm, hooks: { xactStatusOverride: async () => "aborted" } });
    expect(resolved.state).toBe("STILL_UNKNOWN");
    expect(resolved.reason).toMatch(/COMMIT_EVIDENCE_INCONSISTENT/);
    proxy.arm({ boundary: "OPERATION", mode: "drop-commit-ack" });
    const error = await runGuardTx(pools, "OPERATION", identity, effect, { confirm, hooks: { xactStatusOverride: async () => "aborted" } }).then(() => null, e => e);
    expect(error).toBeInstanceOf(CommitEvidenceInconsistent);
  });

  it("db unreachable stays unknown", async () => {
    const dead = new pg.Pool({ ...auxConfig(), host: "127.0.0.1", port: 1, connectionTimeoutMillis: 500 });
    const live: GuardPools = { op: pools.op, aux: pools.aux };
    proxy.arm({ boundary: "OPERATION", mode: "drop-commit-ack" });
    const error = await runGuardTx(live, "OPERATION", identity, effect, { confirm, hooks: { beforeCommit: async () => { live.aux = dead; } } }).then(() => null, e => e);
    expect(error).toBeInstanceOf(CommitOutcomeUnknown);
    expect((error as CommitOutcomeUnknown).reason).toMatch(/unreachable/);
    await dead.end();
  });

  it("refuses to resolve as COMMITTED without a mandatory confirmation", async () => {
    const r = await runGuardTx(pools, "OPERATION", identity, effect, { confirm });
    expect((await resolveCall(pools, r.callId, { deadlineMs: 300 })).state).toBe("STILL_UNKNOWN");
    expect((await resolveCall(pools, r.callId, { deadlineMs: 300, confirm: async () => false })).state).toBe("STILL_UNKNOWN");
  });

  it("resolution after process restart uses only durable records", async () => {
    const child = fileURLToPath(new URL("./commit-restart-child.ts", import.meta.url));
    for (const [mode, expected] of [["drop-commit-ack", "COMMITTED"], ["drop-before-commit", "NOT_COMMITTED_ESTABLISHED"]] as const) {
      proxy.arm({ boundary: "OPERATION", mode });
      // Async spawn: the fault proxy lives in this process, so a blocking spawnSync would stop it accepting the child's connection.
      const run = await runChild(child, JSON.stringify({ op: { ...opConfig(), max: undefined }, aux: { ...auxConfig(), max: undefined } }));
      const line = run.stdout.trim().split("\n").pop() ?? "";
      const out = JSON.parse(line) as { exited?: string; callId?: string };
      expect(out.exited, `stdout: ${run.stdout}\nstderr: ${run.stderr}`).toBe("commit-failure");
      const recovered = await recoverPending(pools, { olderThanMs: 0, deadlineMs: 5000, confirm });
      const mine = recovered.find(x => x.callId === out.callId);
      expect(mine?.state, mode).toBe(expected);
      if (expected === "COMMITTED") expect(mine?.outcomeRecord).toMatchObject({ outcome: "TEST_EFFECT", callId: out.callId });
      expect(await effectExists(out.callId!)).toBe(expected === "COMMITTED");
      proxy.reset();
    }
  });
});
