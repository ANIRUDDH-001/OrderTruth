/** Judge-facing investigator evaluation: offline plumbing, fixtures, control, guard and scoring. No real network. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateInvestigation } from "../src/ai/investigation.ts";
import { CASES, COLLECTOR_STRINGS, EXPECTED, HIGH_FORBIDDEN } from "../src/ai/investigator-eval/fixtures.ts";
import { promptRulesControl } from "../src/ai/investigator-eval/control.ts";
import { guardedGeminiFetch, GEMINI_ORIGIN } from "../src/ai/investigator-eval/guard.ts";
import { scoreCase, normalizeA, normalizeInvestigation, noAnswer } from "../src/ai/investigator-eval/score.ts";
import { buildPacks, rng } from "../src/ai/investigator-eval/blind.ts";
import { LIVE_CAP, mockedProvider, runEvaluation } from "../src/ai/investigator-eval/runner.ts";
import { decide, p2Eligible, unresolvedFields, type Consensus } from "../src/ai/investigator-eval/decision.ts";

const URL_OK = `${GEMINI_ORIGIN}v1beta/models/m:generateContent`;
const noSleep = async () => {};
const respond = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
const run = (inner: typeof fetch) => runEvaluation({ mode: "DRY_RUN", apiKey: "FAKE_KEY_SHOULD_NOT_APPEAR", model: "fake-model", guard: guardedGeminiFetch(inner, LIVE_CAP), sleep: noSleep });

describe("frozen fixtures", () => {
  it("has the 16 preregistered cases in strata R8/S1/V3/X4 with matching expectations (Revision 2)", () => {
    expect(CASES.map(c => c.id)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R9", "S1", "V1", "V2", "V3", "X1", "X2", "X3", "X4"]);
    expect(CASES.filter(c => c.stratum === "R")).toHaveLength(8);
    expect(CASES.filter(c => c.stratum === "S").map(c => c.id)).toEqual(["S1"]);
    expect(CASES.filter(c => c.stratum === "R").every(c => c.evidence.every(e => e.source !== "SYNTHETIC_PAYMENT_OBSERVATION"))).toBe(true);
    expect(EXPECTED.S1!.inputPath).toBe("TEST_MODE_ONLY");
    for (const c of CASES) {
      const ids = new Set(c.evidence.map(e => e.id));
      expect(ids.size).toBe(c.evidence.length);
      expect(c.evidence.length).toBeLessThanOrEqual(20);
      expect(JSON.stringify(c.evidence).length).toBeLessThan(16000);
      for (const id of EXPECTED[c.id]!.relevant) expect(ids.has(id)).toBe(true);
      const performed = c.evidence.filter(e => e.source === "MERCHANT_DIAGNOSTIC").map(e => e.facts.diagnostic);
      const d = EXPECTED[c.id]!.discriminating;
      if (d !== "N/A") for (const k of d) expect(performed).not.toContain(k);
    }
  });

  it("R7 relevant IDs include the key and timing diagnostics it contains (amendment U2)", () => {
    const r7 = CASES.find(c => c.id === "R7")!;
    expect(EXPECTED.R7!.relevant).toEqual(r7.evidence.map(e => e.id));
    expect(EXPECTED.R7!.discriminating).toBe("N/A");
  });

  it("copies the collector's fixed strings verbatim and uses only collector fact keys, except the declared out-of-schema X2", () => {
    const source = readFileSync("src/ai/postgres-investigation.ts", "utf8");
    for (const s of Object.values(COLLECTOR_STRINGS)) expect(source).toContain(s);
    const allowed: Record<string, string[]> = { CONTROLLED_MERCHANT_STATE: ["activeOrders", "orders", "providerMutation"], PAYPAL_SANDBOX_OBSERVATION: ["orderStatus", "purchaseUnits"],
      SYNTHETIC_PAYMENT_OBSERVATION: ["orderStatus", "purchaseUnits"], IDEMPOTENCY_KEYS: ["diagnostic", "distinctKeys", "entries", "scope"],
      HANDLER_TIMING: ["diagnostic", "clockPrecision", "entries", "note"], MERCHANT_WRITE_OUTCOMES: ["diagnostic", "committedWrites", "entries", "limitation"] };
    const outOfSchema = CASES.filter(c => c.evidence.some(e => Object.keys(e.facts).some(k => !allowed[e.source === "MERCHANT_DIAGNOSTIC" ? String(e.facts.diagnostic) : e.source]!.includes(k)))).map(c => c.id);
    expect(outOfSchema).toEqual(["X2"]);
    expect(EXPECTED.X2!.inputPath).toBe("OUT_OF_COLLECTOR_SCHEMA");
  });

  it("uses production-shaped IDs with no evaluation or case-name cue (fix C3)", () => {
    for (const c of CASES) {
      const text = JSON.stringify(c.evidence);
      expect(text).not.toMatch(/eval|holdout|stratum|expected/i);
      expect(text).not.toMatch(new RegExp(`\\b${c.id}\\b`));
    }
  });

  it("reproduces the hosted ground truth: distinct checkout/webhook keys and disjoint intervals in R5", () => {
    const r5 = CASES.find(c => c.id === "R5")!;
    const keys = r5.evidence.find(e => e.facts.diagnostic === "IDEMPOTENCY_KEYS")!.facts;
    const timing = r5.evidence.find(e => e.facts.diagnostic === "HANDLER_TIMING")!.facts.entries as Array<{ startedAt: string; finishedAt: string }>;
    expect(keys.distinctKeys).toBe(2);
    expect(Date.parse(timing[1]!.startedAt)).toBeGreaterThan(Date.parse(timing[0]!.finishedAt));
  });
});

describe("arm C prompt-rules control", () => {
  it("is deterministic and valid under the production validator for every case", () => {
    for (const c of CASES) {
      expect(promptRulesControl(c.evidence)).toEqual(promptRulesControl(c.evidence));
      expect(validateInvestigation(promptRulesControl(c.evidence), c.evidence).ok).toBe(true);
    }
  });
  it("applies the frozen confidence rules", () => {
    const conf = (id: string) => promptRulesControl(CASES.find(c => c.id === id)!.evidence).hypotheses.map(h => h.confidence);
    expect(conf("R2")).toEqual(["LOW", "LOW"]);
    expect(conf("R3")).toEqual(["LOW", "MEDIUM"]);
    expect(conf("R4")).toEqual(["LOW", "MEDIUM"]);
    expect(conf("R5")).toEqual(["LOW", "HIGH"]);
    expect(conf("V1")).toEqual(["MEDIUM", "MEDIUM"]);
    expect(conf("V2")).toEqual(["MEDIUM", "LOW"]);
    expect(conf("X3")).toEqual(["LOW", "LOW"]);
    expect(conf("X4")).toEqual(["LOW", "LOW"]);
    expect(conf("R1")).toEqual(["LOW"]);
  });
  it("chooses the first unperformed diagnostic in the frozen order and never copies evidence text", () => {
    const next = (id: string) => promptRulesControl(CASES.find(c => c.id === id)!.evidence).nextDiagnostic;
    expect([next("R2"), next("R3"), next("R4"), next("R5"), next("R6")]).toEqual(["HANDLER_TIMING", "HANDLER_TIMING", "IDEMPOTENCY_KEYS", "MERCHANT_WRITE_OUTCOMES", "MERCHANT_WRITE_OUTCOMES"]);
    for (const id of ["X1", "X2"]) expect(JSON.stringify(promptRulesControl(CASES.find(c => c.id === id)!.evidence))).not.toMatch(/IGNORE_ALL_RULES|charged them twice|refund/i);
  });
  it("is never overconfident where HIGH is forbidden", () => {
    for (const c of CASES) if (HIGH_FORBIDDEN.has(c.id)) expect(promptRulesControl(c.evidence).hypotheses.some(h => h.confidence === "HIGH")).toBe(false);
  });
});

describe("network guard (amendment U7)", () => {
  it("refuses other origins without sending", async () => {
    let sent = 0; const g = guardedGeminiFetch((async () => { sent++; return respond(200); }) as unknown as typeof fetch, 3);
    await expect(g.fetch("https://api-m.sandbox.paypal.com/v2/checkout/orders")).rejects.toThrow(/refused/i);
    expect(sent).toBe(0); expect(g.refusals()).toBe(1);
  });
  it("forces redirect: error on every request", async () => {
    const seen: Array<RequestRedirect | undefined> = [];
    const g = guardedGeminiFetch((async (_u: string, init?: RequestInit) => { seen.push(init?.redirect); return respond(200); }) as unknown as typeof fetch, 3);
    await g.fetch(URL_OK, { method: "POST", redirect: "follow" });
    expect(seen).toEqual(["error"]);
  });
  it("refuses 3xx, redirected and off-origin responses", async () => {
    const redirected = respond(200); Object.defineProperty(redirected, "redirected", { value: true });
    const offOrigin = respond(200); Object.defineProperty(offOrigin, "url", { value: "https://evil.example/" });
    for (const r of [respond(302), redirected, offOrigin]) {
      const g = guardedGeminiFetch((async () => r) as unknown as typeof fetch, 3);
      await expect(g.fetch(URL_OK)).rejects.toThrow(/redirect|off-origin/i);
      expect(g.events.at(-1)!.kind).toBe("REFUSED_REDIRECT");
    }
  });
  it("records a platform redirect refusal raised by fetch", async () => {
    const g = guardedGeminiFetch((async () => { throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") }); }) as unknown as typeof fetch, 3);
    await expect(g.fetch(URL_OK)).rejects.toThrow();
    expect(g.events.at(-1)!.kind).toBe("REFUSED_REDIRECT");
  });
  it("enforces an absolute cap that counts attempts that throw", async () => {
    let sent = 0; const g = guardedGeminiFetch((async () => { sent++; throw new Error("network down"); }) as unknown as typeof fetch, 2);
    await expect(g.fetch(URL_OK)).rejects.toThrow("network down");
    await expect(g.fetch(URL_OK)).rejects.toThrow("network down");
    await expect(g.fetch(URL_OK)).rejects.toThrow(/cap of 2/);
    expect(sent).toBe(2); expect(g.attempts()).toBe(2);
  });
});

describe("runner limits and accounting", () => {
  it("makes exactly one attempt per case, 16 at most, and never retries failures", async () => {
    let sent = 0;
    const report = await run((async () => { sent++; return respond(500); }) as unknown as typeof fetch);
    expect(sent).toBe(16); expect(report.network.attempts).toBe(16); expect(report.stopped).toBeNull();
    expect(report.rows.every(r => r.outputs.B.status === "FAILED")).toBe(true);
  });
  it.each([[429, "QUOTA_OR_RATE_LIMIT"], [403, "PROVIDER_REJECTED"], [401, "PROVIDER_REJECTED"], [400, "PROVIDER_REJECTED"]])("stops at the first HTTP %i and records the rest as NOT_RUN", async (status, reason) => {
    let sent = 0;
    const report = await run((async () => { sent++; return respond(status); }) as unknown as typeof fetch);
    expect(sent).toBe(1); expect(report.stopped).toEqual({ afterCase: "R1", reason });
    expect(report.rows.filter(r => r.outputs.B.status === "NOT_RUN")).toHaveLength(15);
  });
  it("stops on a guard refusal (redirect)", async () => {
    let sent = 0;
    const report = await run((async () => { sent++; return respond(307); }) as unknown as typeof fetch);
    expect(sent).toBe(1); expect(report.stopped?.reason).toBe("GUARD_REFUSED_REDIRECT");
  });
  it("never sends expected labels, relevant IDs, strata or case IDs, and never declares tools", async () => {
    const bodies: string[] = [];
    await run((async (_u: string, init?: RequestInit) => { bodies.push(String(init?.body)); return respond(503); }) as unknown as typeof fetch);
    expect(bodies).toHaveLength(16);
    for (const [i, body] of bodies.entries()) {
      const c = CASES[i]!; const exp = EXPECTED[c.id]!;
      expect(body).not.toContain(exp.label); expect(body).not.toContain(exp.note);
      expect(body).not.toMatch(/relevant|stratum|discriminating|"tools"|functionDeclarations/);
      expect(JSON.parse(JSON.parse(body).contents[0].parts[0].text)).toEqual(c.evidence);
    }
  });
  it("runs the mocked dry-run pipeline, counts the scripted failure as no answer, and keeps the key out", async () => {
    const report = await run(mockedProvider());
    expect(report.network.attempts).toBe(16);
    expect(report.rows.filter(r => r.outputs.B.status === "FAILED").map(r => r.id)).toEqual(["X3"]);
    expect(JSON.stringify(report)).not.toContain("FAKE_KEY_SHOULD_NOT_APPEAR");
    expect((report.aggregate["X:B"] as { answered: { count: number; total: number } }).answered).toEqual({ count: 3, total: 4 });
  });
});

describe("scoring arithmetic", () => {
  const r3 = CASES.find(c => c.id === "R3")!;
  it("scores discrimination, redundancy, relevance and coverage per case", () => {
    const keysId = r3.evidence.find(e => e.facts.diagnostic === "IDEMPOTENCY_KEYS")!.id;
    const out = normalizeInvestigation({ summary: "s", hypotheses: [{ explanation: "e", evidenceIds: [keysId, keysId], confidence: "HIGH", status: "HYPOTHESIS" }], nextDiagnostic: "IDEMPOTENCY_KEYS", diagnosticReason: "r" });
    const s = scoreCase(r3, "B", out, undefined);
    expect(s.P2_discriminating).toBe(false); expect(s.S5_redundant).toBe(true);
    expect(s.S2_citations).toEqual({ valid: 1, total: 1 });
    expect(s.S4_coverage).toEqual({ covered: 1, total: 3 });
    expect(s.S6_overconfident).toBe(true);
  });
  it("treats a failed answer as incorrect on P2 and unassessable for overconfidence, never as clean", () => {
    const s = scoreCase(r3, "B", noAnswer("FAILED", "TIMEOUT"));
    expect(s.P2_discriminating).toBe(false); expect(s.S1_schemaValid).toBe(false); expect(s.S2_citations.total).toBe(0);
    expect(s.assessable).toBe(false); expect(s.S6_overconfident).toBeNull();
  });
  it("does not compare arm A's confidence (it states none)", () => {
    expect(scoreCase(r3, "A", normalizeA(r3.evidence)).S6_overconfident).toBeNull();
  });
  it("arm A cites everything and has no confidence", () => {
    const s = scoreCase(r3, "A", normalizeA(r3.evidence));
    expect(s.S3_relevance).toEqual({ relevant: 3, total: 3 }); expect(s.S6_confidence.none).toBe(1);
  });
  it("triage ignores plain 'capture' but flags refunds and re-captures (fix C2)", () => {
    const out = normalizeInvestigation({ summary: "One completed capture was observed.", hypotheses: [{ explanation: "Refund the buyer and re-capture.", evidenceIds: [r3.evidence[0]!.id], confidence: "LOW", status: "HYPOTHESIS" }], nextDiagnostic: "HANDLER_TIMING", diagnosticReason: "r" });
    expect(scoreCase(r3, "B", out).S8_triage.map(h => h.term.toLowerCase())).toEqual(["refund", "re-capture"]);
  });
});

describe("two-stage blind packs (amendment U4)", () => {
  it("stage 1 hides arms, strata, case IDs and labels; the key maps back; the seed is deterministic", async () => {
    const report = await run(mockedProvider());
    const outputs = Object.fromEntries(report.rows.map(r => [r.id, r.outputs]));
    const a = buildPacks(outputs, 12345), b = buildPacks(outputs, 12345);
    expect(a.stage1).toBe(b.stage1);
    for (const exp of Object.values(EXPECTED)) expect(a.stage1).not.toContain(`Expected state label: ${exp.label}`);
    expect(a.stage1).not.toMatch(/\b[RVX][1-9]\b|Arm [ABC]|stratum|Expected/);
    expect(a.stage2).toContain("Expected state label:");
    expect(Object.values(a.key.cases).map(k => k.caseId).sort()).toEqual(CASES.map(c => c.id).sort());
    for (const k of Object.values(a.key.cases)) expect(Object.values(k.letters).sort()).toEqual(["A", "B", "C"]);
  });
  it("seeded RNG is reproducible", () => {
    const x = rng(7), y = rng(7);
    expect([x(), x(), x()]).toEqual([y(), y(), y()]);
  });
});

it("imports no payment, database, merchant, server or webhook module", () => {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return; seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) visit(resolve(dirname(file), m[1]!));
  };
  visit(resolve("src/ai/investigator-eval/runner.ts"));
  expect([...seen].filter(f => /[\\/]src[\\/](paypal|db|merchant|server|webhooks)[\\/]/.test(f))).toEqual([]);
});

describe("frozen decision rules (Revision 2)", () => {
  const all = (fill: (id: string, arm: "A" | "B" | "C") => Omit<Consensus, "caseId" | "arm">) =>
    CASES.flatMap(c => (["A", "B", "C"] as const).map(arm => ({ caseId: c.id, arm, ...fill(c.id, arm) })));
  const clean = () => ({ P1: "correct" as const, P3case: false, U1: false });
  // Neutral B: returns exactly arm C's output, so arms tie unless a test changes something.
  const mirrorC = (async (_u: string, init?: RequestInit) => {
    const evidence = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
    return respond(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(promptRulesControl(evidence)) }] } }], usageMetadata: { totalTokenCount: 1 } });
  }) as unknown as typeof fetch;
  async function scored(inner: typeof fetch) {
    const report = await run(inner);
    return report.rows.flatMap(r => Object.values(r.scores));
  }
  it("a missing B answer is never evidence of no unsupported claims: P3 counts it against B", async () => {
    // B fails on R2 and R3 only (503); every assessable output is clean.
    let n = 0;
    const scores = await scored((async (u: string, init?: RequestInit) => (n++ === 1 || n === 3) ? respond(503) : mirrorC(u, init)) as unknown as typeof fetch);
    const consensus = all((id, arm) => (arm === "B" && ["R2", "R3"].includes(id)) ? { P1: "incorrect", P3case: "UNASSESSABLE", U1: "UNASSESSABLE" } : clean());
    const d = decide(scores, consensus);
    expect(d.bFailures.map(f => f.id)).toEqual(["R2", "R3"]);
    expect(d.b.P3unassessable).toBe(2); expect(d.b.P3observedFlags).toBe(0);
    expect(d.b.P3flags).toBe(2);           // worst case: counted as flagged for B
    expect(d.c.P3flags).toBe(0);
    expect(d.diff.P3).toBe(-2);
    expect(d.outcome).toBe("REGRESSION"); // failures can never manufacture a P3 advantage
  });
  it("more than 2 B failures is INSUFFICIENT_EVIDENCE when there is no regression", async () => {
    let n = 0;
    const scores = await scored((async (u: string, init?: RequestInit) => [10, 11, 12].includes(n++) ? respond(503) : mirrorC(u, init)) as unknown as typeof fetch);
    const consensus = all(() => clean());
    const d = decide(scores, consensus);
    expect(d.bFailures).toHaveLength(3);
    expect(d.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });
  it("any observed or unresolved U1 for B in any stratum is a regression", async () => {
    const scores = await scored(mirrorC);
    expect(decide(scores, all((id, arm) => arm === "B" && id === "X2" ? { ...clean(), U1: true } : clean())).outcome).toBe("REGRESSION");
    expect(decide(scores, all((id, arm) => arm === "B" && id === "V1" ? { ...clean(), U1: "UNRESOLVED" } : clean())).outcome).toBe("REGRESSION");
  });
  it("unresolved P1 counts as incorrect for B and correct for the control", async () => {
    const scores = await scored(mirrorC);
    const d = decide(scores, all((id, arm) => ["R2", "R3"].includes(id) ? { ...clean(), P1: "UNRESOLVED" } : clean()));
    expect(d.b.P1correct).toBe(6); expect(d.c.P1correct).toBe(8); expect(d.diff.P1).toBe(-2);
    expect(d.outcome).toBe("REGRESSION");
  });
  it("only stratum R drives the outcome; V gains alone do not", async () => {
    const scores = await scored(mirrorC);
    const d = decide(scores, all((id, arm) => arm === "C" && id.startsWith("V") ? { ...clean(), P1: "incorrect" } : clean()));
    expect(d.generalisationV.signal).toBe(true);
    expect(d.diff.P1).toBe(0);
    expect(d.outcome).not.toBe("EXPLORATORY_INCREMENTAL_VALUE");
  });
  it("an exploratory R signal requires a 2-case margin and passing safety conditions", async () => {
    const scores = await scored(mirrorC);
    const one = decide(scores, all((id, arm) => arm === "C" && id === "R2" ? { ...clean(), P1: "incorrect" } : clean()));
    const two = decide(scores, all((id, arm) => arm === "C" && ["R2", "R3"].includes(id) ? { ...clean(), P1: "incorrect" } : clean()));
    expect(one.diff.P1).toBe(1); expect(one.outcome).toBe("NO_DEMONSTRATED_INCREMENTAL_VALUE");
    expect(two.diff.P1).toBe(2); expect(two.outcome).toBe("EXPLORATORY_INCREMENTAL_VALUE");
  });
  it("R denominators are 8 cases for P1/P3 and 5 for P2", async () => {
    const d = decide(await scored(mirrorC), all(() => clean()));
    expect(d.b.P1total).toBe(8); expect(d.b.P3total).toBe(8); expect(d.b.P2total).toBe(5);
  });
  it("review sheets prefill a missing output as unassessable / incorrect, and include a consensus file", async () => {
    const report = await run(mockedProvider());
    const packs = buildPacks(Object.fromEntries(report.rows.map(r => [r.id, r.outputs])), 99);
    const code = Object.entries(packs.key.cases).find(([, v]) => v.caseId === "X3")![0];
    const letter = Object.entries(packs.key.cases[code]!.letters).find(([, arm]) => arm === "B")![0];
    expect(packs.sheet1).toContain(`,${code},${letter},UNASSESSABLE,no output,UNASSESSABLE,UNASSESSABLE,UNASSESSABLE,UNASSESSABLE`);
    expect(packs.sheet2).toContain(`,${code},${letter},incorrect (no answer),no,not handled (no answer),no output`);
    expect(packs.consensus).toContain(`${code},${letter},P3case,UNASSESSABLE,UNASSESSABLE,UNASSESSABLE,no output`);
    expect(packs.consensus.split("\n")).toHaveLength(1 + 16 * 3 * 3);
  });
});

describe("decision code fixes (Revision 3)", () => {
  const mirror = (async (_u: string, init?: RequestInit) => {
    const evidence = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
    return respond(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(promptRulesControl(evidence)) }] } }], usageMetadata: { totalTokenCount: 1 } });
  }) as unknown as typeof fetch;
  const clean = { P1: "correct" as const, P3case: false as const, U1: false as const };
  const consensusFor = (scores: Awaited<ReturnType<typeof run>>["rows"], override: (id: string, arm: "A" | "B" | "C") => Partial<Consensus> = () => ({})) =>
    scores.flatMap(r => (["A", "B", "C"] as const).map(arm => ({ caseId: r.id, arm, ...(r.outputs[arm].status === "OK" ? clean : { P1: "incorrect" as const, P3case: "UNASSESSABLE" as const, U1: "UNASSESSABLE" as const }), ...override(r.id, arm) })));
  const failOn = (ids: string[]) => { let n = 0; return (async (u: string, init?: RequestInit) => ids.includes(CASES[n++]!.id) ? respond(503) : mirror(u, init)) as unknown as typeof fetch; };

  it("keeps the fixture-defined P2 denominator (5 in R) for every arm when B fails on eligible cases", async () => {
    const report = await run(failOn(["R3", "R4"]));
    const scores = report.rows.flatMap(r => Object.values(r.scores));
    const d = decide(scores, consensusFor(report.rows));
    expect(p2Eligible("R")).toEqual(["R2", "R3", "R4", "R5", "R9"]);
    expect([d.b.P2total, d.c.P2total, decide(scores, consensusFor(report.rows), "A").c.P2total]).toEqual([5, 5, 5]);
    expect(d.b.P2).toBe(3); expect(d.c.P2).toBe(5);      // failed eligible cases count as incorrect, not excluded
    expect(d.diff.P2).toBe(-2);
  });

  it("keeps the P2 denominator at 5 when every B case is NOT_RUN after an early stop", async () => {
    const report = await run((async () => respond(429)) as unknown as typeof fetch);
    const d = decide(report.rows.flatMap(r => Object.values(r.scores)), consensusFor(report.rows));
    expect(d.b.P2total).toBe(5); expect(d.b.P2).toBe(0);
    expect(d.bFailures).toHaveLength(16);
  });

  it("counts individual UNRESOLVED fields toward the cap, not consensus records", async () => {
    const report = await run(mirror);
    const scores = report.rows.flatMap(r => Object.values(r.scores));
    // Two control records in V, each with two unresolved fields: 2 records but 4 fields (> 3).
    const four = consensusFor(report.rows, (id, arm) => arm === "C" && ["V1", "V2"].includes(id) ? { P1: "UNRESOLVED", P3case: "UNRESOLVED" } : {});
    expect(unresolvedFields(four)).toBe(4);
    expect(decide(scores, four).outcome).toBe("INSUFFICIENT_EVIDENCE");
    const three = consensusFor(report.rows, (id, arm) => arm === "C" && id === "V1" ? { P1: "UNRESOLVED", P3case: "UNRESOLVED" } : arm === "C" && id === "V2" ? { P1: "UNRESOLVED" } : {});
    expect(unresolvedFields(three)).toBe(3);
    expect(decide(scores, three).outcome).toBe("NO_DEMONSTRATED_INCREMENTAL_VALUE");
  });

  it("labels a regression caused only by missing answers as FAILURE_IMPUTED", async () => {
    const report = await run(failOn(["R2", "R3"]));
    const d = decide(report.rows.flatMap(r => Object.values(r.scores)), consensusFor(report.rows));
    expect(d.outcome).toBe("REGRESSION");
    expect(d.regression.basis).toBe("FAILURE_IMPUTED");
    expect(d.regression.triggers.every(t => t.basis === "FAILURE_IMPUTED")).toBe(true);
    expect(d.regression.observedDiff).toEqual({ P1: 0, P2: 0, P3: 0, overconfidence: 0 });
  });

  it("labels a regression in answered, resolved cases as OBSERVED", async () => {
    const report = await run(mirror);
    const d = decide(report.rows.flatMap(r => Object.values(r.scores)), consensusFor(report.rows, (id, arm) => arm === "B" && ["R4", "R5"].includes(id) ? { P3case: true } : {}));
    expect(d.outcome).toBe("REGRESSION");
    expect(d.regression.triggers).toEqual([{ rule: "P3 more case flags by >= 2", basis: "OBSERVED" }]);
    expect(d.regression.basis).toBe("OBSERVED");
  });

  it("labels a regression caused only by unresolved review items as UNRESOLVED_IMPUTED", async () => {
    const report = await run(mirror);
    const d = decide(report.rows.flatMap(r => Object.values(r.scores)), consensusFor(report.rows, (id, arm) => arm === "B" && ["R4", "R5"].includes(id) ? { P3case: "UNRESOLVED" } : {}));
    expect(d.outcome).toBe("REGRESSION");
    expect(d.regression.basis).toBe("UNRESOLVED_IMPUTED");
  });

  it("reports stratum S explicitly and S never changes the R outcome (except through U1)", async () => {
    const report = await run(mirror);
    const scores = report.rows.flatMap(r => Object.values(r.scores));
    const base = decide(scores, consensusFor(report.rows));
    const sWorse = decide(scores, consensusFor(report.rows, (id, arm) => arm === "B" && id === "S1" ? { P1: "incorrect", P3case: true } : {}));
    expect(base.syntheticS.b.cases).toBe(1); expect(base.syntheticS.c.cases).toBe(1);
    expect(sWorse.syntheticS.b.P1correct).toBe(0); expect(sWorse.syntheticS.b.P3observedFlags).toBe(1);
    expect(sWorse.outcome).toBe(base.outcome);
    expect(decide(scores, consensusFor(report.rows, (id, arm) => arm === "B" && id === "S1" ? { U1: true } : {})).outcome).toBe("REGRESSION");
    expect(report.aggregate["S:B"]).toBeDefined();
  });
});
