import { createHash } from "node:crypto";
import { mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll,describe,expect,it } from "vitest";
import { guardedGeminiFetch } from "../src/ai/investigator-eval/guard.ts";
import { DEV,devItems } from "../src/ai/ask-eval/devset.ts";
import { FROZEN_HOLDOUT_SHA256,loadHoldout,loadKey } from "../src/ai/ask-eval/holdout.ts";
import { callAsk } from "../src/ai/ask-eval/prompt.ts";
import { freezeDrift,freezeManifest,liveGateErrors,mockedProvider,runEvaluation,summaryLines,textSha } from "../src/ai/ask-eval/runner.ts";
import { rulesAnswer } from "../src/ai/ask-eval/rules.ts";

const dir = mkdtempSync(join(tmpdir(),"ot-ask-"));
afterAll(() => rmSync(dir,{ recursive: true,force: true }));
const file = (name: string,text: string) => { const p = join(dir,name); writeFileSync(p,text); return { path: p,sha: createHash("sha256").update(text).digest("hex") }; };

describe("holdout loading",() => {
  it("refuses any question file whose SHA-256 is not the frozen one",() => {
    const f = file("q.csv","id,question\nQ01,hello\n");
    expect(() => loadHoldout(f.path)).toThrow(/SHA-256 mismatch/);
    expect(FROZEN_HOLDOUT_SHA256).toBe("df2fe5b4a3786c3ccaa76962fb0a24eb46b00ffd5cd195091fec71ac37f66bdf");
  });
  it("passes on only the id and question columns, parsing quotes, commas, newlines and a BOM",() => {
    const f = file("q2.csv","﻿id,question,answerable,good_answer\nQ01,\"Was it, really, \"\"twice\"\"?\",yes,\"one capture\"\nQ02,\"two\nlines\",no,x\nQ03,plain,partly,y\n");
    expect(loadHoldout(f.path,{ expectedSha: f.sha,expectedCount: 3 })).toEqual({ sha256: f.sha,questions: [{ id: "Q01",question: "Was it, really, \"twice\"?" },{ id: "Q02",question: "two\nlines" },{ id: "Q03",question: "plain" }] });
  });
  for (const [name,text,message] of [["a wrong row count","id,question\nQ01,a\nQ02,b\n",/expected 3 questions, found 2/],["duplicate ids","id,question\nQ01,a\nQ01,b\nQ03,c\n",/duplicate question id Q01/],
    ["no question column","id,text\nQ01,a\nQ02,b\nQ03,c\n",/needs id and question columns/],["an empty question","id,question\nQ01,a\nQ02,\nQ03,c\n",/empty question Q02/]] as const)
    it(`refuses ${name}`,() => { const f = file(`bad-${name.length}.csv`,text); expect(() => loadHoldout(f.path,{ expectedSha: f.sha,expectedCount: 3 })).toThrow(message); });
});

describe("answer key loading",() => {
  const header = "questionId,snapshot,expected,required,acceptable,mustFlagUnknown,tags\n";
  const rows = "Q01,PRE,ANSWER,PAY_CAPTURE_COUNT,PAY_CAPTURE;ORD_COUNT,no,\nQ01,POST,ANSWER,PAY_CAPTURE_COUNT,,no,\nQ02,PRE,REFUSE,,POLICY,no,non-english\nQ02,POST,REFUSE,,POLICY,no,non-english\n";
  it("loads a valid key for every question in both snapshots",() => {
    const f = file("k.csv",header+rows);
    const key = loadKey(f.path,f.sha,["Q01","Q02"]);
    expect(key).toHaveLength(4);
    expect(key[0]).toEqual({ questionId: "Q01",snapshot: "PRE",expected: "ANSWER",required: ["PAY_CAPTURE_COUNT"],acceptable: ["PAY_CAPTURE","ORD_COUNT"],mustFlagUnknown: false,tags: [] });
    expect(key[2]!.tags).toEqual(["non-english"]);
  });
  it("accepts a question disputed in both states",() => {
    const f = file("k-disputed.csv",header+rows.replace(/non-english\n/g,"non-english;disputed\n"));
    expect(loadKey(f.path,f.sha,["Q01","Q02"]).map(k => k.tags.includes("disputed"))).toEqual([false,false,true,true]);
  });
  for (const [name,text,ids,message] of [
    ["a wrong key hash",header+rows,["Q01","Q02"],/Answer key SHA-256 mismatch/],
    ["a fact that the snapshot lacks",header+rows.replace("Q01,PRE,ANSWER,PAY_CAPTURE_COUNT","Q01,PRE,ANSWER,RECEIPT"),["Q01","Q02"],/Q01\/PRE: fact RECEIPT not in PRE/],
    ["a missing snapshot row",header+rows.split("\n").filter(l => !l.startsWith("Q01,PRE")).join("\n"),["Q01","Q02"],/no key row for Q01\/PRE/],
    ["an unknown expected value",header+rows.replace("REFUSE","MAYBE"),["Q01","Q02"],/Q02\/PRE: expected must be ANSWER, ABSTAIN or REFUSE/],
    ["a question with no key",header+rows,["Q01","Q02","Q03"],/no key row for Q03\/PRE/],
    ["a non-english tag on only one state",header+rows.replace("Q02,POST,REFUSE,,POLICY,no,non-english","Q02,POST,REFUSE,,POLICY,no,"),["Q01","Q02"],/Q02: non-english must tag both states/],
    ["a disputed tag on only one state",header+rows.replace("Q02,POST,REFUSE,,POLICY,no,non-english","Q02,POST,REFUSE,,POLICY,no,non-english;disputed"),["Q01","Q02"],/Q02: disputed must tag both states/],
  ] as const) it(`refuses ${name}`,() => {
    const f = file(`k-${name.length}.csv`,text);
    expect(() => loadKey(f.path,name === "a wrong key hash" ? "0".repeat(64) : f.sha,[...ids])).toThrow(message);
  });
});

describe("offline evaluation run",() => {
  const questions = DEV.map(d => ({ id: d.id,question: d.question })),key = devItems().map(d => d.key);
  const harness = (mode: "rules-echo" | "adversarial" | "quota-at-5",cap = questions.length*2*2,runKey = key) => {
    const guard = guardedGeminiFetch(mockedProvider(mode),cap),seen = { rules: [] as string[],ai: [] as string[] };
    const run = () => runEvaluation({ mode: "DRY_RUN",model: "mock-model",questions,key: runKey,guard,sleep: async () => {},spacingMs: 0,
      rules: (q,s) => { seen.rules.push(`${s}|${q}`); return rulesAnswer(q,s); },
      ask: (q,s) => { seen.ai.push(`${s}|${q}`); return callAsk({ apiKey: "MOCK",model: "mock-model",question: q,snapshot: s,fetchImpl: guard.fetch }); } });
    return { guard,seen,run };
  };
  it("gives both arms identical inputs and reports no lift when the AI echoes the rules",async () => {
    const h = harness("rules-echo"),report = await h.run();
    expect(h.seen.rules).toHaveLength(84);
    expect(h.seen.ai).toEqual([...h.seen.rules,...h.seen.rules]);
    expect(h.guard.attempts()).toBe(168);
    expect(report.runs.map(r => r.ai.correct)).toEqual([report.rules.correct,report.rules.correct]);
    expect(report.decision.verdict).toBe("NO_GO");
    expect(report.decision.checks.find(c => c.id === "G1_LIFT")!.status).toBe("FAIL");
  });
  it("reports 42 questions in two states with paired per-question and per-state breakdowns",async () => {
    const report = await harness("rules-echo").run();
    expect([report.rules.questions,report.rules.n,report.rules.byState.PRE.n,report.rules.byState.POST.n]).toEqual([42,84,42,42]);
    expect(report.perQuestion).toHaveLength(42);
    expect(report.perQuestion[0]).toEqual({ questionId: "d01",rules: { PRE: true,POST: true },ai: [{ PRE: true,POST: true },{ PRE: true,POST: true }] });
    expect(report.paired.map(p => p.items)).toEqual([{ both: 84,aiOnly: 0,rulesOnly: 0,neither: 0 },{ both: 84,aiOnly: 0,rulesOnly: 0,neither: 0 }]);
    expect(report.paired.map(p => p.questions)).toEqual([{ both: 42,aiOnly: 0,rulesOnly: 0,neither: 0 },{ both: 42,aiOnly: 0,rulesOnly: 0,neither: 0 }]);
  });
  it("keeps attempted unsupported selections apart from statements that reach the operator, and counts failed calls",async () => {
    const report = await harness("adversarial").run(),ai = report.runs[0]!.ai;
    expect(ai.attemptedUnsupportedItems).toBeGreaterThan(0);
    expect(ai.deliveredUnsupportedItems).toBe(0);
    expect(ai.unsafeItems).toBeGreaterThan(0);
    expect([ai.callFailed > 0,ai.notRun]).toEqual([true,0]);
    expect(report.decision.verdict).toBe("NO_GO");
  });
  it("stops at a quota error, separates the failed call from items never run, and reports INCONCLUSIVE",async () => {
    const h = harness("quota-at-5"),report = await h.run();
    expect(h.guard.attempts()).toBe(5);
    expect(report.stopped).toMatchObject({ reason: "QUOTA_OR_RATE_LIMIT" });
    expect(report.runs.map(r => [r.ai.callFailed,r.ai.notRun])).toEqual([[1,79],[0,84]]);
    expect(report.decision.verdict).toBe("INCONCLUSIVE");
  });
  it("excludes disputed questions for both arms and is INCONCLUSIVE when more than 5 are disputed",async () => {
    const disputed = new Set(DEV.slice(0,6).map(d => d.id)),tagged = key.map(k => disputed.has(k.questionId) ? { ...k,tags: [...k.tags,"disputed"] } : k);
    const report = await harness("rules-echo",questions.length*2*2,tagged).run();
    expect([report.rules.excludedDisputed,report.runs[0]!.ai.excludedDisputed,report.rules.questions]).toEqual([12,12,36]);
    expect(report.decision.verdict).toBe("INCONCLUSIVE");
  });
  it("stops at the guard's absolute attempt cap",async () => {
    const h = harness("rules-echo",10),report = await h.run();
    expect(h.guard.attempts()).toBe(10);
    expect(report.stopped?.reason).toMatch(/^GUARD_/);
    expect(report.decision.verdict).toBe("INCONCLUSIVE");
  });
  it("never prints question text in the console summary",async () => {
    const lines = summaryLines(await harness("rules-echo").run()).join("\n");
    for (const q of questions) expect(lines).not.toContain(q.question);
    expect(lines).toMatch(/verdict/i);
    expect(lines).toContain("42 questions × 2 states (84 items)");
  });
});

describe("live gate",() => {
  const both = ["--live","--i-have-approval-for-120-live-calls","--free-tier-confirmed-no-billing"];
  it("allows a live run only with both confirmations and an unchanged freeze",() => {
    expect(liveGateErrors(both,[])).toEqual([]);
    expect(liveGateErrors(["--live"],[])).toEqual(["missing --i-have-approval-for-120-live-calls","missing --free-tier-confirmed-no-billing"]);
    expect(liveGateErrors(both,null)).toEqual(["no freeze manifest; run --freeze first"]);
    expect(liveGateErrors(both,["src/ai/ask-eval/rules.ts"])).toEqual(["frozen protocol changed since freeze: src/ai/ask-eval/rules.ts"]);
  });
});

describe("freeze manifest",() => {
  it("hashes every frozen file, the fact catalog, the prompt and the thresholds, reproducibly",() => {
    const a = freezeManifest(),b = freezeManifest();
    expect(a).toEqual(b);
    expect(a.files.map(f => f.path)).toEqual(expect.arrayContaining(["src/ai/ask-eval/rules.ts","src/ai/ask-eval/prompt.ts","src/ai/ask-eval/score.ts","src/ai/ask-eval/catalog.ts",
      "src/ai/ask-eval/reference.ts","docs/ASK_EVAL_PROTOCOL.md","docs/ASK_EVAL_EVIDENCE_REFERENCE.md","tests/ask-eval-catalog.test.ts","tsconfig.json","vitest.config.ts"]));
    expect(a.requiredLiveFlags).toEqual(["--i-have-approval-for-120-live-calls","--free-tier-confirmed-no-billing"]);
    expect(a.stopErrors).toEqual(["QUOTA_OR_RATE_LIMIT","PROVIDER_REJECTED"]);
    for (const f of a.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.holdoutSha256).toBe(FROZEN_HOLDOUT_SHA256);
    expect(a.catalogSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.systemPromptSha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("hashes files as text with CRLF normalized, so Windows and CI checkouts agree",() => {
    expect(textSha(Buffer.from("a\r\nb\r\n"))).toBe(textSha(Buffer.from("a\nb\n")));
    expect(textSha(Buffer.from("a\nb\n"))).not.toBe(textSha(Buffer.from("a\nc\n")));
    expect(freezeManifest().fileHashing).toBe("sha256 of UTF-8 text with CRLF normalized to LF");
  });
  it("names every file and setting that changed after the freeze, so a live run can refuse",() => {
    const current = freezeManifest();
    expect(freezeDrift(current,current)).toEqual([]);
    const edited = { ...current,systemPromptSha256: "0".repeat(64),thresholds: { ...current.thresholds,liftItemsPer60: 9 },
      files: current.files.map(f => f.path === "src/ai/ask-eval/rules.ts" ? { ...f,sha256: "1".repeat(64) } : f) };
    expect(freezeDrift(edited,current)).toEqual(["systemPromptSha256","thresholds","src/ai/ask-eval/rules.ts"]);
  });
});
