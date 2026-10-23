/**
 * Gate 2C LIVE evaluation: at most 10 Gemini calls over 10 preregistered holdout cases.
 * Three arms on identical observations: the unchanged rules baseline (no model), a deterministic
 * candidate-policy-only control (no model), and Gemini with the unchanged advisory policy.
 * One call per case, no retries; stops at the first quota/billing/access uncertainty.
 * Imports no payment, database, merchant or server module: it cannot repair or mutate state.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { HOLDOUT } from "./holdout.ts";
import { classifyBaseline } from "./baseline.ts";
import { analyzeEvidence, candidatesFor, geminiAdvisoryProvider, SUMMARY } from "./advisory.ts";
import type { AiHypothesis, GeminiCallResult } from "./gemini.ts";
import { scoreRaw } from "./holdout-eval.ts";
import type { IncidentClass, Scenario } from "./scenarios.ts";

/** Preregistered in docs/GATE2C_AI_RESULTS.md before any live call. Do not edit after a live run. */
export const FROZEN_CASE_IDS = ["H2C-01", "H2C-05", "H2C-06", "H2C-10", "H2C-12", "H2C-17", "H2C-19", "H2C-21", "H2C-22", "H2C-28"] as const;
export const MAX_LIVE_CALLS = 10;
const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com/";
const STOP_KINDS = new Set<GeminiCallResult["errorKind"]>(["rate_limited", "quota_exhausted", "billing_required", "http_4xx"]);
const CALL_SPACING_MS = 6000;
const TIMEOUT_MS = 30000;

/** Only the Gemini API, at most `cap` requests; anything else throws before touching the network. */
export function guardedFetch(inner: typeof fetch, cap: number) {
  let count = 0;
  const guarded = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(GEMINI_ORIGIN)) throw new Error(`Network request refused: only ${GEMINI_ORIGIN} is allowed`);
    if (count >= cap) throw new Error(`Live call cap of ${cap} reached`);
    count++;
    return inner(input, init);
  }) as typeof fetch;
  return { fetch: guarded, count: () => count };
}

const CLASS_FOR_CODE: Record<string, IncidentClass> = {
  RACE: "DUPLICATE_MERCHANT_ORDER", RETRY: "DUPLICATE_MERCHANT_ORDER", DELAY: "MISSING_MERCHANT_ORDER", WRITE_FAILURE: "MISSING_MERCHANT_ORDER",
  GRACE: "WITHIN_GRACE_PERIOD", NO_DISCREPANCY: "HEALTHY", INCOMPLETE: "INSUFFICIENT_EVIDENCE",
};
/** Control: what the server's candidate policy alone yields, with no model. Every candidate in policy
 * order, its first allowed test, the class its candidate code implies, fixed confidence 0.5. */
export function policyOnlyControl(s: Scenario): AiHypothesis {
  const candidates = candidatesFor(s);
  return {
    incident_class_guess: CLASS_FOR_CODE[candidates[0]!.code]!,
    hypotheses: candidates.slice(0, 3).map(c => ({ hypothesis_id: c.code, claim: c.claim, supporting_evidence_ids: [...c.evidenceIds], contradictory_evidence_ids: [], missing_evidence: [c.missing], next_test: c.tests[0]!, confidence: 0.5 })),
    operator_summary: SUMMARY,
  };
}

type Score = ReturnType<typeof scoreRaw>;
type AiRow = { status: "SUCCESS" | "FAILED" | "NOT_RUN"; accepted: boolean | null; reason: string | null; errorKind: GeminiCallResult["errorKind"] | null; errorDetail: string | null; httpStatus: number | null;
  latencyMs: number | null; usage: GeminiCallResult["usage"] | null; output: AiHypothesis | null; score: Score | null };

export async function runLiveEvaluation(opts: { apiKey: string; model: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }) {
  const sleep = opts.sleep ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
  const guard = guardedFetch(opts.fetchImpl ?? fetch, MAX_LIVE_CALLS);
  const startedAt = new Date().toISOString();
  const cases = FROZEN_CASE_IDS.map(id => { const row = HOLDOUT.find(h => h.scenario.id === id); if (!row) throw new Error(`Frozen case ${id} missing`); return row; });
  let stopped: { afterCase: string; errorKind: string; httpStatus: number | null } | null = null;
  type Row = { id: string; expected: IncidentClass; trap: string; ai: AiRow; control: { output: AiHypothesis; score: Score };
    baseline: { incidentClass: IncidentClass; agrees: boolean; rule: string; citations: { total: number; valid: number; relevant: number }; diagnosticSteps: number } };
  const rows: Row[] = [];
  for (const [index, row] of cases.entries()) {
    const known = new Set(row.scenario.evidence.map(e => e.id));
    const base = classifyBaseline(row.scenario);
    const baseline = { incidentClass: base.incidentClass, agrees: base.incidentClass === row.expected, rule: base.rule,
      citations: { total: base.evidenceIds.length, valid: base.evidenceIds.filter(id => known.has(id)).length, relevant: base.evidenceIds.filter(id => row.relevantIds.includes(id)).length }, diagnosticSteps: 0 };
    const controlOutput = policyOnlyControl(row.scenario);
    const control = { output: controlOutput, score: scoreRaw(row, controlOutput) };
    let ai: AiRow = { status: "NOT_RUN", accepted: null, reason: null, errorKind: null, errorDetail: null, httpStatus: null, latencyMs: null, usage: null, output: null, score: null };
    if (!stopped) {
      if (index > 0) await sleep(CALL_SPACING_MS); // Pacing for free-tier RPM; never a retry.
      let response: GeminiCallResult | null = null;
      const inner = geminiAdvisoryProvider({ apiKey: opts.apiKey, model: opts.model, fetchImpl: guard.fetch });
      const advisory = await analyzeEvidence(row.scenario, { timeoutMs: TIMEOUT_MS, provider: async (s, t) => (response = await inner(s, t)) });
      const r = response as GeminiCallResult | null;
      ai = { status: r?.ok ? "SUCCESS" : "FAILED", accepted: advisory.status === "AI_AVAILABLE", reason: advisory.reason, errorKind: r?.errorKind ?? (advisory.reason === "TIMEOUT" ? "timeout" : null),
        errorDetail: r?.errorDetail ?? null, httpStatus: r?.httpStatus ?? null, latencyMs: r?.latencyMs ?? advisory.metrics.latencyMs, usage: r?.usage ?? null, output: r?.parsed ?? null,
        score: r?.parsed ? scoreRaw(row, r.parsed) : null };
      if (r && STOP_KINDS.has(r.errorKind)) stopped = { afterCase: row.scenario.id, errorKind: r.errorKind!, httpStatus: r.httpStatus };
    }
    rows.push({ id: row.scenario.id, expected: row.expected, trap: row.trap, baseline, control, ai });
  }
  const n = rows.length;
  const sum = <T>(list: T[], f: (x: T) => number) => list.reduce((acc, x) => acc + f(x), 0);
  const scored = (pick: (r: (typeof rows)[number]) => Score | null) => {
    const s = rows.map(pick).filter((x): x is Score => !!x && x.schemaValid);
    return { outputs: s.length, classification: { correct: sum(s, x => Number(x.classificationAgreement)), total: s.length },
      citations: { valid: sum(s, x => x.citations!.valid), relevant: sum(s, x => x.citations!.relevant), invented: sum(s, x => x.citations!.invented), unsupported: sum(s, x => x.citations!.unsupported), total: sum(s, x => x.citations!.total) },
      diagnostics: { correct: sum(s, x => x.diagnostics!.correct), total: sum(s, x => x.diagnostics!.total) },
      claimPolicyViolations: sum(s, x => x.claimPolicyViolations!), financialKeywordFlags: sum(s, x => x.unsafeFinancialHeuristicFlags!), acceptedByValidator: sum(s, x => Number(x.accepted)) };
  };
  const attempted = rows.filter(r => r.ai.status !== "NOT_RUN");
  const latencies = attempted.map(r => r.ai.latencyMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const tokens = (k: "promptTokens" | "outputTokens" | "totalTokens" | "thoughtsTokens") => sum(attempted, r => r.ai.usage?.[k] ?? 0);
  return {
    mode: "LIVE_FREE_TIER" as const, rubricVersion: "gate2c-v1", model: opts.model, startedAt, finishedAt: new Date().toISOString(),
    holdoutSha256: createHash("sha256").update(JSON.stringify(HOLDOUT)).digest("hex"), frozenCaseIds: [...FROZEN_CASE_IDS],
    calls: { made: guard.count(), cap: MAX_LIVE_CALLS, retries: 0 }, stopped,
    summary: {
      baseline: { classification: { correct: sum(rows, r => Number(r.baseline.agrees)), total: n }, citations: { valid: sum(rows, r => r.baseline.citations.valid), relevant: sum(rows, r => r.baseline.citations.relevant), total: sum(rows, r => r.baseline.citations.total) }, diagnosticSteps: { offered: 0, cases: n } },
      control: scored(r => r.control.score),
      ai: { attempted: { count: attempted.length, total: n }, successfulOutputs: { count: sum(rows, r => Number(r.ai.status === "SUCCESS")), total: attempted.length },
        accepted: { count: sum(rows, r => Number(r.ai.accepted === true)), total: attempted.length },
        failures: attempted.filter(r => r.ai.status === "FAILED").map(r => ({ id: r.id, errorKind: r.ai.errorKind, reason: r.ai.reason, httpStatus: r.ai.httpStatus })),
        scoredOutputs: scored(r => r.ai.score),
        latencyMs: latencies.length ? { min: latencies[0]!, median: latencies[Math.floor((latencies.length - 1) / 2)]!, max: latencies.at(-1)!, n: latencies.length } : null,
        tokens: { prompt: tokens("promptTokens"), output: tokens("outputTokens"), thoughts: tokens("thoughtsTokens"), total: tokens("totalTokens") } },
      humanUsefulness: "NOT_REVIEWED",
    },
    rows,
  };
}

function sourceHashes() {
  return Object.fromEntries(["src/ai/holdout-live-eval.ts", "src/ai/advisory.ts", "src/ai/gemini.ts", "src/ai/holdout.ts", "src/ai/baseline.ts", "src/ai/holdout-eval.ts"]
    .map(f => [f, createHash("sha256").update(readFileSync(f)).digest("hex")]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--prereg", "--live"].includes(args[0]!)) throw new Error("Use --prereg (no calls) or --live (at most 10 calls)");
  mkdirSync(".work/metrics", { recursive: true });
  if (args[0] === "--prereg") {
    const prereg = { frozenAt: new Date().toISOString(), rubricVersion: "gate2c-v1", frozenCaseIds: FROZEN_CASE_IDS, maxCalls: MAX_LIVE_CALLS, retries: 0, spacingMs: CALL_SPACING_MS, timeoutMs: TIMEOUT_MS,
      stopOn: [...STOP_KINDS], holdoutSha256: createHash("sha256").update(JSON.stringify(HOLDOUT)).digest("hex"), sources: sourceHashes() };
    writeFileSync(".work/metrics/gate2c-live-prereg.json", `${JSON.stringify(prereg, null, 2)}\n`);
    console.log(JSON.stringify(prereg, null, 2));
  } else {
    // Read only the three AI settings; values are never printed or written.
    const env = existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {};
    // Normalised exactly as src/config.ts does (trim; provider lower-cased).
    const provider = env.AI_PROVIDER?.trim().toLowerCase(), apiKey = env.AI_API_KEY?.trim(), model = env.AI_MODEL?.trim();
    if (provider !== "gemini" || !apiKey || !model) throw new Error("Live run needs AI_PROVIDER=gemini, AI_MODEL and AI_API_KEY in the local .env; no call was made");
    const report = await runLiveEvaluation({ apiKey, model });
    const json = JSON.stringify({ ...report, sources: sourceHashes() }, null, 2);
    if (json.includes(apiKey)) throw new Error("Refusing to write a report containing the credential");
    const file = `.work/metrics/gate2c-live-${report.startedAt.replace(/[:.]/g, "-")}.json`;
    writeFileSync(file, `${json}\n`);
    console.log(JSON.stringify({ file, model: report.model, calls: report.calls, stopped: report.stopped, summary: report.summary }, null, 2));
  }
}
