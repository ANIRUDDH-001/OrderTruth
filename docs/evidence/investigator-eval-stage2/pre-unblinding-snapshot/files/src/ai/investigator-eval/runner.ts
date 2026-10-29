/**
 * Judge-facing investigator evaluation runner (docs/INVESTIGATOR_EVAL_PREREGISTRATION.md).
 *   --prereg   write the freeze record; no network, no credential read
 *   --dry-run  full pipeline against a MOCKED provider; no network
 *   --live --i-have-approval-for-16-live-calls   at most 16 Gemini attempts (separately authorized)
 * Imports no payment, database, merchant, server or webhook module.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform, release } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { callInvestigator, validateInvestigation, type InvestigationCall } from "../investigation.ts";
import { CASES, EXPECTED } from "./fixtures.ts";
import { promptRulesControl } from "./control.ts";
import { aggregate, noAnswer, normalizeA, normalizeInvestigation, scoreCase, type Arm, type CaseScore, type Normalized } from "./score.ts";
import { guardedGeminiFetch, GEMINI_ORIGIN, type GuardEvent } from "./guard.ts";
import { buildPacks } from "./blind.ts";

export const LIVE_CAP = 16;
export const STOP_ERRORS = new Set(["QUOTA_OR_RATE_LIMIT", "PROVIDER_REJECTED"]);
export const SPACING_MS = 6000;
export const APPROVAL_FLAG = "--i-have-approval-for-16-live-calls";
const FROZEN_FILES = ["src/ai/investigation.ts", "src/ai/investigator-eval/fixtures.ts", "src/ai/investigator-eval/control.ts", "src/ai/investigator-eval/score.ts",
  "src/ai/investigator-eval/guard.ts", "src/ai/investigator-eval/runner.ts", "src/ai/investigator-eval/blind.ts", "src/ai/investigator-eval/decision.ts",
  "tests/investigator-eval.test.ts", "docs/INVESTIGATOR_EVAL_PREREGISTRATION.md", "package.json", "pnpm-lock.yaml", ".github/workflows/ci.yml"];
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const caseHash = (id: string) => sha(JSON.stringify(CASES.find(c => c.id === id)!.evidence));
export const blindingSeed = () => parseInt(sha(readFileSync("src/ai/investigator-eval/fixtures.ts")).slice(0, 8), 16);

export async function runEvaluation(opts: { mode: "DRY_RUN" | "LIVE"; apiKey: string; model: string; guard: ReturnType<typeof guardedGeminiFetch>;
  sleep?: (ms: number) => Promise<void>; spacingMs?: number }) {
  const sleep = opts.sleep ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
  const startedAt = new Date().toISOString();
  let stopped: { afterCase: string; reason: string } | null = null;
  const rows = [];
  for (const [index, c] of CASES.entries()) {
    const control = promptRulesControl(c.evidence);
    const outputs: Record<Arm, Normalized> = { A: normalizeA(c.evidence), B: noAnswer("NOT_RUN", "NOT_RUN"), C: normalizeInvestigation(control) };
    let call: InvestigationCall | null = null; let guardEvents: GuardEvent[] = [];
    if (!stopped) {
      if (index > 0) await sleep(opts.spacingMs ?? SPACING_MS); // Free-tier pacing, never a retry.
      const before = opts.guard.events.length, refusalsBefore = opts.guard.refusals();
      try { call = await callInvestigator({ apiKey: opts.apiKey, model: opts.model, evidence: c.evidence, fetchImpl: opts.guard.fetch }); }
      catch { call = { ok: false, result: null, error: "RUNNER_REFUSED_INPUT", usage: { promptTokens: null, outputTokens: null, totalTokens: null }, latencyMs: 0, httpStatus: null }; }
      guardEvents = opts.guard.events.slice(before);
      outputs.B = call.ok && call.result ? normalizeInvestigation(call.result) : noAnswer("FAILED", call.error);
      if (opts.guard.refusals() > refusalsBefore) stopped = { afterCase: c.id, reason: `GUARD_${guardEvents.find(e => e.kind !== "SENT")?.kind ?? "REFUSAL"}` };
      else if (call.error && STOP_ERRORS.has(call.error)) stopped = { afterCase: c.id, reason: call.error };
    }
    const scores: Record<Arm, CaseScore> = { A: scoreCase(c, "A", outputs.A), B: scoreCase(c, "B", outputs.B, call?.result ?? undefined), C: scoreCase(c, "C", outputs.C, control) };
    rows.push({ id: c.id, stratum: c.stratum, inputPath: EXPECTED[c.id]!.inputPath, evidenceSha256: caseHash(c.id), outputs,
      armC: { valid: validateInvestigation(control, c.evidence).ok },
      armB: call ? { ok: call.ok, error: call.error, httpStatus: call.httpStatus, latencyMs: call.latencyMs, usage: call.usage, guardEvents } : { ok: false, error: "NOT_RUN", guardEvents }, scores });
  }
  const all = rows.flatMap(r => Object.values(r.scores));
  const calls = rows.map(r => r.armB).filter(b => "latencyMs" in b) as Array<{ latencyMs: number; usage: InvestigationCall["usage"] }>;
  const tokens = (k: keyof InvestigationCall["usage"]) => calls.reduce((n, b) => n + (b.usage[k] ?? 0), 0);
  return { mode: opts.mode, rubric: "ie-v1", model: opts.model, startedAt, finishedAt: new Date().toISOString(),
    network: { origin: GEMINI_ORIGIN, attempts: opts.guard.attempts(), cap: LIVE_CAP, refusals: opts.guard.refusals(), redirectPolicy: "error" },
    stopped, aggregate: aggregate(all),
    armBTotals: { latencyMs: calls.map(b => b.latencyMs).sort((a, b) => a - b), tokens: { prompt: tokens("promptTokens"), output: tokens("outputTokens"), total: tokens("totalTokens") } },
    humanMetrics: "PENDING_TWO_STAGE_REVIEW", rows };
}

/** Canned provider for --dry-run: schema-valid generic answers and one scripted 503, to exercise every path. */
export function mockedProvider(failCaseIndex = 14): typeof fetch {
  let n = 0;
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const i = n++;
    if (i === failCaseIndex) return new Response(JSON.stringify({ error: { message: "mock unavailable" } }), { status: 503 });
    const evidence = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text) as Array<{ id: string }>;
    const result = { summary: "MOCKED DRY-RUN RESPONSE: not a model output.", hypotheses: [{ explanation: "Mocked hypothesis for pipeline testing only.", evidenceIds: evidence.slice(0, 2).map(e => e.id), confidence: "LOW", status: "HYPOTHESIS" }],
      nextDiagnostic: "HANDLER_TIMING", diagnosticReason: "Mocked reason." };
    return new Response(JSON.stringify({ modelVersion: "mock-0", candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40, totalTokenCount: 140 } }), { status: 200 });
  }) as typeof fetch;
}

function readAiEnv(requireKey: boolean) {
  const env = existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {};
  const provider = env.AI_PROVIDER?.trim().toLowerCase(), model = env.AI_MODEL?.trim(), apiKey = requireKey ? env.AI_API_KEY?.trim() : undefined;
  return { provider, model, apiKey };
}
function writeOutputs(dir: string, report: Awaited<ReturnType<typeof runEvaluation>>, secret: string | null) {
  mkdirSync(dir, { recursive: true });
  const packs = buildPacks(Object.fromEntries(report.rows.map(r => [r.id, r.outputs])), blindingSeed());
  const files: Record<string, string> = { "report.json": JSON.stringify(report, null, 2), "stage1-pack.md": packs.stage1, "stage2-pack.md": packs.stage2,
    "stage1-sheet.csv": packs.sheet1, "stage2-sheet.csv": packs.sheet2, "consensus.csv": packs.consensus, "arm-key.json": JSON.stringify(packs.key, null, 2) };
  for (const [name, text] of Object.entries(files)) {
    if (secret && text.includes(secret)) throw new Error(`Refusing to write ${name}: it contains the credential`);
    writeFileSync(join(dir, name), `${text}\n`);
  }
  return Object.keys(files).map(f => join(dir, f));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const mode = args[0];
  if (mode === "--prereg" && args.length === 1) {
    const git = (...a: string[]) => { try { return execFileSync("git", a, { encoding: "utf8" }).trim(); } catch { return null; } };
    const record = { frozenAt: new Date().toISOString(), rubric: "ie-v1", revision: git("rev-parse", "HEAD"), workingTreeChanges: git("status", "--porcelain")?.split("\n").filter(Boolean) ?? null,
      environment: { node: process.version, pnpm: process.env.npm_config_user_agent ?? null, os: `${platform()} ${release()}` }, model: readAiEnv(false).model ?? null,
      files: Object.fromEntries(FROZEN_FILES.map(f => [f, sha(readFileSync(f))])),
      // Line-ending-independent identity: the committed blob, and whether the working copy still matches it.
      gitBlobs: Object.fromEntries(FROZEN_FILES.map(f => [f, { blob: git("rev-parse", `HEAD:${f}`), matchesHead: git("diff", "--quiet", "HEAD", "--", f) !== null }])), cases: Object.fromEntries(CASES.map(c => [c.id, { stratum: c.stratum, inputPath: EXPECTED[c.id]!.inputPath, evidenceSha256: caseHash(c.id) }])),
      blindingSeed: blindingSeed(), cap: LIVE_CAP, retries: 0, spacingMs: SPACING_MS, stopErrors: [...STOP_ERRORS], guard: { origin: GEMINI_ORIGIN, redirect: "error", stopOnRefusal: true } };
    mkdirSync(".work/metrics", { recursive: true });
    writeFileSync(".work/metrics/investigator-eval-prereg.json", `${JSON.stringify(record, null, 2)}\n`);
    console.log(JSON.stringify(record, null, 2));
  } else if (mode === "--dry-run" && args.length === 1) {
    const guard = guardedGeminiFetch(mockedProvider(), LIVE_CAP);
    const report = await runEvaluation({ mode: "DRY_RUN", apiKey: "MOCK_NOT_A_CREDENTIAL", model: "mock-model", guard, sleep: async () => {} });
    const files = writeOutputs(".work/metrics/investigator-eval-dryrun", report, null);
    console.log(JSON.stringify({ mode: report.mode, network: report.network, stopped: report.stopped, files, aggregate: report.aggregate }, null, 2));
  } else if (mode === "--live" && args.length === 2 && args[1] === APPROVAL_FLAG) {
    const { provider, model, apiKey } = readAiEnv(true);
    if (provider !== "gemini" || !model || !apiKey) throw new Error("Live run needs AI_PROVIDER=gemini, AI_MODEL and AI_API_KEY in the local .env; no call was made");
    const guard = guardedGeminiFetch(fetch, LIVE_CAP);
    const report = await runEvaluation({ mode: "LIVE", apiKey, model, guard });
    const files = writeOutputs(`.work/metrics/investigator-eval-live-${report.startedAt.replace(/[:.]/g, "-")}`, report, apiKey);
    console.log(JSON.stringify({ mode: report.mode, model, network: report.network, stopped: report.stopped, files }, null, 2));
  } else throw new Error(`Use --prereg, --dry-run, or --live ${APPROVAL_FLAG}`);
}
