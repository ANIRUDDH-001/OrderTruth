import {expect,it} from 'vitest';
import {callPrivateInvestigator} from '../src/ai/private-investigator.ts';
import {callGroqInvestigator} from '../src/ai/groq-investigator.ts';
import {pilotCases} from '../src/ai/pilot-cases.ts';
for(const groq of [false,true])it(`${groq?'Groq':'Gemini'} offers a static comparison schema and bounded request for every pilot input`,async()=>{
 let largest=0;
 for(const c of pilotCases){
  let calls=0;
  const result=await (groq?callGroqInvestigator:callPrivateInvestigator)({apiKey:'synthetic-only',model:groq?'openai/gpt-oss-120b':'synthetic-model',evidence:c.evidence,fetchImpl:async(_url,init)=>{
   calls++;
   const raw=String(init?.body);largest=Math.max(largest,Buffer.byteLength(raw));const body=JSON.parse(raw);
   const schema=groq?body.response_format.json_schema.schema:body.generationConfig.responseJsonSchema;
   const input=JSON.parse(groq?body.messages[1].content:body.contents[0].parts[0].text);
   expect(Object.keys(schema.properties)).toEqual(['comparison']);expect(schema.properties.comparison.enum).toHaveLength(15);
   expect(schema.additionalProperties).toBe(false);expect(input.comparisonChoices.length).toBeGreaterThan(0);
   expect(input.comparisonChoices.every((choice:{code:string;status:string})=>schema.properties.comparison.enum.includes(choice.code)&&choice.status==='AVAILABLE')).toBe(true);
   expect(JSON.stringify(schema)).not.toMatch(/evidenceFact|f_[a-f0-9-]{36}/);
   expect(JSON.stringify(input)).not.toContain('PAYPAL_SANDBOX_OBSERVATION');
   const selection=JSON.stringify({comparison:input.comparisonChoices[0].code});
   return new Response(JSON.stringify(groq?{choices:[{message:{content:selection}}]}:{candidates:[{content:{parts:[{text:selection}]}}]}));
  }});
  const actionable=!['P08','P09','P10'].includes(c.id);
  expect(calls,c.id).toBe(actionable?1:0);expect(result.ok,c.id).toBe(actionable);
  if(!actionable)expect(result.error).toBe('NO_ACTIONABLE_COMPARISON');
 }
 expect(largest).toBeLessThanOrEqual(groq?6000:24000);
});
