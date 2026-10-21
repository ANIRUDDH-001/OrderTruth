import { expect,it } from "vitest";
import { validateInvestigation, deterministicInvestigator, type InvestigationEvidence } from "../src/ai/investigation.ts";

const evidence: InvestigationEvidence[] = [
  { id: "E1",source: "PAYPAL_SANDBOX_OBSERVATION",observedAt: "2026-10-21T00:00:00.000Z",facts: { captureStatus: "COMPLETED",captureCount: 1,amountMinor: 100,currency: "USD" } },
  { id: "M1",source: "CONTROLLED_MERCHANT_STATE",observedAt: "2026-10-21T00:01:00.000Z",facts: { activeOrders: 2,matchingOrders: 2 } },
];
const result = { summary: "Two merchant orders reference one observed capture.",hypotheses: [{ explanation: "Independent merchant handlers may have used different deduplication identities.",evidenceIds: ["E1","M1"],confidence: "LOW",status: "HYPOTHESIS" }],nextDiagnostic: "IDEMPOTENCY_KEYS",diagnosticReason: "Compare the merchant write identities before attributing a cause." };
it("accepts grounded hypotheses and implemented read-only diagnostics", () => {
  expect(validateInvestigation(result,evidence).ok).toBe(true);
});
it("rejects invented evidence and financial/unimplemented tools", () => {
  expect(validateInvestigation({ ...result,hypotheses: [{ ...result.hypotheses[0],evidenceIds: ["E999"] }] },evidence).ok).toBe(false);
  expect(validateInvestigation({ ...result,nextDiagnostic: "REFUND_PAYMENT" },evidence).ok).toBe(false);
  expect(validateInvestigation({ ...result,hypotheses: [{ ...result.hypotheses[0],status: "VERIFIED_CAUSE" }] },evidence).ok).toBe(false);
});
it("keeps deterministic guidance useful and explicitly independent of model execution", () => {
  const baseline = deterministicInvestigator(evidence);
  expect(baseline.kind).toBe("RULES_BASED"); expect(baseline.nextDiagnostic).toBe("IDEMPOTENCY_KEYS");
  expect(baseline.evidenceIds).toEqual(["E1","M1"]);
  expect(baseline.freshModelExecution).toBe(false);
});
