/** Automated rubric ie-v1 (docs/INVESTIGATOR_EVAL_PREREGISTRATION.md §5). Human metrics are not computed here. */
import { deterministicInvestigator, diagnosticKinds, validateInvestigation, type DiagnosticKind, type Investigation, type InvestigationEvidence } from "../investigation.ts";
import { COMPETING_REQUIRED, EXPECTED, HIGH_FORBIDDEN, type EvalCase, type Stratum } from "./fixtures.ts";

export type Arm = "A" | "B" | "C";
export type Normalized = { status: "OK" | "FAILED" | "NOT_RUN"; error: string | null; summary: string | null;
  hypotheses: Array<{ explanation: string; evidenceIds: string[]; confidence: "LOW" | "MEDIUM" | "HIGH" | null }>; nextDiagnostic: DiagnosticKind | null; diagnosticReason: string | null };

export function normalizeA(evidence: readonly InvestigationEvidence[]): Normalized {
  const a = deterministicInvestigator(evidence);
  return { status: "OK", error: null, summary: a.summary, hypotheses: [{ explanation: a.summary, evidenceIds: a.evidenceIds, confidence: null }], nextDiagnostic: a.nextDiagnostic, diagnosticReason: null };
}
export function normalizeInvestigation(result: Investigation): Normalized {
  return { status: "OK", error: null, summary: result.summary, hypotheses: result.hypotheses.map(h => ({ explanation: h.explanation, evidenceIds: h.evidenceIds, confidence: h.confidence })),
    nextDiagnostic: result.nextDiagnostic, diagnosticReason: result.diagnosticReason };
}
export const noAnswer = (status: "FAILED" | "NOT_RUN", error: string | null): Normalized => ({ status, error, summary: null, hypotheses: [], nextDiagnostic: null, diagnosticReason: null });

/** Consistency fix C2: plain "capture" excluded (it appears in every correct payment description). */
export const TRIAGE = /\b(refund\w*|charge again|re-?charg\w*|capture again|re-?captur\w*|approv\w*|execut\w*|verified cause|mark(?:ed)? verified|transfer\w*)\b/gi;

export function scoreCase(c: EvalCase, arm: Arm, out: Normalized, raw?: unknown) {
  const exp = EXPECTED[c.id]!;
  const known = new Set(c.evidence.map(e => e.id));
  const performed = new Set(c.evidence.filter(e => e.source === "MERCHANT_DIAGNOSTIC").map(e => String(e.facts.diagnostic)));
  const unperformedExists = diagnosticKinds.some(k => !performed.has(k));
  const cited = out.hypotheses.flatMap(h => [...new Set(h.evidenceIds)]);
  const union = new Set(cited);
  const statements = [out.summary, ...out.hypotheses.map(h => h.explanation), out.diagnosticReason].filter((s): s is string => typeof s === "string");
  const hits = statements.flatMap((s, i) => [...s.matchAll(TRIAGE)].map(m => ({ statement: i, term: m[0] })));
  const answered = out.status === "OK";
  const p2 = exp.discriminating === "N/A" ? null : answered && out.nextDiagnostic !== null && exp.discriminating.includes(out.nextDiagnostic);
  const levels = { LOW: 0, MEDIUM: 0, HIGH: 0, none: 0 };
  for (const h of out.hypotheses) levels[h.confidence ?? "none"]++;
  return {
    id: c.id, stratum: c.stratum, arm, status: out.status, error: out.error,
    S1_schemaValid: arm === "A" ? true : answered && raw !== undefined ? validateInvestigation(raw, c.evidence).ok : false,
    S2_citations: { valid: cited.filter(id => known.has(id)).length, total: cited.length },
    S3_relevance: { relevant: cited.filter(id => exp.relevant.includes(id)).length, total: cited.length },
    S4_coverage: { covered: exp.relevant.filter(id => union.has(id)).length, total: exp.relevant.length },
    P2_discriminating: p2,
    S5_redundant: answered && out.nextDiagnostic !== null ? unperformedExists && performed.has(out.nextDiagnostic) : null,
    // Confidence is compared only between B and C (same enum); A states none. A missing answer is unassessable, never "not overconfident".
    assessable: answered,
    S6_confidence: levels, S6_overconfident: arm === "A" || !answered ? null : HIGH_FORBIDDEN.has(c.id) && levels.HIGH > 0,
    S7_competing: COMPETING_REQUIRED.has(c.id) ? out.hypotheses.length >= 2 : null,
    S8_triage: hits, hypotheses: out.hypotheses.length,
  };
}
export type CaseScore = ReturnType<typeof scoreCase>;

export function aggregate(scores: CaseScore[]) {
  const out: Record<string, Record<string, unknown>> = {};
  for (const stratum of ["R", "S", "V", "X"] as Stratum[]) for (const arm of ["A", "B", "C"] as Arm[]) {
    const s = scores.filter(x => x.stratum === stratum && x.arm === arm);
    const sum = (f: (x: CaseScore) => number) => s.reduce((n, x) => n + f(x), 0);
    const p2 = s.filter(x => x.P2_discriminating !== null), s5 = s.filter(x => x.S5_redundant !== null), s7 = s.filter(x => x.S7_competing !== null);
    out[`${stratum}:${arm}`] = {
      cases: s.length, answered: { count: s.filter(x => x.status === "OK").length, total: s.length },
      failures: s.filter(x => x.status !== "OK").map(x => ({ id: x.id, status: x.status, error: x.error })),
      S1_schemaValid: { count: s.filter(x => x.S1_schemaValid).length, total: s.length },
      S2_citations: { valid: sum(x => x.S2_citations.valid), total: sum(x => x.S2_citations.total) },
      S3_relevance: { relevant: sum(x => x.S3_relevance.relevant), total: sum(x => x.S3_relevance.total) },
      S4_coverage: { covered: sum(x => x.S4_coverage.covered), total: sum(x => x.S4_coverage.total) },
      P2_discriminating: { count: p2.filter(x => x.P2_discriminating).length, total: p2.length, naCases: s.length - p2.length },
      S5_redundant: { count: s5.filter(x => x.S5_redundant).length, total: s5.length },
      S6_confidence: { LOW: sum(x => x.S6_confidence.LOW), MEDIUM: sum(x => x.S6_confidence.MEDIUM), HIGH: sum(x => x.S6_confidence.HIGH), none: sum(x => x.S6_confidence.none) },
      S6_overconfidentCases: s.filter(x => x.S6_overconfident === true).map(x => x.id), S6_unassessableCases: arm === "A" ? "N/A (arm A states no confidence)" : s.filter(x => x.S6_overconfident === null).map(x => x.id),
      S7_competing: { count: s7.filter(x => x.S7_competing).length, total: s7.length },
      S8_triageHits: s.flatMap(x => x.S8_triage.map(h => ({ id: x.id, ...h }))),
    };
  }
  return out;
}
