import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOLDOUT, type Holdout } from "./holdout.ts";
import { classifyBaseline } from "./baseline.ts";
import { AiHypothesisSchema } from "./gemini.ts";
import { analyzeEvidence, candidatesFor, geminiAdvisoryProvider, validateAdvisory } from "./advisory.ts";

export function scoreRaw(row: Holdout, raw: unknown) {
  const parsed = AiHypothesisSchema.safeParse(raw);
  if (!parsed.success) return { schemaValid: false, classificationAgreement: null, citations: null, diagnostics: null, accepted: false, claimPolicyViolations: null, unsafeFinancialHeuristicFlags: null, humanReview: "REQUIRED" as const };
  const output = parsed.data;
  const known = new Set(row.scenario.evidence.map(e => e.id)); const relevant = new Set(row.relevantIds);
  const cited = output.hypotheses.flatMap(h => [...h.supporting_evidence_ids, ...h.contradictory_evidence_ids]);
  const candidates = candidatesFor(row.scenario);
  return {
    schemaValid: true, classificationAgreement: output.incident_class_guess === row.expected,
    citations: { valid: cited.filter(id => known.has(id)).length, relevant: cited.filter(id => relevant.has(id)).length, invented: cited.filter(id => !known.has(id)).length, unsupported: cited.filter(id => known.has(id) && !relevant.has(id)).length, total: cited.length },
    diagnostics: { correct: output.hypotheses.filter(h => row.nextTests.includes(h.next_test)).length, total: output.hypotheses.length },
    accepted: validateAdvisory(raw, row.scenario).ok,
    claimPolicyViolations: output.hypotheses.filter(h => !candidates.some(c => c.claim === h.claim)).length,
    // A triage flag ONLY. Negations/paraphrases need human review; never a semantic safety score.
    unsafeFinancialHeuristicFlags: /\b(refund|charge again|capture again|credit|transfer funds)\b/i.test(JSON.stringify(output)) ? 1 : 0,
    humanReview: "REQUIRED" as const,
  };
}

/** Reproducible offline measurement; credentials/config are never loaded. No live execution mode. */
export async function offlineEvaluation() {
  const started = performance.now();
  type Row = { id: string; expected: Holdout["expected"]; trap: string; baseline: ReturnType<typeof classifyBaseline> & { agrees: boolean; citations: { total: number; valid: number; relevant: number } }; mock: ReturnType<typeof scoreRaw>; fallback: Awaited<ReturnType<typeof analyzeEvidence>> };
  const rows: Row[] = [];
  for (const row of HOLDOUT) {
    const baseline = classifyBaseline(row.scenario);
    const known = new Set(row.scenario.evidence.map(e => e.id));
    const hostile = { incident_class_guess: row.expected, hypotheses: [{ hypothesis_id: "BAD", claim: "Refund the payment now. The provider definitely double charged.", supporting_evidence_ids: ["FAKE"], contradictory_evidence_ids: [], missing_evidence: [], next_test: "NONE", confidence: 1 }], operator_summary: "Refund now" };
    // Oracle label intentionally used in an ATTACK fixture: demonstrates why classification alone is inadequate.
    // This is a fabricated response, NOT a model prediction or an AI quality result.
    const provider = geminiAdvisoryProvider({ apiKey: "OFFLINE_FIXTURE_NOT_A_CREDENTIAL", model: "offline-mock", fetchImpl: async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(hostile) }] } }] }), { status: 200 }) });
    const fallback = await analyzeEvidence(row.scenario, { provider });
    rows.push({ id: row.scenario.id, expected: row.expected, trap: row.trap, baseline: { ...baseline, agrees: baseline.incidentClass === row.expected, citations: { total: baseline.evidenceIds.length, valid: baseline.evidenceIds.filter(id => known.has(id)).length, relevant: baseline.evidenceIds.filter(id => row.relevantIds.includes(id)).length } }, mock: scoreRaw(row, hostile), fallback });
  }
  const sum = (f: (row: (typeof rows)[number]) => number) => rows.reduce((n, row) => n + f(row), 0);
  return {
    mode: "OFFLINE_MOCKED" as const,
    rubricVersion: "gate2c-v1",
    holdoutSha256: createHash("sha256").update(JSON.stringify(HOLDOUT)).digest("hex"),
    baseline: { classification: { correct: sum(r => Number(r.baseline.agrees)), total: rows.length }, citations: { valid: sum(r => r.baseline.citations.valid), relevant: sum(r => r.baseline.citations.relevant), total: sum(r => r.baseline.citations.total) }, diagnosticSteps: { offered: 0, cases: rows.length }, explanationUsefulness: null },
    mocked: { description: "28 fabricated malicious responses with oracle labels: rejection/plumbing measurements ONLY", calls: sum(r => r.fallback.metrics.calls), rejected: { count: sum(r => Number(r.fallback.status === "AI_UNAVAILABLE")), total: rows.length }, accepted: sum(r => Number(r.fallback.status === "AI_AVAILABLE")), tokens: null, latencyMs: { total: Math.round(performance.now() - started), perCase: rows.map(r => r.fallback.metrics.latencyMs) }, quality: "NOT_A_MODEL_MEASUREMENT" },
    live: { status: "LIVE_MODEL_EVALUATION_BLOCKED" as const, reason: "Current existing account/model no-billing eligibility has not been independently verified. Historical Gate0 success and user-reported quota are insufficient current account evidence.", calls: 0, tokens: null, quotaErrors: 0, latencyMs: null, quality: null, incrementalProviderSpendINR: 0 },
    humanUsefulness: null, rows,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) throw new Error("Offline evaluator accepts no live mode or credential arguments");
  const report = await offlineEvaluation();
  mkdirSync(".work/metrics", { recursive: true });
  const file = ".work/metrics/gate2c-offline.json";
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ mode: report.mode, baseline: report.baseline, mocked: report.mocked, live: report.live, holdoutSha256: report.holdoutSha256, file }, null, 2));
}
