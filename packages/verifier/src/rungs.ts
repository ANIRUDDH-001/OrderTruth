/**
 * Gate A rungs (plan Task 10 rung table). Each rung's verdict comes only from the observer's own SQL, the proxy's event log,
 * the trusted PostgreSQL log and exit statuses of commands the controller runs; a candidate's stdout counts only through
 * assertClaimCorroborated. Every rung starts from fresh databases cloned from the templates; steps within a rung share state.
 * The check names are exactly REQUIRED_CHECKS (report.ts), so acceptance can require each one.
 */
import { readFileSync } from "node:fs";
import type pg from "pg";
import { holdBarrier, waitForLockWait } from "./barrier.ts";
import { assertClaimCorroborated, assertObligationsBackedByOrders, assertOneMatchingOrder, snapshot, type Claim, type StateSnapshot } from "./observer.ts";
import type { Check, Observed, RungId, RungResult } from "./report.ts";

export type CandidateId = "ORIGINAL" | "REFERENCE_FIX" | "NC1" | "NC2" | "NC3" | "NC6" | "NC7" | "NC8" | "NC9" | "NC10" | "NC12";
export type Db = "merchant_a" | "merchant_b";
export type CandidateInput = { candidate: CandidateId; op: "checkout_return" | "webhook" | "construct" | "recover"; intentId?: string; observationId?: string;
  barrierKey?: number; claimBarrierKey?: number; crashAt?: "beforeCommit"; merchantDb?: Db; guardMode?: "verifier" | "off"; paypalEnv?: string; resolveDeadlineMs?: number };
/** A candidate's stdout claim, untrusted: every field is optional and checked before use. */
export type HandlerClaim = { ok?: unknown; orderId?: unknown; created?: unknown; guardOutcome?: unknown; callId?: unknown; code?: unknown; error?: unknown;
  constructed?: unknown; recovered?: unknown };
export type ExecResult = { claim: HandlerClaim | null; exit: number | null };
export type ProxyRule = { boundary: "ISSUANCE" | "OPERATION" | "REJECTION_AUDIT"; mode: "drop-commit-ack" | "drop-before-commit" | "hold-commit" };
export type L0Shared = { packages_typecheck: Verdict; offline_tests: Verdict };
type Verdict = { ok: boolean; detail: string };

export interface RungContext {
  fresh(dbs?: Db[]): Promise<void>;
  observer(db?: Db): pg.Pool;
  exec(input: CandidateInput): Promise<ExecResult>;
  candidateShell(argv: string[]): Promise<{ exit: number | null; stdout: string }>;
  proxy: { arm(rule: ProxyRule): Promise<void>; release(): Promise<void>; reset(): Promise<void>; events(): Promise<Array<{ boundary: string | null; action: string }>> };
  service(action: "pause" | "unpause" | "stop" | "start" | "restart", name: "postgres" | "faultproxy"): Promise<void>;
  /** Count of trusted PostgreSQL log lines in which ot_candidate was denied the verifier_oracle schema. */
  oracleDenials(): Promise<number>;
  l0(): Promise<L0Shared>;
  /** Verifies, repairing if needed, that PostgreSQL and the fault proxy are up; throws if they can't be restored. */
  ensureHealthy(): Promise<void>;
  random(): number;
  seed: string;
  record(name: string, value: unknown): void;
}

type Observation = { observationId: string; intentId: string; captureId: string; amountMinor: string; currency: string; paypalOrderId: string };
const FIXTURE = JSON.parse(readFileSync(new URL("../../guard/fixtures/synthetic-fixture.json", import.meta.url), "utf8")) as { observations: Observation[] };
const OBS = (id: string) => { const o = FIXTURE.observations.find(x => x.observationId === id); if (!o) throw new Error(`rungs: unknown observation ${id}`); return o; };
const expected = (id: string) => { const o = OBS(id); return { captureId: o.captureId, amountMinor: o.amountMinor, currency: o.currency, paypalOrderId: o.paypalOrderId }; };
const S = (name: string, v: Verdict, observed?: Observed): Check => ({ name, kind: "independent_state", ok: v.ok, detail: v.detail, ...(observed ? { observed } : {}) });
const T = (name: string, v: Verdict, observed?: Observed): Check => ({ name, kind: "trusted_log", ok: v.ok, detail: v.detail, ...(observed ? { observed } : {}) });
/** The facts an order check observed: how many orders the intent has, and the code the deciding claim reported. */
const orderFacts = (s: StateSnapshot, intentId: string, r?: ExecResult): Observed => ({ orders: (s.ordersByIntent[intentId] ?? []).length, claimCode: str(r?.claim?.code) ?? null });
const unbacked = (s: StateSnapshot) => {
  const ids = new Set(Object.values(s.ordersByIntent).flat().map(o => o.id));
  return s.obligations.filter(o => o.resultId === null || !ids.has(o.resultId)).length;
};
const all = (...vs: Verdict[]): Verdict => ({ ok: vs.every(v => v.ok), detail: vs.map(v => v.detail).join("; ") });
const verdict = (ok: boolean, detail: string): Verdict => ({ ok, detail });
const done = (id: RungId, checks: Check[], extra: Partial<RungResult> = {}): RungResult =>
  ({ id, status: checks.length > 0 && checks.every(c => c.ok) ? "PASS" : "FAIL", checks, ...extra });
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const order = (candidate: CandidateId, op: "checkout_return" | "webhook", observationId: string, extra: Partial<CandidateInput> = {}): CandidateInput =>
  ({ candidate, op, intentId: OBS(observationId).intentId, observationId, ...extra });

/** The claim the controller derives from stdout: guarded if it names a guard outcome and call, state-only if it names an order. */
export function claimFrom(c: HandlerClaim | null, observationId: string): Claim | null {
  if (!c) return null;
  const o = OBS(observationId), outcome = str(c.guardOutcome), callId = str(c.callId), orderId = c.ok === true ? str(c.orderId) : undefined;
  if (outcome && callId && ["CREATED", "REUSED", "IDENTITY_CONFLICT", "REJECTED"].includes(outcome))
    return { kind: "guarded", guardOutcome: outcome as "CREATED", callId, ...(orderId ? { orderId } : {}), intentId: o.intentId, captureId: o.captureId };
  if (orderId) return { kind: "state_only", orderId, intentId: o.intentId, captureId: o.captureId };
  return null;
}
function corroborated(r: ExecResult, observationId: string, s: StateSnapshot): Verdict {
  const claim = claimFrom(r.claim, observationId);
  return claim ? assertClaimCorroborated(claim, s) : verdict(false, `no corroborable claim (exit ${String(r.exit)}, claim ${JSON.stringify(r.claim)})`);
}
async function waitForEvent(ctx: RungContext, action: string, boundary: string, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (!(await ctx.proxy.events()).some(e => e.action === action && e.boundary === boundary)) {
    if (Date.now() > end) throw new Error(`rungs: no proxy event ${boundary}/${action} within ${timeoutMs} ms`);
    await sleep(100);
  }
}
const hasEvent = async (ctx: RungContext, action: string, boundary: string) => (await ctx.proxy.events()).some(e => e.action === action && e.boundary === boundary);
const ordersFor = (s: StateSnapshot, intentId: string) => (s.ordersByIntent[intentId] ?? []).length;
const maxOrders = (s: StateSnapshot) => Math.max(0, ...Object.values(s.ordersByIntent).map(os => os.length));
const markerOf = (s: StateSnapshot, callId: string | undefined) => s.markers.find(m => m.callId === callId);
const intentOf = (s: StateSnapshot, callId: string | undefined) => s.intents.find(i => i.callId === callId);
/** The single OPERATION intent that has no marker: the call whose COMMIT was faulted. */
function faultedIntent(s: StateSnapshot) {
  const open = s.intents.filter(i => i.boundary === "OPERATION" && !s.markers.some(m => m.callId === i.callId));
  return open.length === 1 ? open[0] : undefined;
}
const recovered = (r: ExecResult) => (Array.isArray(r.claim?.recovered) ? r.claim.recovered as Array<{ callId?: unknown; state?: unknown }> : []);
async function snap(ctx: RungContext, label: string, db?: Db) { const s = await snapshot(ctx.observer(db)); ctx.record(label, s); return s; }

// ---- L0: supported runtime, qualification tools, control-API isolation, guard construction ----
async function L0(ctx: RungContext, candidate: CandidateId): Promise<RungResult> {
  const shared = await ctx.l0();
  const node = await ctx.candidateShell(["node", "-v"]);
  // The control API is on the proxy container's loopback: from the candidate the proxy's data port must open (positive control)
  // and its control port must refuse the connection outright (review CP3 NB3: a DNS failure would prove nothing).
  const probe = await ctx.candidateShell(["node", "-e",
    "const net=require('net');const data=new Promise(r=>{const s=net.connect(6432,'faultproxy',()=>{s.destroy();r('data:open')});s.on('error',e=>r('data:'+e.code))});"
    + "const ctl=fetch('http://faultproxy:7070/events',{signal:AbortSignal.timeout(3000)}).then(r=>'control:reachable-'+r.status,e=>'control:'+(e.cause?.code??e.name));"
    + "Promise.all([data,ctl]).then(([d,c])=>{console.log(d+' '+c);process.exit(d==='data:open'&&c==='control:ECONNREFUSED'?3:0)})"]);
  // The templates and the maintenance databases must refuse the candidate (review CP3 B1).
  const templates = await ctx.candidateShell(["node", "-e",
    "const pg=require('pg');const go=d=>{const c=new pg.Client({host:process.env.PGHOST_AUX,port:+process.env.PGPORT_AUX,user:process.env.PGUSER,"
    + "password:process.env.PGPASSWORD,database:d,connectionTimeoutMillis:5000});return c.connect().then(()=>c.end().then(()=>d+':connected'),e=>d+':'+(e.code||'error'))};"
    + "Promise.all(['merchant_template','merchant_b_template','postgres','template1'].map(go)).then(r=>{console.log(r.join(' '));"
    + "process.exit(r.every(x=>/:(55000|42501)$/.test(x))?3:0)})"]);
  await ctx.fresh();
  const r = await ctx.exec({ candidate, op: "construct" });
  const s = await snap(ctx, `${candidate}-L0`);
  const constructed = r.claim?.ok === true && r.claim.constructed === true;
  return done("L0", [
    T("candidate_node", verdict(node.exit === 0 && node.stdout.trim() === "v22.18.0", `candidate node ${node.stdout.trim()} (exit ${String(node.exit)})`)),
    T("packages_typecheck", shared.packages_typecheck),
    T("offline_tests", shared.offline_tests),
    T("control_api_unreachable", verdict(probe.exit === 3 && probe.stdout.trim() === "data:open control:ECONNREFUSED", `candidate → faultproxy: ${probe.stdout.trim()} (exit ${String(probe.exit)})`)),
    T("templates_unreachable", verdict(templates.exit === 3, `candidate → ${templates.stdout.trim()} (exit ${String(templates.exit)})`)),
    S("guard_constructs", verdict(constructed && s.obligations.length === 0 && Object.keys(s.ordersByIntent).length === 0,
      `construct claim ${JSON.stringify(r.claim)}; ${s.obligations.length} obligations, ${Object.keys(s.ordersByIntent).length} intents with orders`),
      { claimCode: str(r.claim?.code) ?? null, constructed, obligations: s.obligations.length }),
  ]);
}

// ---- L1: one checkout_return ----
async function L1(ctx: RungContext, candidate: CandidateId): Promise<RungResult> {
  await ctx.fresh();
  const before = await ctx.oracleDenials();
  const r = await ctx.exec(order(candidate, "checkout_return", "SYN-OBS-1"));
  const s = await snap(ctx, `${candidate}-L1`);
  await sleep(500);                                    // let the server's log lines reach the trusted log
  const denials = (await ctx.oracleDenials()) - before;
  const checks = [
    S("one_matching_order", assertOneMatchingOrder(s, "SYN-INT-1", expected("SYN-OBS-1")), orderFacts(s, "SYN-INT-1", r)),
    S("obligations_backed_by_orders", assertObligationsBackedByOrders(s), { unbacked: unbacked(s) }),
    S("claim_corroborated", corroborated(r, "SYN-OBS-1", s)),
    T("oracle_not_probed", verdict(denials === 0, `${denials} oracle access denial(s) for ot_candidate in the trusted PostgreSQL log`), { probed: denials > 0 }),
  ];
  if (candidate === "NC12") {
    const out = await ctx.candidateShell(["test", "!", "-e", "/out"]);
    checks.push(T("report_not_writable", verdict(out.exit === 0, `/out absent in the candidate: exit ${String(out.exit)}`)));
  }
  return done("L1", checks);
}

// ---- L3: return then webhook, and webhook then return ----
function reuseCorroborated(first: ExecResult, second: ExecResult, observationId: string, s: StateSnapshot): Verdict {
  const c2 = claimFrom(second.claim, observationId), firstOrder = str(first.claim?.orderId);
  if (!c2) return verdict(false, `second call made no corroborable claim: ${JSON.stringify(second.claim)}`);
  if (c2.kind === "guarded") {
    if (c2.guardOutcome !== "REUSED") return verdict(false, `second call was ${c2.guardOutcome}, not REUSED`);
    if (c2.orderId !== firstOrder) return verdict(false, `reused order ${String(c2.orderId)} differs from the first ${String(firstOrder)}`);
    return assertClaimCorroborated(c2, s);
  }
  if (second.claim?.created !== false || c2.orderId !== firstOrder) return verdict(false, `second call created ${String(second.claim?.created)}, order ${c2.orderId} vs ${String(firstOrder)}`);
  return assertClaimCorroborated(c2, s);
}
async function L3(ctx: RungContext, candidate: CandidateId): Promise<RungResult> {
  const checks: Check[] = [];
  for (const [observationId, first, second] of [["SYN-OBS-1", "checkout_return", "webhook"], ["SYN-OBS-2", "webhook", "checkout_return"]] as const) {
    await ctx.fresh();
    const intentId = OBS(observationId).intentId;
    const a = await ctx.exec(order(candidate, first, observationId)), b = await ctx.exec(order(candidate, second, observationId));
    const s = await snap(ctx, `${candidate}-L3-${intentId}`);
    checks.push(S(`one_matching_order:${intentId}`, assertOneMatchingOrder(s, intentId, expected(observationId)), orderFacts(s, intentId, b)),
      S(`reuse_corroborated:${intentId}`, reuseCorroborated(a, b, observationId, s)));
  }
  return done("L3", checks);
}

// ---- L4: the V-A race, forced by barriers; then a stress run ----
const K1 = 7001, K2 = 7002;
async function L4(ctx: RungContext, candidate: CandidateId): Promise<RungResult> {
  await ctx.fresh();
  const guarded = candidate !== "ORIGINAL";
  const observer = ctx.observer();
  const k1 = await holdBarrier(observer, K1), k2 = guarded ? await holdBarrier(observer, K2) : undefined;
  let results: ExecResult[];
  try {
    const extra = { barrierKey: K1, ...(guarded ? { claimBarrierKey: K2 } : {}) };
    const both = Promise.all([ctx.exec(order(candidate, "checkout_return", "SYN-OBS-1", extra)), ctx.exec(order(candidate, "webhook", "SYN-OBS-1", extra))]);
    await k1.waitForWaiters(2, 30_000);
    await k1.release();
    if (k2) {                                          // the first claimer holds its claim at K2; the second must be blocked on it
      await k2.waitForWaiters(1, 30_000);
      await waitForLockWait(observer, "ot:OPERATION", 30_000);
      await k2.release();
    }
    results = await both;
  } finally { await k1.release(); await k2?.release(); }
  const s = await snap(ctx, `${candidate}-L4-forced`);
  const forcedOne = assertOneMatchingOrder(s, "SYN-INT-1", expected("SYN-OBS-1"));
  const each = results.map(r => corroborated(r, "SYN-OBS-1", s));
  const outcomes = results.map(r => str(r.claim?.guardOutcome) ?? (r.claim?.created === true ? "created" : String(r.claim?.created))).sort();
  const outcomesOk = guarded ? verdict(outcomes.join(",") === "CREATED,REUSED" && each.every(v => v.ok), `outcomes ${outcomes.join(",")}; ${each.map(v => v.detail).join("; ")}`)
    : all(...each);
  const checks = [S("forced:one_matching_order", forcedOne, orderFacts(s, "SYN-INT-1")), S("forced:outcomes_corroborated", outcomesOk)];
  if (!guarded) return done("L4", checks, forcedOne.ok ? {} : { reproduced: "forced" });

  await ctx.fresh();
  const delays = Array.from({ length: 8 }, () => Math.floor(ctx.random() * 250));
  const stress = await Promise.all(delays.map((d, k) => sleep(d).then(() => ctx.exec(order(candidate, k % 2 ? "webhook" : "checkout_return", "SYN-OBS-1")))));
  const s2 = await snap(ctx, `${candidate}-L4-stress`);
  // Every caller must settle cleanly: exactly one CREATED, the other seven REUSED, all corroborated (review CP3 NB5).
  const exits = stress.map(r => r.exit), stressOutcomes = stress.map(r => str(r.claim?.guardOutcome) ?? String(r.claim?.code));
  const each2 = stress.map(r => corroborated(r, "SYN-OBS-1", s2));
  const settled = verdict(exits.every(e => e === 0) && stressOutcomes.filter(o => o === "CREATED").length === 1 && stressOutcomes.filter(o => o === "REUSED").length === 7
    && each2.every(v => v.ok), `8 callers, delays ${delays.join("/")} ms, exits ${exits.join(",")}, outcomes ${stressOutcomes.join(",")}`);
  checks.push(S("stress:one_matching_order", all(assertOneMatchingOrder(s2, "SYN-INT-1", expected("SYN-OBS-1")), settled)));
  return done("L4", checks, { seed: ctx.seed });
}

// ---- L5: a crash before COMMIT, recovery, retry ----
async function L5(ctx: RungContext, candidate: CandidateId): Promise<RungResult> {
  await ctx.fresh();
  const crashed = await ctx.exec(order(candidate, "checkout_return", "SYN-OBS-1", { crashAt: "beforeCommit" }));
  const s1 = await snap(ctx, `${candidate}-L5-crashed`);
  const pending = s1.intents.filter(i => i.boundary === "OPERATION" && i.resolvedState === null);
  const left = verdict(s1.obligations.length === 0 && ordersFor(s1, "SYN-INT-1") === 0 && !s1.outboxKinds.claimed && !s1.markers.some(m => m.boundary === "OPERATION"),
    `exit ${String(crashed.exit)}; ${s1.obligations.length} obligations, ${ordersFor(s1, "SYN-INT-1")} orders, ${s1.outboxKinds.claimed ?? 0} claimed events, operation markers ${s1.markers.filter(m => m.boundary === "OPERATION").length}`);
  const evidence = verdict(s1.captureEvidence.some(e => e.captureId === "SYN-CAP-1") && s1.markers.some(m => m.boundary === "ISSUANCE"), `${s1.captureEvidence.length} evidence row(s)`);
  const unresolved = verdict(pending.length === 1, `${pending.length} unresolved OPERATION intent(s) before recovery`);
  const rec = await ctx.exec({ candidate, op: "recover" });
  const s2 = await snap(ctx, `${candidate}-L5-recovered`);
  const callId = pending[0]?.callId;
  const resolved = verdict(!!callId && intentOf(s2, callId)?.resolvedState === "NOT_COMMITTED_ESTABLISHED"
    && recovered(rec).some(x => x.callId === callId && x.state === "NOT_COMMITTED_ESTABLISHED"), `intent ${String(callId)} → ${String(intentOf(s2, callId)?.resolvedState)}`);
  const retry = await ctx.exec(order(candidate, "checkout_return", "SYN-OBS-1"));
  const s3 = await snap(ctx, `${candidate}-L5-retried`);
  return done("L5", [S("crashed_call_left_nothing", left), S("issuance_evidence_present", evidence), S("intent_unresolved_until_recovery", unresolved),
    S("recovery_not_committed_established", resolved),
    S("retry_one_matching_order", all(assertOneMatchingOrder(s3, "SYN-INT-1", expected("SYN-OBS-1")), corroborated(retry, "SYN-OBS-1", s3)))]);
}

// ---- L7: two intents, each with its own capture ----
async function L7(ctx: RungContext, candidate: CandidateId): Promise<RungResult> {
  await ctx.fresh();
  const one = await ctx.exec(order(candidate, "checkout_return", "SYN-OBS-1"));
  const two = await ctx.exec(order(candidate, "checkout_return", "SYN-OBS-2"));
  const s = await snap(ctx, `${candidate}-L7`);
  return done("L7", [S("one_matching_order:SYN-INT-1", assertOneMatchingOrder(s, "SYN-INT-1", expected("SYN-OBS-1")), orderFacts(s, "SYN-INT-1", one)),
    S("one_matching_order:SYN-INT-2", assertOneMatchingOrder(s, "SYN-INT-2", expected("SYN-OBS-2")), orderFacts(s, "SYN-INT-2", two))]);
}

// ---- L9: identity conflicts, primary key and secondary index ----
async function L9(ctx: RungContext, candidate: CandidateId): Promise<RungResult> {
  await ctx.fresh();
  await ctx.exec(order(candidate, "checkout_return", "SYN-OBS-1"));
  const amended = await ctx.exec(order(candidate, "webhook", "SYN-OBS-1B"));
  const s = await snap(ctx, `${candidate}-L9-primary`);
  const c = claimFrom(amended.claim, "SYN-OBS-1B");
  const conflict = c?.kind === "guarded" && c.guardOutcome === "IDENTITY_CONFLICT" ? assertClaimCorroborated(c, s) : verdict(false, `claim ${JSON.stringify(amended.claim)}`);
  const payload = (await ctx.observer().query<{ payload: { attempted?: { fingerprint?: unknown }; existing?: { fingerprint?: unknown } } }>(
    "SELECT payload FROM ordertruth_guard.outbox WHERE kind = 'conflict' AND call_id = $1", [str(amended.claim?.callId) ?? ""])).rows[0]?.payload;
  const fa = payload?.attempted?.fingerprint, fe = payload?.existing?.fingerprint;
  const fingerprints = verdict(typeof fa === "string" && typeof fe === "string" && fa !== fe, `attempted ${String(fa)}, existing ${String(fe)}`);
  await ctx.fresh();
  await ctx.exec(order(candidate, "checkout_return", "SYN-OBS-1"));
  const second = await ctx.exec(order(candidate, "webhook", "SYN-OBS-4"));
  const s2 = await snap(ctx, `${candidate}-L9-secondary`);
  const c2 = claimFrom(second.claim, "SYN-OBS-4");
  return done("L9", [
    S("conflict_primary", conflict),
    S("orders_unchanged_primary", assertOneMatchingOrder(s, "SYN-INT-1", expected("SYN-OBS-1"))),
    S("conflict_fingerprints", fingerprints),
    S("conflict_secondary", c2?.kind === "guarded" && c2.guardOutcome === "IDENTITY_CONFLICT" ? assertClaimCorroborated(c2, s2) : verdict(false, `claim ${JSON.stringify(second.claim)}`)),
    S("no_claim_secondary_capture", verdict(!s2.obligations.some(o => o.captureId === "SYN-CAP-4") && ordersFor(s2, "SYN-INT-1") === 1,
      `${s2.obligations.filter(o => o.captureId === "SYN-CAP-4").length} SYN-CAP-4 obligation(s), ${ordersFor(s2, "SYN-INT-1")} SYN-INT-1 order(s)`)),
  ]);
}

// ---- L21: lost acknowledgements, dropped and held COMMITs, a paused and a restarted database ----
async function L21(ctx: RungContext, candidate: CandidateId): Promise<RungResult> {
  const checks: Check[] = [];
  const peak: number[] = [];
  const subcase = async (label: string) => { await ctx.fresh(); await ctx.proxy.reset(); return label; };

  await subcase("a");
  await ctx.proxy.arm({ boundary: "OPERATION", mode: "drop-commit-ack" });
  const a = await ctx.exec(order(candidate, "checkout_return", "SYN-OBS-1"));
  let s = await snap(ctx, `${candidate}-L21-a`); peak.push(maxOrders(s));
  const aCall = str(a.claim?.callId);
  checks.push(S("a:committed_from_marker", verdict(await hasEvent(ctx, "commit-ack-dropped", "OPERATION") && markerOf(s, aCall)?.outcome === "CREATED"
    && intentOf(s, aCall)?.resolvedState === "COMMITTED" && corroborated(a, "SYN-OBS-1", s).ok, `call ${String(aCall)}: marker ${String(markerOf(s, aCall)?.outcome)}, intent ${String(intentOf(s, aCall)?.resolvedState)}`)),
    S("a:one_order", assertOneMatchingOrder(s, "SYN-INT-1", expected("SYN-OBS-1"))));

  await subcase("b");
  await ctx.proxy.arm({ boundary: "OPERATION", mode: "drop-before-commit" });
  const b = await ctx.exec(order(candidate, "checkout_return", "SYN-OBS-1"));
  s = await snap(ctx, `${candidate}-L21-b`); peak.push(maxOrders(s));
  const dropped = s.intents.filter(i => i.boundary === "OPERATION" && i.resolvedState === "NOT_COMMITTED_ESTABLISHED");
  checks.push(S("b:not_committed_established", verdict(await hasEvent(ctx, "commit-dropped-before-server", "OPERATION") && b.claim?.code === "NotCommittedEstablished"
    && dropped.length === 1 && !markerOf(s, dropped[0]?.callId) && ordersFor(s, "SYN-INT-1") === 0, `claim code ${String(b.claim?.code)}; ${dropped.length} established intent(s); ${ordersFor(s, "SYN-INT-1")} orders`)));
  const retry = await ctx.exec(order(candidate, "checkout_return", "SYN-OBS-1"));
  s = await snap(ctx, `${candidate}-L21-b-retry`); peak.push(maxOrders(s));
  checks.push(S("b:retry_one_order", all(assertOneMatchingOrder(s, "SYN-INT-1", expected("SYN-OBS-1")), corroborated(retry, "SYN-OBS-1", s))));

  await subcase("c");
  await ctx.proxy.arm({ boundary: "OPERATION", mode: "hold-commit" });
  const held = ctx.exec(order(candidate, "checkout_return", "SYN-OBS-1"));
  await waitForEvent(ctx, "commit-held", "OPERATION");
  const whileHeld = await ctx.exec({ candidate, op: "recover", resolveDeadlineMs: 300 });
  s = await snap(ctx, `${candidate}-L21-c-held`);
  const heldIntent = faultedIntent(s);
  checks.push(S("c:still_unknown_while_held", verdict(!!heldIntent && heldIntent.resolvedState === null
    && recovered(whileHeld).some(x => x.callId === heldIntent.callId && x.state === "STILL_UNKNOWN"), `held intent ${String(heldIntent?.callId)}; recover ${JSON.stringify(recovered(whileHeld))}`)));
  await ctx.proxy.release();
  const c = await held;
  s = await snap(ctx, `${candidate}-L21-c-released`); peak.push(maxOrders(s));
  checks.push(S("c:resolved_after_release", verdict(intentOf(s, heldIntent?.callId)?.resolvedState === "COMMITTED" && markerOf(s, heldIntent?.callId)?.outcome === "CREATED"
    && assertOneMatchingOrder(s, "SYN-INT-1", expected("SYN-OBS-1")).ok && corroborated(c, "SYN-OBS-1", s).ok, `intent → ${String(intentOf(s, heldIntent?.callId)?.resolvedState)}`)));

  await subcase("d");
  await ctx.proxy.arm({ boundary: "OPERATION", mode: "hold-commit" });
  const paused = ctx.exec(order(candidate, "checkout_return", "SYN-OBS-1", { resolveDeadlineMs: 300 }));
  await waitForEvent(ctx, "commit-held", "OPERATION");
  let d: ExecResult;
  await ctx.service("pause", "postgres");
  try { await ctx.service("stop", "faultproxy"); d = await paused; } finally { await ctx.service("unpause", "postgres"); await ctx.service("start", "faultproxy"); }
  s = await snap(ctx, `${candidate}-L21-d`); peak.push(maxOrders(s));
  const dIntent = faultedIntent(s);
  // Once the database is back, a new process resolves the call from durable records: the held COMMIT never reached the server.
  const dRecovered = await ctx.exec({ candidate, op: "recover" });
  const s2 = await snap(ctx, `${candidate}-L21-d-recovered`);
  checks.push(S("d:still_unknown_paused", verdict(d.claim?.code === "CommitOutcomeUnknown" && !!dIntent && dIntent.resolvedState === null && ordersFor(s, "SYN-INT-1") === 0
    && recovered(dRecovered).some(x => x.callId === dIntent.callId && x.state === "NOT_COMMITTED_ESTABLISHED") && ordersFor(s2, "SYN-INT-1") === 0,
    `claim code ${String(d.claim?.code)}; intent ${String(dIntent?.callId)} ${String(dIntent?.resolvedState)}; ${ordersFor(s, "SYN-INT-1")} orders; `
    + `recovered ${JSON.stringify(recovered(dRecovered))}`)));

  await subcase("e");
  await ctx.proxy.arm({ boundary: "ISSUANCE", mode: "drop-commit-ack" });
  const e = await ctx.exec(order(candidate, "checkout_return", "SYN-OBS-1"));
  s = await snap(ctx, `${candidate}-L21-e`); peak.push(maxOrders(s));
  const issuance = s.markers.filter(m => m.boundary === "ISSUANCE");
  checks.push(S("e:issuance_committed", verdict(await hasEvent(ctx, "commit-ack-dropped", "ISSUANCE") && issuance.length === 1
    && intentOf(s, issuance[0]?.callId)?.resolvedState === "COMMITTED" && s.captureEvidence.some(x => x.captureId === "SYN-CAP-1")
    && str(e.claim?.guardOutcome) === "CREATED" && corroborated(e, "SYN-OBS-1", s).ok, `issuance intent ${String(intentOf(s, issuance[0]?.callId)?.resolvedState)}; claim ${String(e.claim?.guardOutcome)}`)));

  await subcase("f");
  await ctx.proxy.arm({ boundary: "OPERATION", mode: "hold-commit" });
  const restarted = ctx.exec(order(candidate, "checkout_return", "SYN-OBS-1", { resolveDeadlineMs: 300 }));
  await waitForEvent(ctx, "commit-held", "OPERATION");
  await ctx.service("restart", "postgres");
  const f = await restarted;
  const afterRestart = await ctx.exec({ candidate, op: "recover", resolveDeadlineMs: 300 });
  s = await snap(ctx, `${candidate}-L21-f`); peak.push(maxOrders(s));
  const fIntent = faultedIntent(s);
  checks.push(S("f:still_unknown_after_restart", verdict(f.claim?.code === "CommitOutcomeUnknown" && !!fIntent && fIntent.resolvedState === null
    && recovered(afterRestart).some(x => x.callId === fIntent.callId && x.state === "STILL_UNKNOWN") && ordersFor(s, "SYN-INT-1") === 0,
    `claim code ${String(f.claim?.code)}; recover ${JSON.stringify(recovered(afterRestart))}; ${ordersFor(s, "SYN-INT-1")} orders`)));

  checks.push(S("never_two_orders", verdict(peak.every(n => n <= 1), `most orders for one intent per step: ${peak.join(",")}`)));
  return done("L21", checks);
}

// ---- L22: two tenants with identical local intent and capture IDs ----
async function L22(ctx: RungContext, candidate: CandidateId): Promise<RungResult> {
  await ctx.fresh(["merchant_a", "merchant_b"]);
  await ctx.exec(order(candidate, "checkout_return", "SYN-OBS-1", { merchantDb: "merchant_a" }));
  await ctx.exec(order(candidate, "checkout_return", "SYN-OBS-1", { merchantDb: "merchant_b" }));
  const a = await snap(ctx, `${candidate}-L22-a`, "merchant_a"), b = await snap(ctx, `${candidate}-L22-b`, "merchant_b");
  const shared = a.outboxEventIds.filter(id => b.outboxEventIds.includes(id));
  const installed = async (db: Db) => (await ctx.observer(db).query<{ merchant_id: string }>("SELECT merchant_id FROM ordertruth_guard.installation")).rows.map(r => r.merchant_id);
  const [ia, ib] = [await installed("merchant_a"), await installed("merchant_b")];
  return done("L22", [
    S("event_ids_distinct", verdict(a.outboxEventIds.length > 0 && b.outboxEventIds.length > 0 && shared.length === 0, `${a.outboxEventIds.length} and ${b.outboxEventIds.length} events, ${shared.length} shared`)),
    S("installations_correct", verdict(ia.join() === "SYN-M-A" && ib.join() === "SYN-M-B" && ordersFor(a, "SYN-INT-1") === 1 && ordersFor(b, "SYN-INT-1") === 1,
      `installations ${ia.join()} / ${ib.join()}; orders ${ordersFor(a, "SYN-INT-1")} / ${ordersFor(b, "SYN-INT-1")}`)),
  ]);
}

// ---- AUTH: a guard outside verifier mode given a test capability; a live guard ----
async function AUTH(ctx: RungContext, candidate: CandidateId): Promise<RungResult> {
  await ctx.fresh();
  const r = await ctx.exec(order(candidate, "checkout_return", "SYN-OBS-1", { guardMode: "off" }));
  const s = await snap(ctx, `${candidate}-AUTH`);
  const callId = str(r.claim?.callId), c = claimFrom(r.claim, "SYN-OBS-1");
  const audit = (await ctx.observer().query(`SELECT 1 FROM ordertruth_guard.outbox o JOIN ordertruth_guard.outbox_deliveries d USING (event_id)
    WHERE o.kind = 'rejected' AND o.call_id = $1 AND o.payload->>'reason' = 'TEST_AUTHORITY'`, [callId ?? ""])).rowCount;
  const live = await ctx.exec({ candidate, op: "construct", paypalEnv: "live" });
  const s2 = await snap(ctx, `${candidate}-AUTH-live`);
  return done("AUTH", [
    S("test_authority_rejected", c?.kind === "guarded" && c.guardOutcome === "REJECTED" && r.claim?.code === "TEST_AUTHORITY" && markerOf(s, callId)?.boundary === "REJECTION_AUDIT"
      ? assertClaimCorroborated(c, s) : verdict(false, `claim ${JSON.stringify(r.claim)}`)),
    S("audit_evidence_present", verdict(audit === 1 && s.obligations.length === 0, `${String(audit)} audit event(s), ${s.obligations.length} obligations`)),
    S("live_guard_refused", verdict(live.claim?.ok === false && /sandbox only/.test(String(live.claim?.error)) && s2.obligations.length === 0, `claim ${JSON.stringify(live.claim)}`)),
  ]);
}

export const RUNGS: Record<RungId, (ctx: RungContext, candidate: CandidateId) => Promise<RungResult>> = { L0, L1, L3, L4, L5, L7, L9, L21, L22, AUTH };
/** The unguarded original is run only where the guard isn't the subject: its forced L4 duplicate is the run's positive control. */
export const ORIGINAL_RUNGS: readonly RungId[] = ["L0", "L1", "L3", "L4", "L7"];

/** A candidate run that never reached the database (no claim, name or connection errors, an exhausted pool): an infrastructure fault. */
const TRANSPORT = /EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|no operation connection within the pool timeout|Connection terminated/;
const transportFailure = (input: CandidateInput, r: ExecResult) => !input.crashAt
  && (r.claim === null || TRANSPORT.test(`${String(r.claim.code)} ${String(r.claim.error)}`));

/**
 * Runs one rung after a health check. Outside L21 (whose faults are deliberate and whose checks name the expected codes), any
 * candidate run that failed at the transport level makes the rung INFRA_ERROR, so a broken environment can never pass for a
 * candidate's defect — in particular, a negative control can't be "rejected as intended" because nothing could connect.
 */
export async function runRung(ctx: RungContext, id: RungId, candidate: CandidateId): Promise<RungResult> {
  const infra = (detail: string): Check => ({ name: "infrastructure", kind: "trusted_log", ok: false, detail });
  const faults: string[] = [];
  const watched: RungContext = { ...ctx, exec: async input => {
    const r = await ctx.exec(input);
    if (id !== "L21" && transportFailure(input, r)) faults.push(`${input.op} ${input.intentId ?? ""}: exit ${String(r.exit)}, ${JSON.stringify(r.claim)}`);
    return r;
  } };
  try {
    await ctx.ensureHealthy();
    const result = await RUNGS[id](watched, candidate);
    return faults.length ? { ...result, status: "INFRA_ERROR", checks: [...result.checks, infra(`transport failures: ${faults.join(" | ")}`)] } : result;
  } catch (error) {
    return { id, status: "INFRA_ERROR", checks: [infra(error instanceof Error ? error.message : String(error))] };
  }
}
