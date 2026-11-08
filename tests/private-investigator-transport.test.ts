import { expect,it } from "vitest";
import { callPrivateInvestigator } from "../src/ai/private-investigator.ts";
import { callGroqInvestigator } from "../src/ai/groq-investigator.ts";

const evidence=[{id:"synthetic-merchant",source:"CONTROLLED_MERCHANT_STATE" as const,observedAt:"2026-11-08T00:00:00.000Z",facts:{activeOrders:0,orders:[],providerMutation:false}}];
const providers=[{call:callPrivateInvestigator,model:"synthetic-model"},{call:callGroqInvestigator,model:"openai/gpt-oss-120b"}];
for(const provider of providers){
 it(`${provider.model} refuses redirects and unexpected response origins`,async()=>{
  for(const response of [new Response(null,{status:302,headers:{location:"https://untrusted.invalid/"}}),Object.defineProperty(new Response("{}"),"url",{value:"https://untrusted.invalid/"})]){
   let calls=0;const result=await provider.call({apiKey:"synthetic-only",model:provider.model,evidence,fetchImpl:async(_url,init)=>{calls++;expect(init?.redirect).toBe("error");return response;}});
   expect(calls).toBe(1);expect(result.ok).toBe(false);expect(result.error).toBe("PROVIDER_REDIRECT_REJECTED");
  }
 });
 it(`${provider.model} bounds response bodies before JSON parsing`,async()=>{
  let canceled=false;
  const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(70_000));},cancel(){canceled=true;}});
  const result=await provider.call({apiKey:"synthetic-only",model:provider.model,evidence,fetchImpl:async()=>new Response(body)});
  expect(result.ok).toBe(false);expect(result.error).toBe("PROVIDER_RESPONSE_TOO_LARGE");expect(canceled).toBe(true);
 });
 it(`${provider.model} classifies a disconnected body without leaking its error`,async()=>{
  const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode("{"));controller.error(new Error("synthetic-private-provider-text"));}});
  const result=await provider.call({apiKey:"synthetic-only",model:provider.model,evidence,fetchImpl:async()=>new Response(body)});
  expect(result.ok).toBe(false);expect(result.error).toBe("NETWORK");expect(JSON.stringify(result)).not.toContain("synthetic-private-provider-text");
 });
 it(`${provider.model} applies its deadline while consuming a stalled body`,async()=>{
  let canceled=false;
  const body=new ReadableStream<Uint8Array>({cancel(){canceled=true;}});
  const result=await provider.call({apiKey:"synthetic-only",model:provider.model,evidence,timeoutMs:20,fetchImpl:async()=>new Response(body)});
  expect(result.ok).toBe(false);expect(result.error).toBe("TIMEOUT");expect(canceled).toBe(true);
 });
}
