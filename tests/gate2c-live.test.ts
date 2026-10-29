/** Gate 2C live runner: plumbing, caps and safety only. Every test injects a fake fetch; no real call. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HOLDOUT } from "../src/ai/holdout.ts";
import { validateAdvisory } from "../src/ai/advisory.ts";
import { AiHypothesisSchema } from "../src/ai/gemini.ts";
import { FROZEN_CASE_IDS, MAX_LIVE_CALLS, policyOnlyControl, runLiveEvaluation } from "../src/ai/holdout-live-eval.ts";

const GEMINI = "https://generativelanguage.googleapis.com/";
const ok = (body: unknown) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } }), { status: 200 });
const noSleep = async () => {};

describe("frozen live design", () => {
  it("freezes exactly the 10 preregistered case IDs, all present in the holdout", () => {
    expect(FROZEN_CASE_IDS).toEqual(["H2C-01", "H2C-05", "H2C-06", "H2C-10", "H2C-12", "H2C-17", "H2C-19", "H2C-21", "H2C-22", "H2C-28"]);
    expect(MAX_LIVE_CALLS).toBe(10);
    for (const id of FROZEN_CASE_IDS) expect(HOLDOUT.some(h => h.scenario.id === id)).toBe(true);
  });

  it("policy-only control is schema-valid and accepted by the advisory validator for every frozen case", () => {
    for (const id of FROZEN_CASE_IDS) {
      const s = HOLDOUT.find(h => h.scenario.id === id)!.scenario;
      const control = policyOnlyControl(s);
      expect(AiHypothesisSchema.safeParse(control).success).toBe(true);
      expect(validateAdvisory(control, s).ok).toBe(true);
    }
  });

  it("imports no payment, database, merchant or server module (cannot repair or mutate state)", () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return; seen.add(file);
      for (const m of readFileSync(file, "utf8").matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) visit(resolve(dirname(file), m[1]!));
    };
    visit(resolve("src/ai/holdout-live-eval.ts"));
    const forbidden = [...seen].filter(f => /[\\/]src[\\/](paypal|db|merchant|server|webhooks)[\\/]/.test(f) || /checkout-service/.test(f));
    expect(forbidden).toEqual([]);
  });
});

describe("live runner limits", () => {
  it("never sends oracle labels, traps or relevant IDs to the model", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => { bodies.push(String(init?.body)); return new Response("{}", { status: 503 }); }) as unknown as typeof fetch;
    await runLiveEvaluation({ apiKey: "FAKE_TEST_KEY", model: "fake-model", fetchImpl, sleep: noSleep });
    expect(bodies).toHaveLength(10);
    for (const [i, id] of FROZEN_CASE_IDS.entries()) {
      const row = HOLDOUT.find(h => h.scenario.id === id)!;
      expect(bodies[i]).not.toContain(row.trap);
      expect(bodies[i]).not.toContain("expected");
      expect(bodies[i]).not.toContain("relevantIds");
    }
  });

  it("makes at most one call per case, at most 10 in total, with no retries on failure", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response("{}", { status: 500 }); }) as unknown as typeof fetch;
    const report = await runLiveEvaluation({ apiKey: "FAKE_TEST_KEY", model: "fake-model", fetchImpl, sleep: noSleep });
    expect(calls).toBe(10);
    expect(report.calls.made).toBe(10);
    expect(report.rows.every(r => r.ai.status === "FAILED")).toBe(true);
    expect(report.summary.ai.successfulOutputs.count).toBe(0);
  });

  it.each([[429, "RESOURCE_EXHAUSTED quota exceeded"], [403, "PERMISSION_DENIED"], [400, "API key not valid"], [402, "billing required"]])(
    "stops at the first access/quota/billing uncertainty (HTTP %i)", async (status, message) => {
      let calls = 0;
      const fetchImpl = (async () => { calls++; return new Response(JSON.stringify({ error: { status: "X", message } }), { status }); }) as unknown as typeof fetch;
      const report = await runLiveEvaluation({ apiKey: "FAKE_TEST_KEY", model: "fake-model", fetchImpl, sleep: noSleep });
      expect(calls).toBe(1);
      expect(report.stopped).toMatchObject({ afterCase: "H2C-01" });
      expect(report.rows.filter(r => r.ai.status === "NOT_RUN")).toHaveLength(9);
    });

  it("refuses any host other than the Gemini API and never exceeds the cap", async () => {
    const { guardedFetch } = await import("../src/ai/holdout-live-eval.ts");
    let underlying = 0;
    const fetchImpl = (async () => { underlying++; return new Response("{}"); }) as unknown as typeof fetch;
    const guard = guardedFetch(fetchImpl, 2);
    await expect(guard.fetch("https://api-m.sandbox.paypal.com/v2/checkout/orders")).rejects.toThrow(/refused/i);
    await guard.fetch(`${GEMINI}v1beta/models/x:generateContent`);
    await guard.fetch(`${GEMINI}v1beta/models/x:generateContent`);
    await expect(guard.fetch(`${GEMINI}v1beta/models/x:generateContent`)).rejects.toThrow(/cap/i);
    expect(underlying).toBe(2);
    expect(guard.count()).toBe(2);
  });

  it("scores a successful output, separates acceptance, and keeps the key out of the report", async () => {
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      const s = HOLDOUT.find(h => String(init?.body).includes(`\\"scenario\\":\\"${h.scenario.id}\\"`))!.scenario;
      return ok(policyOnlyControl(s));
    }) as unknown as typeof fetch;
    const report = await runLiveEvaluation({ apiKey: "FAKE_TEST_KEY_SHOULD_NOT_APPEAR", model: "fake-model", fetchImpl, sleep: noSleep });
    expect(report.summary.ai.successfulOutputs.count).toBe(10);
    expect(report.summary.ai.accepted.count).toBe(10);
    expect(report.summary.ai.tokens.total).toBe(150);
    expect(JSON.stringify(report)).not.toContain("FAKE_TEST_KEY_SHOULD_NOT_APPEAR");
    expect(report.summary.control.classification.total).toBe(10);
    expect(report.summary.baseline.classification.total).toBe(10);
  });
});
