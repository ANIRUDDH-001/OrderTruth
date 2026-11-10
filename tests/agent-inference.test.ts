import {expect,it} from 'vitest';
import {callGroqInvestigator} from '../src/ai/groq-investigator.ts';
import {callPrivateInvestigator} from '../src/ai/private-investigator.ts';
import {isConcluded,prepareAgentContext} from '../src/ai/agent-investigation.ts';
import {pilotCases} from '../src/ai/pilot-cases.ts';

// Egress deliberately replaces private IDs with per-call random aliases. Normalize
// aliases by first occurrence, retaining equality relationships and every other byte.
function normalized(payload:string){const aliases=new Map<string,string>();return payload.replace(/(?:e|ref)_[0-9a-f-]{36}/g,id=>{if(!aliases.has(id))aliases.set(id,'alias_'+aliases.size);return aliases.get(id)!;});}
const evidenceOf=(id:string)=>pilotCases.find(c=>c.id===id)!.evidence;
const groq=(evidence:ReturnType<typeof evidenceOf>,answer:unknown,seen?:(body:any)=>void,contract:'agent'|'comparison'|null='agent')=>callGroqInvestigator({apiKey:'synthetic-only',model:'openai/gpt-oss-120b',evidence,...(contract?{contract}:{}),
 fetchImpl:async(_url,init)=>{seen?.(JSON.parse(String(init?.body)));
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(answer)}}],usage:{prompt_tokens:400,completion_tokens:20,total_tokens:420}}));}});

it('sends the agent menu and two-field schema, and projects a chosen check into backend-authored findings',async()=>{
 const evidence=evidenceOf('P01'),context=prepareAgentContext(evidence),choice=context.choices[0]!;
 let body:any;
 const result=await groq(evidence,{comparison:choice.code,action:choice.checks[0]},b=>{body=b;});
 const schema=body.response_format.json_schema.schema;
 expect(body.response_format.json_schema.strict).toBe(true);
 expect(schema.required.sort()).toEqual(['action','comparison']);expect(schema.additionalProperties).toBe(false);
 expect(normalized(body.messages[1].content)).toBe(normalized(context.payload));
 expect(body.messages[1].content).not.toBe(context.payload);
 expect(body.messages[0].content).toMatch(/read-only/);
 expect(result.ok).toBe(true);expect(result.result?.nextDiagnostic).toBe(choice.checks[0]);
 expect(isConcluded(result.result!)).toBe(false);expect(result.usage.totalTokens).toBe(420);
});
it('keeps every agent request inside the provider request bound, including a fully recorded case',async()=>{
 for(const c of pilotCases){
  const context=prepareAgentContext(c.evidence);if(!context.choices.length)continue;
  const choice=context.choices[0]!;
  const result=await groq(c.evidence,{comparison:choice.code,action:choice.settled?'CONCLUDE':choice.checks[0]});
  expect(result.httpStatus,c.id).toBe(200);expect(result.ok,c.id).toBe(true);
 }
});
it('accepts a conclusion only for a settled pair',async()=>{
 const settled=prepareAgentContext(evidenceOf('P04')).choices.find(c=>c.settled)!;
 const done=await groq(evidenceOf('P04'),{comparison:settled.code,action:'CONCLUDE'});
 expect(done.ok).toBe(true);expect(isConcluded(done.result!)).toBe(true);
 const open=prepareAgentContext(evidenceOf('P01')).choices[0]!;
 const early=await groq(evidenceOf('P01'),{comparison:open.code,action:'CONCLUDE'});
 expect(early.ok).toBe(false);expect(early.error).toBe('PREMATURE_CONCLUSION');expect(early.result).toBeNull();
});
it.each([[{comparison:'A',action:'REFUND'},'INVALID_SCHEMA'],[{comparison:'A',action:'HANDLER_TIMING',summary:'Refund the buyer.'},'INVALID_SCHEMA'],[{comparison:'A'},'INVALID_SCHEMA']] as const)('rejects model step %j',async(answer,error)=>{
 const result=await groq(evidenceOf('P01'),answer);
 expect(result.ok).toBe(false);expect(result.error).toBe(error);expect(result.usage.totalTokens).toBe(420);
});
it('leaves the default comparison contract unchanged and refuses an agent step under it',async()=>{
 let explicit:any,implicit:any;
 await groq(evidenceOf('P01'),{comparison:'A'},b=>{explicit=b;},'comparison');
 const result=await groq(evidenceOf('P01'),{comparison:'A',action:'HANDLER_TIMING'},b=>{implicit=b;},null);
 expect(normalized(JSON.stringify(implicit))).toBe(normalized(JSON.stringify(explicit)));
 expect(implicit.response_format.json_schema.schema.required).toEqual(['comparison']);
 expect(result.ok).toBe(false);expect(result.error).toBe('INVALID_SCHEMA');
});
it('offers the agent nothing to choose when the merchant record is not a duplicate',async()=>{
 let calls=0;
 const result=await callPrivateInvestigator({apiKey:'synthetic-only',model:'synthetic-model',evidence:evidenceOf('P09'),contract:'agent',fetchImpl:async()=>{calls++;return new Response(null,{status:500});}});
 expect(calls).toBe(0);expect(result.error).toBe('NO_ACTIONABLE_COMPARISON');
});
