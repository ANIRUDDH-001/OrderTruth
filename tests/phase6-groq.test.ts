import { expect,it } from "vitest";
import { callGroqInvestigator } from "../src/ai/groq-investigator.ts";

const evidence = [{ id: "synthetic-private-id",source: "CONTROLLED_MERCHANT_STATE" as const,observedAt: "2026-11-08T00:00:00.000Z",facts: { activeOrders: 2,orders:['synthetic-first','synthetic-second'].map(id=>({id,status:'placed',amountMinor:100,currency:'USD'})),providerMutation: false } }];
it("uses the fixed Groq endpoint and strict schema, maps citations, and reports usage without a second call",async () => {
  let calls = 0;
  const result = await callGroqInvestigator({ apiKey: "synthetic-only",model: "openai/gpt-oss-120b",evidence,fetchImpl: async (url,init) => {
    calls++; expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    const body = JSON.parse(String(init?.body)); expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.model).toBe("openai/gpt-oss-120b"); expect(body.max_completion_tokens).toBe(1536); expect(body.reasoning_effort).toBe('low');
    expect(JSON.stringify(body)).not.toContain("synthetic-private-id");
    expect(JSON.parse(body.messages[1].content).comparisonChoices).toHaveLength(10);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ comparison:'N' }) } }],usage: { prompt_tokens: 100,completion_tokens: 50,total_tokens: 150 } }));
  } });
  expect(calls).toBe(1); expect(result.ok).toBe(true); expect(result.result?.hypotheses[0]?.evidenceIds).toEqual(["synthetic-private-id"]);
  expect(result.usage.totalTokens).toBe(150);
});
it.each([429,503])( "returns provider failure %s without retry or failover",async status => {
  let calls = 0;
  const result = await callGroqInvestigator({ apiKey: "synthetic-only",model: "openai/gpt-oss-120b",evidence,fetchImpl: async () => { calls++; return new Response(null,{ status }); } });
  expect(result.ok).toBe(false); expect(calls).toBe(1); expect(result.httpStatus).toBe(status);
});
it.each([[400,"PROVIDER_REJECTED"],[429,"QUOTA_OR_RATE_LIMIT"],[503,"PROVIDER_UNAVAILABLE"]] as const)("adapts real Groq error response metadata for HTTP%s",async(status,error)=>{
 let calls=0;
 const result=await callGroqInvestigator({apiKey:"synthetic-only",model:"openai/gpt-oss-120b",evidence,fetchImpl:async()=>{
  calls++;
  const response=new Response("synthetic-private-provider-error",{status,headers:{"x-provider-private":"synthetic-private-header"}});
  Object.defineProperty(response,"url",{value:"https://api.groq.com/openai/v1/chat/completions"});
  return response;
 }});
 expect(calls).toBe(1);expect(result.ok).toBe(false);expect(result.httpStatus).toBe(status);expect(result.error).toBe(error);
 expect(JSON.stringify(result)).not.toMatch(/synthetic-private-provider-error|synthetic-private-header/);
});
