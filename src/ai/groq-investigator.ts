import { callPrivateInvestigator } from "./private-investigator.ts";
import type { InvestigationCall,InvestigationEvidence } from "./investigation.ts";
import { providerJson } from "./provider-transport.ts";

/** Transport adapter only. Not selected by hosted configuration until account,
 * privacy, quota and live pilot gates pass. One request; no retry or failover. */
export async function callGroqInvestigator(options: { apiKey: string; model: string; evidence: readonly InvestigationEvidence[]; fetchImpl?: typeof fetch; timeoutMs?:number }): Promise<InvestigationCall> {
  const candidates = ["openai/gpt-oss-120b","qwen/qwen3.8-27b","openai/gpt-oss-20b"];
  if (!candidates.includes(options.model)) throw new Error("Model outside owner-supplied Groq candidate set");
  return callPrivateInvestigator({ ...options,model: "groq-adapter",fetchImpl: async (_url,init) => {
    const original = JSON.parse(String(init?.body));
    const body = { model: options.model,messages: [
      { role: "system",content: original.systemInstruction.parts.map((p: { text: string }) => p.text).join("\n") },
      { role: "user",content: original.contents[0].parts[0].text },
    ],temperature: 0,max_completion_tokens: 1536,...(options.model.startsWith('openai/gpt-oss-')?{reasoning_effort:'low'}:{}),response_format: { type: "json_schema",json_schema: { name: "investigation",strict: true,schema: original.generationConfig.responseJsonSchema } } };
    // Conservative serialized request bound beneath the smallest supplied TPM
    // ceiling when combined with 1536 output tokens and one call per minute.
    if (Buffer.byteLength(JSON.stringify(body),"utf8") > 6000) return new Response(null,{ status: 413 });
    if(!init?.signal)throw new Error("Provider deadline required");
    const received = await providerJson("https://api.groq.com/openai/v1/chat/completions",{
      method: "POST",headers: { "content-type": "application/json",authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify(body),
    },init.signal,options.fetchImpl??fetch);
    const response=received.response;
    // The inner transport already checked Groq's real origin. Adapt only the
    // status into the common envelope; never forward its URL, headers or body.
    if (!response.ok) return new Response(null,{status:response.status});
    const raw: unknown = received.body;
    // The common validator validates this envelope and all final output/citations.
    const r = raw as { choices?: Array<{ message?: { content?: unknown } }>; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } } | null;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: r?.choices?.[0]?.message?.content }] } }],
      usageMetadata: { promptTokenCount: r?.usage?.prompt_tokens,candidatesTokenCount: r?.usage?.completion_tokens,totalTokenCount: r?.usage?.total_tokens } }),{ status: response.status });
  } });
}
