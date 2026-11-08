import {z} from 'zod';
import {diagnosticKinds,type InvestigationEvidence} from './investigation.ts';
import {mechanismKinds,mechanismDiagnostics,prepareGroundedContext,validateGroundedPlan,type Mechanism} from './grounded-investigation.ts';

export const COMPARISON_POLICY='merchant-comparison-v1';
const codes=['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O'] as const;
export const ComparisonSelectionSchema=z.object({comparison:z.enum(codes)}).strict();
const pairs=mechanismKinds.flatMap((first,i)=>mechanismKinds.slice(i+1).map(second=>[first,second] as const));

/** The model selects competing causes. Diagnostic validity, evidence identity
 * and every factual sentence remain independently controlled by the backend. */
export function prepareComparisonContext(evidence:readonly InvestigationEvidence[]){
 const grounded=prepareGroundedContext(evidence);
 const choices=pairs.map((mechanisms,i)=>{
  const relevant=new Set(mechanisms.flatMap(m=>mechanismDiagnostics[m]));
  const available=diagnosticKinds.filter(kind=>relevant.has(kind)&&!grounded.performed.has(kind));
  const nextDiagnostic=available[0]??diagnosticKinds.find(kind=>relevant.has(kind))!;
  return {code:codes[i]!,mechanisms:mechanisms as readonly Mechanism[],nextDiagnostic,status:available.length?'AVAILABLE' as const:'EXHAUSTED' as const};
 });
 const projected=JSON.parse(grounded.payload);
 // The menu already encodes relevance/availability; omit duplicate instruction
 // tables to leave room for actual merchant relationships under the input cap.
 const {diagnosticRelevance:_relations,availableDiagnostics:_available,performedDiagnostics:_performed,mechanisms:_mechanisms,...facts}=projected;
 const payload=JSON.stringify({...facts,observations:facts.observations.map(({index,kind}:{index:number;kind:string})=>({index,kind})),policy:COMPARISON_POLICY,
  comparisonChoices:choices.map(({code,mechanisms,nextDiagnostic,status})=>({code,causes:mechanisms,diagnostic:nextDiagnostic,status}))});
 if(Buffer.byteLength(payload,'utf8')>24000)throw Error('AI_EGRESS_REJECTED');
 return {payload,grounded,choices};
}
export function comparisonResponseSchema(){
 const {$schema:_dialect,...schema}=z.toJSONSchema(ComparisonSelectionSchema,{target:'draft-07'});return schema;
}
export function validateComparisonSelection(raw:unknown,context:ReturnType<typeof prepareComparisonContext>){
 const parsed=ComparisonSelectionSchema.safeParse(raw);if(!parsed.success)return {ok:false as const,error:'INVALID_SCHEMA' as const};
 const selected=context.choices.find(choice=>choice.code===parsed.data.comparison);
 if(!selected)return {ok:false as const,error:'INVALID_COMPARISON' as const};
 // The complete catalog independently contributes support and opposition in
 // validateGroundedPlan. A general merchant observation anchors unresolved cases.
 const reference=context.grounded.facts[0]!.id;
 return validateGroundedPlan({hypotheses:selected.mechanisms.map(mechanism=>({mechanism,evidenceFactIds:[reference]})),
  nextDiagnostic:selected.nextDiagnostic,compareMechanisms:selected.mechanisms},context.grounded);
}
