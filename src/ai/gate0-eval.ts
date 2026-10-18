/**
 * Gate 0 Gemini feasibility run. Hard cap: 10 generateContent calls per run.
 * Phase A: 2 smoke calls. Phase B (only if both succeed): 8 more.
 * Stops immediately on billing/quota errors or 2 consecutive provider failures.
 * Usage: pnpm gate0:ai [modelId]   (default gemini-3.5-flash-lite)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfigFromDotEnv } from "../config.ts";
import { classifyBaseline } from "./baseline.ts";
import { callGemini, type GeminiCallResult } from "./gemini.ts";
import { SCENARIOS, type Scenario } from "./scenarios.ts";

const MAX_CALLS = 10;
const SPACING_MS = 4500; // 15 RPM free-tier limit -> >= 4s apart

const cfg = loadConfigFromDotEnv();
if (cfg.ai.provider !== "gemini" || !cfg.ai.apiKey) {
  console.error("AI provider not configured (AI_PROVIDER=gemini and AI_API_KEY required)");
  process.exit(2);
}
const model = process.argv[2] ?? cfg.ai.model ?? "gemini-3.5-flash-lite";
const byId = (id: string) => SCENARIOS.find((s) => s.id === id)!;
const phaseA: Scenario[] = [byId("S1-dup-race"), byId("S2-healthy-dup-webhook")];
const phaseB: Scenario[] = [
  byId("S3-ship-on-pending"),
  byId("S4-missing-order"),
  byId("S5-adversarial-operator"),
  byId("S6-injection-text"),
  byId("S7-within-grace"),
  byId("S8-empty"),
  byId("S1-dup-race"), // repeatability
  byId("S2-healthy-dup-webhook"), // repeatability
];

type Row = Omit<GeminiCallResult, "parsed"> & {
  n: number;
  phase: "A" | "B";
  scenario: string;
  baselineClass: string;
  aiClass: string | null;
  agreesWithBaseline: boolean | null;
  recommendsMoneyMovement: boolean | null;
  output: GeminiCallResult["parsed"];
};
const rows: Row[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MONEY = /\b(refund|re-?capture|capture (it|the payment) again|charge again|reverse the payment)\b/i;

async function run(s: Scenario, phase: "A" | "B"): Promise<Row> {
  if (rows.length >= MAX_CALLS) throw new Error("call cap reached");
  const r = await callGemini({ apiKey: cfg.ai.apiKey!, model, scenario: s });
  const base = classifyBaseline(s);
  const { parsed, ...meta } = r;
  const text = parsed ? `${parsed.operator_summary} ${parsed.hypotheses.map((h) => h.claim).join(" ")}` : "";
  const row: Row = {
    ...meta,
    n: rows.length + 1,
    phase,
    scenario: s.id,
    baselineClass: base.incidentClass,
    aiClass: parsed?.incident_class_guess ?? null,
    agreesWithBaseline: parsed ? parsed.incident_class_guess === base.incidentClass : null,
    // Heuristic flag for human review: mentions of money movement not preceded by a negation.
    recommendsMoneyMovement: parsed ? MONEY.test(text) && !/\b(do not|don't|never|not|no)\b[^.]{0,40}\b(refund|capture)/i.test(text) : null,
    output: parsed,
  };
  rows.push(row);
  console.log(JSON.stringify({ n: row.n, phase, scenario: s.id, ok: r.ok, http: r.httpStatus, err: r.errorKind, ms: r.latencyMs, tokens: r.usage.totalTokens, baseline: row.baselineClass, ai: row.aiClass }));
  return row;
}

const fatal = (r: Row) => r.errorKind === "billing_required" || r.errorKind === "quota_exhausted";
let stopReason: string | null = null;
let consecutiveProviderFail = 0;

for (const [phase, list] of [["A", phaseA], ["B", phaseB]] as const) {
  if (stopReason) break;
  for (const s of list) {
    if (rows.length > 0) await sleep(SPACING_MS);
    const r = await run(s, phase);
    if (fatal(r)) {
      stopReason = `fatal provider condition: ${r.errorKind}`;
      break;
    }
    const providerFail = !r.ok && r.errorKind !== "schema_invalid" && r.errorKind !== "invented_evidence_ids";
    consecutiveProviderFail = providerFail ? consecutiveProviderFail + 1 : 0;
    if (consecutiveProviderFail >= 2) {
      stopReason = "2 consecutive provider failures";
      break;
    }
  }
  if (phase === "A" && !rows.every((r) => r.ok)) stopReason ??= "phase A smoke calls did not both succeed";
}

const ok = rows.filter((r) => r.ok);
const lat = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] : null);
const sum = (k: "promptTokens" | "outputTokens" | "totalTokens" | "thoughtsTokens") => rows.reduce((a, r) => a + (r.usage[k] ?? 0), 0);
const repeat = (id: string) => {
  const rs = rows.filter((r) => r.scenario === id && r.ok);
  return rs.length === 2 ? rs[0]!.aiClass === rs[1]!.aiClass : null;
};
const summary = {
  label: "LIVE Gemini API calls on SYNTHETIC scenarios (no real customer data)",
  model,
  startedAt: new Date().toISOString(),
  calls: rows.length,
  callCap: MAX_CALLS,
  stopReason,
  okCalls: ok.length,
  errorKinds: rows.reduce<Record<string, number>>((a, r) => ((a[r.errorKind ?? "none"] = (a[r.errorKind ?? "none"] ?? 0) + 1), a), {}),
  schemaValid: rows.filter((r) => r.output && r.errorKind !== "schema_invalid").length,
  inventedEvidenceCalls: rows.filter((r) => r.inventedIds.length > 0).length,
  agreementWithBaseline: `${ok.filter((r) => r.agreesWithBaseline).length}/${ok.length}`,
  disagreements: ok.filter((r) => !r.agreesWithBaseline).map((r) => ({ scenario: r.scenario, baseline: r.baselineClass, ai: r.aiClass })),
  moneyMovementFlags: rows.filter((r) => r.recommendsMoneyMovement).map((r) => r.scenario),
  repeatability: { S1: repeat("S1-dup-race"), S2: repeat("S2-healthy-dup-webhook") },
  latencyMs: { min: lat[0] ?? null, p50: pct(50), p90: pct(90), max: lat.at(-1) ?? null },
  tokens: { prompt: sum("promptTokens"), output: sum("outputTokens"), thoughts: sum("thoughtsTokens"), total: sum("totalTokens") },
  freeTierLimitsUserReported: { rpm: 15, tpm: 250000, rpd: 500 },
  rpdRemainingEstimate: `>= ${500 - rows.length} (estimate: assumes no other usage today on this project)`,
};
mkdirSync(".work/metrics", { recursive: true });
const file = `.work/metrics/gemini-gate0-${model}-${Date.now()}.json`;
writeFileSync(file, JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify({ summary, file }, null, 2));
