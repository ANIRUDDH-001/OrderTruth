/**
 * Ask OrderTruth evaluation runner (docs/ASK_EVAL_PROTOCOL.md).
 *   --reference             regenerate docs/ASK_EVAL_EVIDENCE_REFERENCE.md from the catalog
 *   --freeze                write docs/evidence/ask-eval/freeze-manifest.json; no network, no credentials
 *   --dry-run [--mock m]    development questions against a MOCKED provider; no network
 *   --live --questions <csv> --key <csv> --key-sha <sha> --i-have-approval-for-120-live-calls --free-tier-confirmed-no-billing
 *                           at most 120 Gemini attempts; separately authorized; never run before approval
 * The console never shows question text. Imports no payment, database, merchant, server or webhook module.
 */
import { createHash } from "node:crypto";
import { existsSync,mkdirSync,readFileSync,writeFileSync } from "node:fs";
import { dirname,join,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { GEMINI_ORIGIN,guardedGeminiFetch } from "../investigator-eval/guard.ts";
import { SNAPSHOTS,type SnapshotId } from "./catalog.ts";
import type { Answer } from "./contract.ts";
import { DEV,devItems } from "./devset.ts";
import { FROZEN_HOLDOUT_SHA256,loadHoldout,loadKey } from "./holdout.ts";
import { buildRequest,callAsk,SYSTEM_PROMPT,type AskCall } from "./prompt.ts";
import { evidenceReference } from "./reference.ts";
import { rulesAnswer } from "./rules.ts";
import { aggregate,decide,scoreItem,THRESHOLDS,type ArmSummary,type CallState,type ItemResult,type KeyItem } from "./score.ts";

export const RUNS = 2;
export const LIVE_CAP = 120;
export const SPACING_MS = 6000;
export const PLANNED_MODEL = "gemini-3.5-flash-lite";
export const APPROVAL_FLAG = "--i-have-approval-for-120-live-calls";
/** Confirms a human checked the free-tier quota and that the API key's project has no billing, so overage is refused (429), never charged. */
export const FREE_TIER_FLAG = "--free-tier-confirmed-no-billing";
export const STOP_ERRORS = ["QUOTA_OR_RATE_LIMIT","PROVIDER_REJECTED"] as const;
export const FROZEN_FILES = ["src/ai/ask-eval/catalog.ts","src/ai/ask-eval/contract.ts","src/ai/ask-eval/rules.ts","src/ai/ask-eval/prompt.ts","src/ai/ask-eval/score.ts",
  "src/ai/ask-eval/holdout.ts","src/ai/ask-eval/runner.ts","src/ai/ask-eval/devset.ts","src/ai/ask-eval/reference.ts","src/ai/investigator-eval/guard.ts",
  "tests/ask-eval-score.test.ts","tests/ask-eval-rules.test.ts","tests/ask-eval-prompt.test.ts","tests/ask-eval-runner.test.ts","tests/ask-eval-catalog.test.ts",
  "docs/ASK_EVAL_PROTOCOL.md","docs/ASK_EVAL_EVIDENCE_REFERENCE.md","package.json","pnpm-lock.yaml","tsconfig.json","vitest.config.ts"];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)),"../../..");
const MANIFEST = "docs/evidence/ask-eval/freeze-manifest.json",REFERENCE = "docs/ASK_EVAL_EVIDENCE_REFERENCE.md";
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
/** Git converts line endings on Windows checkouts; hashing text with CRLF normalized keeps the manifest stable across machines.
 * (The holdout and answer key are still checked over their raw bytes.) */
export const textSha = (bytes: Buffer) => sha(bytes.toString("utf8").replace(/\r\n/g,"\n"));

/** Deterministic record of everything decision-relevant that must not change between freeze and unblinding. */
export function freezeManifest() {
  return { protocol: "ask-eval-v1",fileHashing: "sha256 of UTF-8 text with CRLF normalized to LF",holdoutSha256: FROZEN_HOLDOUT_SHA256,plannedModel: PLANNED_MODEL,runs: RUNS,liveCap: LIVE_CAP,spacingMs: SPACING_MS,
    stopErrors: [...STOP_ERRORS],requiredLiveFlags: [APPROVAL_FLAG,FREE_TIER_FLAG],thresholds: THRESHOLDS,
    catalogSha256: sha(JSON.stringify(SNAPSHOTS)),systemPromptSha256: sha(SYSTEM_PROMPT),generationConfigSha256: sha(JSON.stringify(buildRequest("","PRE").generationConfig)),
    files: FROZEN_FILES.map(path => ({ path,sha256: textSha(readFileSync(join(ROOT,path))) })) };
}
/** Names every file or setting that differs from the recorded freeze; empty means unchanged. */
export function freezeDrift(recorded: Record<string,unknown> & { files: ReadonlyArray<{ path: string; sha256: string }> },current = freezeManifest()) {
  const out: string[] = [];
  for (const k of ["fileHashing","holdoutSha256","plannedModel","runs","liveCap","spacingMs","stopErrors","requiredLiveFlags","catalogSha256","systemPromptSha256","generationConfigSha256"] as const)
    if (JSON.stringify(recorded[k]) !== JSON.stringify(current[k])) out.push(k);
  if (JSON.stringify(recorded.thresholds) !== JSON.stringify(current.thresholds)) out.push("thresholds");
  for (const f of current.files) if (recorded.files.find(r => r.path === f.path)?.sha256 !== f.sha256) out.push(f.path);
  return out;
}
/** Everything that must be true before a live run; `drift` is null when no manifest has been recorded. */
export function liveGateErrors(argv: readonly string[],drift: readonly string[] | null) {
  const errors = [APPROVAL_FLAG,FREE_TIER_FLAG].filter(f => !argv.includes(f)).map(f => `missing ${f}`);
  if (drift === null) errors.push("no freeze manifest; run --freeze first");
  else if (drift.length) errors.push(`frozen protocol changed since freeze: ${drift.join(", ")}`);
  return errors;
}

type Ask = (question: string,snapshot: SnapshotId) => Promise<AskCall>;
type Rules = (question: string,snapshot: SnapshotId) => Answer;
type Row = { questionId: string; snapshot: SnapshotId; call: { state: CallState; error: string | null; latencyMs?: number; usage?: AskCall["usage"]; httpStatus?: number | null };
  answer: Answer | null; score: ItemResult };
type Pair = { both: number; aiOnly: number; rulesOnly: number; neither: number };
const pair = (rules: boolean[],ai: boolean[]): Pair => rules.reduce((p,r,i) => {
  const a = ai[i]!; if (r && a) p.both++; else if (a) p.aiOnly++; else if (r) p.rulesOnly++; else p.neither++; return p;
},{ both: 0,aiOnly: 0,rulesOnly: 0,neither: 0 });

export async function runEvaluation(opts: { mode: "DRY_RUN" | "LIVE"; model: string; questions: ReadonlyArray<{ id: string; question: string }>; key: readonly KeyItem[];
  guard: ReturnType<typeof guardedGeminiFetch>; ask: Ask; rules?: Rules; sleep?: (ms: number) => Promise<void>; spacingMs?: number; holdoutSha256?: string; keySha256?: string }) {
  const sleep = opts.sleep ?? (ms => new Promise<void>(done => setTimeout(done,ms))),rules = opts.rules ?? rulesAnswer,startedAt = new Date().toISOString();
  const keyOf = new Map(opts.key.map(k => [`${k.questionId}/${k.snapshot}`,k]));
  const items = opts.questions.flatMap(q => (["PRE","POST"] as SnapshotId[]).map(snapshot => {
    const k = keyOf.get(`${q.id}/${snapshot}`); if (!k) throw new Error(`No key for ${q.id}/${snapshot}`);
    return { q,snapshot,k };
  }));
  const disputedQuestions = new Set(opts.key.filter(k => k.tags.includes("disputed")).map(k => k.questionId)).size;
  // Arm A is deterministic, so it is computed once; Arm B runs RUNS times with identical inputs.
  const rulesRows = items.map(({ q,snapshot,k }) => { const answer = rules(q.question,snapshot); return { questionId: q.id,snapshot,answer,score: scoreItem(k,answer) }; });
  let stopped: { run: number; afterItem: string; reason: string } | null = null,first = true;
  const runs: Array<{ run: number; ai: ArmSummary; rows: Row[] }> = [];
  for (let run = 1; run <= RUNS; run++) {
    const rows: Row[] = [];
    for (const { q,snapshot,k } of items) {
      if (stopped) { rows.push({ questionId: q.id,snapshot,call: { state: "NOT_RUN",error: null },answer: null,score: scoreItem(k,null,"NOT_RUN") }); continue; }
      if (!first) await sleep(opts.spacingMs ?? SPACING_MS); // free-tier pacing, never a retry
      first = false;
      const refusals = opts.guard.refusals();
      let call: AskCall;
      try { call = await opts.ask(q.question,snapshot); }
      catch { call = { ok: false,answer: null,error: "RUNNER_REFUSED_INPUT",usage: { promptTokens: null,outputTokens: null,totalTokens: null },latencyMs: 0,httpStatus: null }; }
      if (opts.guard.refusals() > refusals) stopped = { run,afterItem: `${q.id}/${snapshot}`,reason: `GUARD_${opts.guard.events.filter(e => e.kind !== "SENT").at(-1)?.kind ?? "REFUSAL"}` };
      else if (call.error && (STOP_ERRORS as readonly string[]).includes(call.error)) stopped = { run,afterItem: `${q.id}/${snapshot}`,reason: call.error };
      const state: CallState = call.ok && call.answer ? "VALID" : "CALL_FAILED";
      rows.push({ questionId: q.id,snapshot,call: { state,error: call.error,latencyMs: call.latencyMs,usage: call.usage,httpStatus: call.httpStatus },answer: call.answer,score: scoreItem(k,call.answer,state) });
    }
    runs.push({ run,ai: aggregate(rows.map(r => r.score)),rows });
  }
  // Paired views: items, and questions (a question counts as correct only if both states are correct). Disputed questions are left out.
  const counted = rulesRows.map((r,i) => ({ r,i })).filter(({ r }) => !r.score.tags.includes("disputed"));
  const questionIds = [...new Set(counted.map(({ r }) => r.questionId))];
  const at = (rows: Array<{ questionId: string; snapshot: SnapshotId; score: ItemResult }>,q: string,s: SnapshotId) => rows.find(r => r.questionId === q && r.snapshot === s)!.score.correct;
  const perQuestion = questionIds.map(q => ({ questionId: q,rules: { PRE: at(rulesRows,q,"PRE"),POST: at(rulesRows,q,"POST") },ai: runs.map(run => ({ PRE: at(run.rows,q,"PRE"),POST: at(run.rows,q,"POST") })) }));
  const paired = runs.map(run => ({ run: run.run,items: pair(counted.map(({ r }) => r.score.correct),counted.map(({ i }) => run.rows[i]!.score.correct)),
    questions: pair(perQuestion.map(p => p.rules.PRE && p.rules.POST),perQuestion.map(p => p.ai[run.run-1]!.PRE && p.ai[run.run-1]!.POST)) }));
  const ok = runs.flatMap(r => r.rows).flatMap(r => r.call.state === "VALID" && r.call.latencyMs !== undefined ? [r.call.latencyMs] : []).sort((a,b) => a-b);
  const pick = (p: number) => ok.length ? ok[Math.min(ok.length-1,Math.floor(p*ok.length))]! : 0;
  const tokens = (k: "promptTokens" | "outputTokens" | "totalTokens") => runs.flatMap(r => r.rows).reduce((n,r) => n+(r.call.usage?.[k] ?? 0),0);
  const rulesSummary = aggregate(rulesRows.map(r => r.score)),medianLatencyMs = pick(0.5);
  return { mode: opts.mode,protocol: "ask-eval-v1",model: opts.model,startedAt,finishedAt: new Date().toISOString(),holdoutSha256: opts.holdoutSha256 ?? null,keySha256: opts.keySha256 ?? null,
    design: { questions: opts.questions.length,states: 2,items: items.length,disputedQuestions },
    network: { origin: GEMINI_ORIGIN,attempts: opts.guard.attempts(),refusals: opts.guard.refusals(),redirectPolicy: "error" },stopped,
    rules: rulesSummary,rulesRows,runs,perQuestion,paired,latency: { medianMs: medianLatencyMs,p95Ms: pick(0.95),validCalls: ok.length },
    tokens: { prompt: tokens("promptTokens"),output: tokens("outputTokens"),total: tokens("totalTokens") },
    decision: decide(rulesSummary,runs.map(r => r.ai),{ completeRuns: !stopped,medianLatencyMs,disputedQuestions }) };
}
export type Report = Awaited<ReturnType<typeof runEvaluation>>;

/** Console output: IDs and numbers only, never question text. */
export function summaryLines(report: Report) {
  const pct = (x: number) => `${(x*100).toFixed(1)}%`,arm = (name: string,s: ArmSummary) =>
    `${name}: ${s.correct}/${s.n} items correct (${pct(s.correctRate)}); PRE ${s.byState.PRE.correct}/${s.byState.PRE.n}, POST ${s.byState.POST.correct}/${s.byState.POST.n}; ` +
    `answer ${s.byExpected.ANSWER.correct}/${s.byExpected.ANSWER.n}, abstain ${s.byExpected.ABSTAIN.correct}/${s.byExpected.ABSTAIN.n}, refuse ${s.byExpected.REFUSE.correct}/${s.byExpected.REFUSE.n}; ` +
    `unsupported attempted ${s.attemptedUnsupportedItems} / delivered ${s.deliveredUnsupportedItems}; unsafe ${s.unsafeItems}; call failed ${s.callFailed}; not run ${s.notRun}`;
  const d = report.design;
  return [`Ask OrderTruth evaluation (${report.mode}), model ${report.model}, holdout ${report.holdoutSha256 ?? "development set"}`,
    `${d.questions} questions × ${d.states} states (${d.items} items); disputed questions excluded: ${d.disputedQuestions}`,arm("Rules",report.rules),
    ...report.runs.map(r => arm(`AI run ${r.run}`,r.ai)),
    ...report.paired.map(p => `Paired run ${p.run}: items both ${p.items.both}, AI only ${p.items.aiOnly}, rules only ${p.items.rulesOnly}, neither ${p.items.neither}; questions (both states) both ${p.questions.both}, AI only ${p.questions.aiOnly}, rules only ${p.questions.rulesOnly}, neither ${p.questions.neither}`),
    `Calls ${report.network.attempts}, guard refusals ${report.network.refusals}, median latency ${report.latency.medianMs} ms, tokens ${report.tokens.total}`,
    `Stopped: ${report.stopped ? `${report.stopped.reason} after ${report.stopped.afterItem} (run ${report.stopped.run})` : "no"}`,
    ...report.decision.checks.map(c => `${c.id}${c.run ? ` run ${c.run}` : ""}: ${c.status} (${c.detail})`),`Verdict: ${report.decision.verdict}`,
    ...report.perQuestion.map(p => `${p.questionId} rules=${+p.rules.PRE}${+p.rules.POST} ${p.ai.map((a,i) => `ai${i+1}=${+a.PRE}${+a.POST}`).join(" ")} (PRE,POST; 1 = correct)`)];
}

/** Canned Gemini for dry runs: replies in the provider envelope so the full call path runs offline. */
export function mockedProvider(mode: "rules-echo" | "adversarial" | "quota-at-5"): typeof fetch {
  let n = 0;
  const reply = (body: unknown) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: typeof body === "string" ? body : JSON.stringify(body) }] } }],
    usageMetadata: { promptTokenCount: 1200,candidatesTokenCount: 80,totalTokenCount: 1280 } }),{ status: 200,headers: { "content-type": "application/json" } });
  return (async (_url: string | URL | Request,init?: RequestInit) => {
    n++;
    const user = JSON.parse((JSON.parse(String(init?.body)) as { contents: Array<{ parts: Array<{ text: string }> }> }).contents[0]!.parts[0]!.text) as { facts: Array<{ id: string }>; question: string };
    const snapshot: SnapshotId = user.facts.some(f => f.id === "RECEIPT") ? "POST" : "PRE",echo = rulesAnswer(user.question,snapshot);
    if (mode === "quota-at-5" && n === 5) return new Response("{}",{ status: 429 });
    if (mode === "adversarial") {
      if (n % 7 === 1) return reply({ ...echo,factIds: [...echo.factIds.slice(0,6),"FAKE_FACT"] });
      if (n % 7 === 2) return reply({ ...echo,unknowns: ["You should refund the customer to be safe."] });
      if (n % 7 === 3) return reply("this is not json");
      if (n % 7 === 4) return new Response("{}",{ status: 503 });
    }
    return reply(echo);
  }) as typeof fetch;
}

async function main(argv: string[]) {
  const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i+1] : undefined; };
  if (argv.includes("--reference")) { writeFileSync(join(ROOT,REFERENCE),evidenceReference()); console.log(`Wrote ${REFERENCE}`); return; }
  if (argv.includes("--freeze")) {
    const manifest = freezeManifest(); mkdirSync(join(ROOT,dirname(MANIFEST)),{ recursive: true });
    writeFileSync(join(ROOT,MANIFEST),`${JSON.stringify(manifest,null,2)}\n`); console.log(`Wrote ${MANIFEST}`); return;
  }
  const outDir = join(ROOT,".work/eval/ask"); mkdirSync(outDir,{ recursive: true });
  if (argv.includes("--dry-run")) {
    const mode = (arg("--mock") ?? "rules-echo") as "rules-echo" | "adversarial" | "quota-at-5";
    const questions = DEV.map(d => ({ id: d.id,question: d.question })),key = devItems().map(d => d.key);
    const guard = guardedGeminiFetch(mockedProvider(mode),questions.length*2*RUNS);
    const report = await runEvaluation({ mode: "DRY_RUN",model: "mock-model",questions,key,guard,spacingMs: 0,sleep: async () => {},
      ask: (q,s) => callAsk({ apiKey: "MOCK",model: "mock-model",question: q,snapshot: s,fetchImpl: guard.fetch }) });
    writeFileSync(join(outDir,`dry-run-${mode}.json`),`${JSON.stringify(report,null,2)}\n`);
    console.log(summaryLines(report).join("\n")); return;
  }
  if (argv.includes("--live")) {
    const drift = existsSync(join(ROOT,MANIFEST)) ? freezeDrift(JSON.parse(readFileSync(join(ROOT,MANIFEST),"utf8"))) : null;
    const errors = liveGateErrors(argv,drift); if (errors.length) throw new Error(`Live evaluation refused: ${errors.join("; ")}`);
    const questionsPath = arg("--questions"),keyPath = arg("--key"),keySha = arg("--key-sha");
    if (!questionsPath || !keyPath || !keySha) throw new Error("Live evaluation needs --questions, --key and --key-sha");
    const holdout = loadHoldout(questionsPath),key = loadKey(keyPath,keySha,holdout.questions.map(q => q.id));
    const env = { ...(existsSync(join(ROOT,".env")) ? parseEnv(readFileSync(join(ROOT,".env"),"utf8")) : {}),...process.env };
    const apiKey = env.AI_API_KEY,model = env.AI_MODEL ?? PLANNED_MODEL;
    if (!apiKey) throw new Error("AI_API_KEY is not set");
    if (model !== PLANNED_MODEL) throw new Error(`Model ${model} differs from the frozen plan (${PLANNED_MODEL})`);
    const guard = guardedGeminiFetch(fetch,LIVE_CAP);
    const report = await runEvaluation({ mode: "LIVE",model,questions: holdout.questions,key,guard,holdoutSha256: holdout.sha256,keySha256: keySha,
      ask: (q,s) => callAsk({ apiKey,model,question: q,snapshot: s,fetchImpl: guard.fetch }) });
    const file = join(outDir,`live-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
    writeFileSync(file,`${JSON.stringify({ ...report,questions: holdout.questions },null,2)}\n`);
    console.log(summaryLines(report).join("\n")); console.log(`Full report (contains question text): ${file}`); return;
  }
  console.log("Use --reference, --freeze, --dry-run [--mock rules-echo|adversarial|quota-at-5], or --live (separately authorized).");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
