import {z} from 'zod';
import {diagnosticKinds,type DiagnosticKind,type Investigation,type InvestigationEvidence} from './investigation.ts';
import {exhaustedReason,mechanismKinds,mechanismDiagnostics,prepareGroundedContext,validateGroundedPlan,type Mechanism} from './grounded-investigation.ts';

export const AGENT_POLICY='merchant-agent-v1';
const codes=['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O'] as const;
export const AgentStepSchema=z.object({comparison:z.enum(codes),action:z.enum([...diagnosticKinds,'CONCLUDE'])}).strict();
const pairs=mechanismKinds.flatMap((first,i)=>mechanismKinds.slice(i+1).map(second=>[first,second] as const));

/** The model selects competing causes and one read-only action: an offered
 * check, or CONCLUDE once every check that separates the pair is recorded.
 * Relevance, availability, evidence identity and every factual sentence remain
 * independently controlled by the backend. */
export function prepareAgentContext(evidence:readonly InvestigationEvidence[]){
 const grounded=prepareGroundedContext(evidence);
 const duplicate=grounded.facts.some(f=>f.kind==='MULTIPLE_ACTIVE_ORDERS')&&!grounded.facts.some(f=>f.kind==='MERCHANT_COUNT_INCONSISTENT'||f.kind==='NO_ACTIVE_ORDERS'||f.kind==='SINGLE_ACTIVE_ORDER');
 const choices=pairs.flatMap((mechanisms,i)=>{
  if(!duplicate||mechanisms.includes('WRITE_FAILURE_OR_INTERRUPTION'))return [];
  // Unknown is a competing explanation, not a reason to offer every check.
  const relevant=new Set(mechanisms.filter(m=>m!=='UNKNOWN_CAUSE').flatMap(m=>mechanismDiagnostics[m]));
  const checks=diagnosticKinds.filter(kind=>relevant.has(kind)&&!grounded.performed.has(kind));
  // Concluding uses the grounded rule unchanged: every check relevant to either
  // mechanism, Unknown included, must already be recorded.
  const every=[...new Set(mechanisms.flatMap(m=>mechanismDiagnostics[m]))];
  const settled=!checks.length&&every.every(kind=>grounded.performed.has(kind))?every[0]!:null;
  if(!checks.length&&!settled)return [];
  return [{code:codes[i]!,mechanisms:mechanisms as readonly Mechanism[],checks,settled}];
 });
 const projected=JSON.parse(grounded.payload);
 const {diagnosticRelevance:_relations,availableDiagnostics:_available,performedDiagnostics:_performed,mechanisms:_mechanisms,...facts}=projected;
 const payload=JSON.stringify({...facts,observations:facts.observations.map(({index,kind}:{index:number;kind:string})=>({index,kind})),policy:AGENT_POLICY,
  recordedChecks:[...grounded.performed],
  comparisonChoices:choices.map(({code,mechanisms,checks,settled})=>({code,causes:mechanisms,actions:settled?['CONCLUDE']:checks}))});
 if(Buffer.byteLength(payload,'utf8')>24000)throw Error('AI_EGRESS_REJECTED');
 return {payload,grounded,choices};
}
export type AgentContext=ReturnType<typeof prepareAgentContext>;
export function agentResponseSchema(){
 const {$schema:_dialect,...schema}=z.toJSONSchema(AgentStepSchema,{target:'draft-07'});return schema;
}
export function validateAgentStep(raw:unknown,context:AgentContext){
 const parsed=AgentStepSchema.safeParse(raw);if(!parsed.success)return {ok:false as const,error:'INVALID_SCHEMA' as const};
 const selected=context.choices.find(choice=>choice.code===parsed.data.comparison);
 if(!selected)return {ok:false as const,error:'INVALID_COMPARISON' as const};
 const action=parsed.data.action;
 let nextDiagnostic:DiagnosticKind;
 if(action==='CONCLUDE'){
  if(!selected.settled)return {ok:false as const,error:'PREMATURE_CONCLUSION' as const};
  nextDiagnostic=selected.settled;
 }else{
  // Stricter than the grounded rule: the menu, not Unknown, bounds the check.
  if(!selected.checks.includes(action))return {ok:false as const,error:context.grounded.performed.has(action)?'DIAGNOSTIC_ALREADY_PERFORMED' as const:'IRRELEVANT_DIAGNOSTIC' as const};
  nextDiagnostic=action;
 }
 const reference=context.grounded.facts[0]!.id;
 return validateGroundedPlan({hypotheses:selected.mechanisms.map(mechanism=>({mechanism,evidenceFactIds:[reference]})),
  nextDiagnostic,compareMechanisms:selected.mechanisms},context.grounded);
}
/** A concluding step carries the fixed exhausted-reason sentence and no new check. */
export const isConcluded=(investigation:Pick<Investigation,'diagnosticReason'>)=>investigation.diagnosticReason===exhaustedReason;
