import { expect,it } from "vitest";
import { callGroqInvestigator } from "../src/ai/groq-investigator.ts";

const evidence = [{ id: "synthetic-private-id",source: "SYNTHETIC_PAYMENT_OBSERVATION" as const,observedAt: "2026-11-08T00:00:00.000Z",facts: { orderStatus: "COMPLETED",purchaseUnits: [] } }];
it("uses the fixed Groq endpoint and strict schema, maps citations, and reports usage without a second call",async () => {
  let calls = 0;
  const result = await callGroqInvestigator({ apiKey: "synthetic-only",model: "openai/gpt-oss-120b",evidence,fetchImpl: async (url,init) => {
    calls++; expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    const body = JSON.parse(String(init?.body)); expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.model).toBe("openai/gpt-oss-120b"); expect(body.max_completion_tokens).toBe(1024);
    expect(JSON.stringify(body)).not.toContain("synthetic-private-id");
    const ref = JSON.parse(body.messages[1].content).evidence[0].id;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "Evidence remains incomplete.",hypotheses: [{ explanation: "Merchant outcome is not supplied.",evidenceIds: [ref],confidence: "LOW",status: "HYPOTHESIS" }],nextDiagnostic: "MERCHANT_WRITE_OUTCOMES",diagnosticReason: "Read merchant writes." }) } }],usage: { prompt_tokens: 100,completion_tokens: 50,total_tokens: 150 } }));
  } });
  expect(calls).toBe(1); expect(result.ok).toBe(true); expect(result.result?.hypotheses[0]?.evidenceIds).toEqual(["synthetic-private-id"]);
  expect(result.usage.totalTokens).toBe(150);
});
it.each([429,503])( "returns provider failure %s without retry or failover",async status => {
  let calls = 0;
  const result = await callGroqInvestigator({ apiKey: "synthetic-only",model: "openai/gpt-oss-120b",evidence,fetchImpl: async () => { calls++; return new Response(null,{ status }); } });
  expect(result.ok).toBe(false); expect(calls).toBe(1); expect(result.httpStatus).toBe(status);
});
