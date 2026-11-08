import {expect,it} from 'vitest';
import {callPrivateInvestigator} from '../src/ai/private-investigator.ts';
import {callGroqInvestigator} from '../src/ai/groq-investigator.ts';
import {pilotCases} from '../src/ai/pilot-cases.ts';
for(const groq of [false,true])it(`${groq?'Groq':'Gemini'} offers a static comparison schema and bounded request for every pilot input`,async()=>{
 let largest=0;
 for(const c of pilotCases){
  const result=await (groq?callGroqInvestigator:callPrivateInvestigator)({apiKey:'synthetic-only',model:groq?'openai/gpt-oss-120b':'synthetic-model',evidence:c.evidence,fetchImpl:async(_url,init)=>{
   const raw=String(init?.body);largest=Math.max(largest,Buffer.byteLength(raw));const body=JSON.parse(raw);
   const schema=groq?body.response_format.json_schema.schema:body.generationConfig.responseJsonSchema;
   const input=JSON.parse(groq?body.messages[1].content:body.contents[0].parts[0].text);
   expect(Object.keys(schema.properties)).toEqual(['comparison']);expect(schema.properties.comparison.enum).toHaveLength(15);
   expect(schema.additionalProperties).toBe(false);expect(input.comparisonChoices).toHaveLength(15);
   expect(JSON.stringify(schema)).not.toMatch(/evidenceFact|f_[a-f0-9-]{36}/);
   expect(JSON.stringify(input)).not.toContain('PAYPAL_SANDBOX_OBSERVATION');
   return new Response(JSON.stringify(groq?{choices:[{message:{content:'{"comparison":"F"}'}}]}:{candidates:[{content:{parts:[{text:'{"comparison":"F"}'}]}}]}));
  }});
  expect(result.ok,c.id).toBe(true);
 }
 expect(largest).toBeLessThanOrEqual(groq?6000:24000);
});