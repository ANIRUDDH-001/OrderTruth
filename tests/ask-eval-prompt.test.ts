import { describe,expect,it } from "vitest";
import { SNAPSHOTS } from "../src/ai/ask-eval/catalog.ts";
import { buildRequest,callAsk,SYSTEM_PROMPT } from "../src/ai/ask-eval/prompt.ts";

const envelope = (text: string,extraParts: unknown[] = []) => new Response(JSON.stringify({ candidates: [{ content: { parts: [...extraParts,{ text }] } }],
  usageMetadata: { promptTokenCount: 900,candidatesTokenCount: 60,totalTokenCount: 960 } }),{ status: 200,headers: { "content-type": "application/json" } });
const good = JSON.stringify({ status: "ANSWERED",factIds: ["PAY_CAPTURE_COUNT"],hypotheses: [],unknowns: [],reason: "NONE" });

describe("AI arm request",() => {
  it("gives the model exactly the snapshot's facts and the question, and nothing from any answer key",() => {
    for (const snapshot of ["PRE","POST"] as const) {
      const body = buildRequest("Was the customer charged twice?",snapshot);
      const user = JSON.parse(body.contents[0]!.parts[0]!.text) as { facts: Array<{ id: string; evidence: string; text: string }>; question: string };
      expect(user.facts).toEqual(SNAPSHOTS[snapshot].map(f => ({ id: f.id,evidence: f.evidenceId,text: f.text })));
      expect(user.question).toBe("Was the customer charged twice?");
      // What the model reads (instructions + user content). The JSON Schema legitimately uses the keyword "required".
      const raw = JSON.stringify({ system: body.systemInstruction,contents: body.contents });
      for (const leak of ["required","acceptable","mustFlagUnknown","\"expected\"","answerable","good_answer","non-english"]) expect(raw).not.toContain(leak);
      expect(body.generationConfig).toMatchObject({ temperature: 0,responseMimeType: "application/json" });
    }
  });
  it("keeps after-repair facts out of the before-repair request",() => {
    const raw = JSON.stringify(buildRequest("is it fixed?","PRE"));
    expect(raw).not.toContain("RECEIPT");
    expect(raw).not.toContain("PAYPAL_UNCHANGED");
  });
  it("tells the model the question is untrusted and that it cannot act",() => {
    expect(SYSTEM_PROMPT).toMatch(/untrusted/i);
    expect(SYSTEM_PROMPT).toMatch(/cannot act/i);
    expect(SYSTEM_PROMPT).not.toMatch(/holdout|answer key|rules baseline/i);
  });
});

describe("AI arm call",() => {
  const call = (respond: () => Response | Promise<Response>) => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string,init: RequestInit) => { seen.push({ url,init }); return respond(); }) as unknown as typeof fetch;
    return { seen,run: () => callAsk({ apiKey: "FAKE-KEY-123",model: "gemini-test",question: "Was the customer charged twice?",snapshot: "PRE",fetchImpl }) };
  };
  it("parses a well-formed reply, ignoring thought parts, and records usage",async () => {
    const c = call(() => envelope(good,[{ text: "thinking…",thought: true }]));
    const r = await c.run();
    expect(r).toMatchObject({ ok: true,error: null,answer: { status: "ANSWERED",factIds: ["PAY_CAPTURE_COUNT"] },usage: { promptTokens: 900,outputTokens: 60,totalTokens: 960 },httpStatus: 200 });
    expect(c.seen).toHaveLength(1);
    expect(c.seen[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
    expect((c.seen[0]!.init.headers as Record<string,string>)["x-goog-api-key"]).toBe("FAKE-KEY-123");
    expect(String(c.seen[0]!.init.body)).not.toContain("FAKE-KEY-123");
  });
  for (const [name,respond,error] of [
    ["rate limit",() => new Response("{}",{ status: 429 }),"QUOTA_OR_RATE_LIMIT"],
    ["server error",() => new Response("{}",{ status: 503 }),"PROVIDER_UNAVAILABLE"],
    ["rejected request",() => new Response("{}",{ status: 400 }),"PROVIDER_REJECTED"],
    ["non-JSON answer",() => envelope("not json"),"INVALID_JSON"],
    ["answer outside the contract",() => envelope(JSON.stringify({ status: "MAYBE",factIds: [],hypotheses: [],unknowns: [],reason: "NONE" })),"INVALID_SCHEMA"],
    ["empty candidates",() => new Response(JSON.stringify({ candidates: [] }),{ status: 200 }),"INVALID_PROVIDER_RESPONSE"],
  ] as const) it(`maps a ${name} to ${error} without retrying`,async () => {
    const c = call(respond);
    expect(await c.run()).toMatchObject({ ok: false,answer: null,error });
    expect(c.seen).toHaveLength(1);
  });
  it("refuses an oversized question before any network call",async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return envelope(good); }) as unknown as typeof fetch;
    expect(await callAsk({ apiKey: "k",model: "gemini-test",question: "x".repeat(1001),snapshot: "PRE",fetchImpl })).toMatchObject({ ok: false,error: "INPUT_TOO_LONG" });
    expect(calls).toBe(0);
  });
});
