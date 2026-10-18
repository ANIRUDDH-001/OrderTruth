// MOCKED / offline: no Gemini calls are made in this file.
import { describe, expect, it } from "vitest";
import { classifyBaseline } from "../src/ai/baseline.ts";
import { buildPrompt, callGemini, validateOutput } from "../src/ai/gemini.ts";
import { SCENARIOS } from "../src/ai/scenarios.ts";

const s = (id: string) => SCENARIOS.find((x) => x.id === id)!;

describe("rules-only baseline", () => {
  it.each([
    ["S1-dup-race", "DUPLICATE_MERCHANT_ORDER"],
    ["S2-healthy-dup-webhook", "HEALTHY"],
    ["S3-ship-on-pending", "FULFILLED_WITHOUT_CAPTURE"],
    ["S4-missing-order", "MISSING_MERCHANT_ORDER"],
    ["S5-adversarial-operator", "HEALTHY"],
    ["S6-injection-text", "DUPLICATE_MERCHANT_ORDER"],
    ["S7-within-grace", "WITHIN_GRACE_PERIOD"],
    ["S8-empty", "INSUFFICIENT_EVIDENCE"],
  ])("%s -> %s", (id, cls) => {
    expect(classifyBaseline(s(id)).incidentClass).toBe(cls);
  });
  it("ignores operator statements as facts", () => {
    expect(classifyBaseline(s("S5-adversarial-operator")).evidenceIds).not.toContain("E3");
  });
});

const good = {
  incident_class_guess: "DUPLICATE_MERCHANT_ORDER",
  hypotheses: [{ hypothesis_id: "H1", claim: "two handlers raced", supporting_evidence_ids: ["E3", "E4"], contradictory_evidence_ids: [], missing_evidence: [], next_test: "REPLAY_CONCURRENT_HANDLERS", confidence: 0.8 }],
  operator_summary: "Two orders were created for one payment.",
};

describe("AI output validation", () => {
  it("accepts a valid output", () => {
    expect(validateOutput(good, s("S1-dup-race")).error).toBeNull();
  });
  it("rejects invented evidence ids", () => {
    const bad = { ...good, hypotheses: [{ ...good.hypotheses[0], supporting_evidence_ids: ["E99"] }] };
    const v = validateOutput(bad, s("S1-dup-race"));
    expect(v.error).toBe("invented_evidence_ids");
    expect(v.inventedIds).toEqual(["E99"]);
  });
  it.each([
    [{}],
    [{ ...good, incident_class_guess: "CAPTURE_FAILED" }],
    [{ ...good, hypotheses: [] }],
    [{ ...good, hypotheses: [{ ...good.hypotheses[0], confidence: 7 }] }],
    [{ ...good, hypotheses: [{ ...good.hypotheses[0], next_test: "ISSUE_REFUND" }] }],
  ])("rejects malformed output %#", (bad) => {
    expect(validateOutput(bad, s("S1-dup-race")).error).toBe("schema_invalid");
  });
  it("bounds prompt input", () => {
    const huge = { ...s("S1-dup-race"), evidence: Array.from({ length: 200 }, (_, i) => ({ id: `E${i}`, cls: "MERCHANT_DB_OBSERVED" as const, at: "x", fact: { pad: "y".repeat(50) } })) };
    expect(() => buildPrompt(huge)).toThrow(/too large/);
  });
});

describe("Gemini adapter failure classification (mocked fetch)", () => {
  const scen = s("S1-dup-race");
  const resp = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
  it("429 rate limit vs daily quota", async () => {
    expect((await callGemini({ apiKey: "k-secret-1234", model: "m", scenario: scen, fetchImpl: resp(429, { error: { status: "RESOURCE_EXHAUSTED", message: "rate" } }) as any })).errorKind).toBe("rate_limited");
    expect((await callGemini({ apiKey: "k", model: "m", scenario: scen, fetchImpl: resp(429, { error: { message: "Quota exceeded per day" } }) as any })).errorKind).toBe("quota_exhausted");
  });
  it("billing, 5xx, invalid JSON, empty response", async () => {
    expect((await callGemini({ apiKey: "k", model: "m", scenario: scen, fetchImpl: resp(400, { error: { message: "Billing account required" } }) as any })).errorKind).toBe("billing_required");
    expect((await callGemini({ apiKey: "k", model: "m", scenario: scen, fetchImpl: resp(503, {}) as any })).errorKind).toBe("server_error");
    expect((await callGemini({ apiKey: "k", model: "m", scenario: scen, fetchImpl: resp(200, { candidates: [{ content: { parts: [{ text: "not json" }] } }] }) as any })).errorKind).toBe("invalid_json");
    expect((await callGemini({ apiKey: "k", model: "m", scenario: scen, fetchImpl: resp(200, { candidates: [{ finishReason: "SAFETY" }] }) as any })).errorKind).toBe("empty_response");
  });
  it("never echoes the API key in error detail", async () => {
    const r = await callGemini({ apiKey: "AIzaSyFAKEFAKEFAKEFAKEFAKEFAKE00", model: "m", scenario: scen, fetchImpl: resp(400, { error: { message: "API key AIzaSyFAKEFAKEFAKEFAKEFAKEFAKE00 not valid" } }) as any });
    expect(r.errorDetail).not.toContain("AIzaSyFAKE");
  });
  it("timeout classified", async () => {
    const r = await callGemini({ apiKey: "k", model: "m", scenario: scen, fetchImpl: (async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }) as any });
    expect(r.errorKind).toBe("timeout");
  });
  it("rejects unsafe model ids", async () => {
    await expect(callGemini({ apiKey: "k", model: "../x?y", scenario: scen, fetchImpl: resp(200, {}) as any })).rejects.toThrow();
  });
});
