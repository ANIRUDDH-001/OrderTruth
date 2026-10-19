import { expect, it } from "vitest";
import { HOLDOUT } from "../src/ai/holdout.ts";
import { offlineEvaluation, scoreRaw } from "../src/ai/holdout-eval.ts";

it("oracle scoring distinguishes valid from relevant IDs and classification from useful diagnostics", () => {
  const row = HOLDOUT[4]!;
  const raw = { incident_class_guess: row.expected, hypotheses: [{ hypothesis_id: "H", claim: "Definitely a provider double charge", supporting_evidence_ids: ["P1", "U1", "FAKE"], contradictory_evidence_ids: [], missing_evidence: [], next_test: "NONE", confidence: 1 }], operator_summary: "refund now" };
  expect(scoreRaw(row, raw)).toMatchObject({ classificationAgreement: true, citations: { valid: 2, relevant: 1, invented: 1, unsupported: 1, total: 3 }, diagnostics: { correct: 0, total: 1 }, accepted: false, humanReview: "REQUIRED" });
});

it("invalid schemas do not become zero-error model successes", () => {
  expect(scoreRaw(HOLDOUT[0]!, {})).toMatchObject({ schemaValid: false, classificationAgreement: null, citations: null, diagnostics: null, accepted: false });
});

it("offline evaluator gives separate denominators and never fabricates live or human scores", async () => {
  const r = await offlineEvaluation();
  expect(r.mode).toBe("OFFLINE_MOCKED"); expect(r.baseline.classification.total).toBe(28);
  expect(r.live.status).toBe("LIVE_MODEL_EVALUATION_BLOCKED"); expect(r.live.calls).toBe(0);
  expect(r.live.tokens).toBeNull(); expect(r.live.quality).toBeNull(); expect(r.humanUsefulness).toBeNull();
  expect(r.mocked.rejected.total).toBe(28); expect(r.mocked.rejected.count).toBe(28);
  expect(r.rows.every(x => x.mock.accepted === false && x.fallback.status === "AI_UNAVAILABLE")).toBe(true);
});
