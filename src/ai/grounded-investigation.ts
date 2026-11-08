import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prepareMerchantEvidenceEgress } from "./evidence-egress.ts";
import { InvestigationSchema,diagnosticKinds,type DiagnosticKind,type Investigation,type InvestigationEvidence } from "./investigation.ts";

export const GROUNDED_POLICY="merchant-mechanisms-v3";
export const mechanismKinds=["KEY_SCOPE_MISMATCH","OVERLAPPING_HANDLERS","SEQUENTIAL_DUPLICATE_WRITES","MULTIPLE_WRITE_PATHS","WRITE_FAILURE_OR_INTERRUPTION","UNKNOWN_CAUSE"] as const;
export type Mechanism=typeof mechanismKinds[number];
/** No model-authored prose or financial assertion exists in this contract. */
export const GroundedPlanSchema=z.object({hypotheses:z.array(z.object({mechanism:z.enum(mechanismKinds),
 evidenceFactIds:z.array(z.string().min(1).max(80)).min(1).max(12)}).strict()).min(2).max(4),
 nextDiagnostic:z.enum(diagnosticKinds),compareMechanisms:z.array(z.enum(mechanismKinds)).length(2)}).strict();
/** Static provider wire contract. Indexes are mapped only inside the current
 * request; canonical validation/results continue to use private evidence IDs. */
export const GroundedWirePlanSchema=z.object({hypotheses:z.array(z.object({mechanism:z.enum(mechanismKinds),
 evidenceFactIndexes:z.array(z.number().int().min(0).max(99)).min(1).max(12)}).strict()).min(2).max(4),
 nextDiagnostic:z.enum(diagnosticKinds),compareMechanisms:z.array(z.enum(mechanismKinds)).length(2)}).strict();

const observationText={
 MULTIPLE_ACTIVE_ORDERS:"The supplied merchant records show multiple active orders.",
 SINGLE_ACTIVE_ORDER:"The supplied merchant records show one active order.",
 NO_ACTIVE_ORDERS:"The supplied merchant records show no active order.",
 MERCHANT_COUNT_INCONSISTENT:"The merchant summary count contradicts the supplied order records.",
 DISTINCT_WRITE_KEYS:"The diagnostic records distinct merchant write keys.",
 SINGLE_WRITE_KEY:"The diagnostic records one shared merchant write key.",
 KEY_COUNT_INCONSISTENT:"The key summary contradicts its recorded entries.",
 HANDLER_INTERVALS_OVERLAP:"Recorded merchant handler intervals overlap.",
 HANDLER_INTERVALS_DISJOINT:"All comparable recorded merchant handler intervals are disjoint.",
 TIMING_UNRESOLVED:"Recorded intervals cannot establish overlap or separation.",
 NO_DISCRIMINATING_MERCHANT_EVIDENCE:"The supplied diagnostics contain no discriminating merchant observation.",
 MULTIPLE_WRITE_PATHS:"The diagnostic records multiple merchant handler paths.",
 SINGLE_WRITE_PATH:"Only one merchant handler path is recorded.",
 COMMITTED_WRITES_OBSERVED:"Committed merchant writes are recorded; failed attempts are not observed.",
 WRITE_COUNT_INCONSISTENT:"The committed-write summary contradicts its recorded entries.",
 PAYMENT_CONTEXT_WITHHELD:"Payment facts remain independently interpreted by the backend, outside the AI claim contract.",
} as const;
export type FactKind=keyof typeof observationText;
export type GroundedFact={id:string;kind:FactKind;evidenceIds:readonly string[];text:string};
type SafeEvidence={id:string;source:InvestigationEvidence["source"];facts:{activeOrders?:number;orders?:Array<{reference:string;status:string}>;
 diagnostic?:DiagnosticKind;distinctKeys?:number;committedWrites?:number;
 entries?:Array<{handler:string;keyReference?:string;orderReference:string}>;pairs?:Array<{first:string;second:string;relation:string}>}};

/** Uses the existing recursively validated egress projection, never raw rows.
 * Fact IDs and evidence citations are fresh for this request. */
export function prepareGroundedContext(evidence:readonly InvestigationEvidence[]){
 const egress=prepareMerchantEvidenceEgress(evidence);
 const projected=JSON.parse(egress.payload) as {evidence:SafeEvidence[]};
 const facts:GroundedFact[]=[],performed=new Set<DiagnosticKind>();
 const add=(kind:FactKind,e:SafeEvidence)=>facts.push({id:`f_${randomUUID()}`,kind,text:observationText[kind],evidenceIds:[egress.citationMap.get(e.id)!]});
 for(const e of projected.evidence){
  const f=e.facts;
  if(e.source==="CONTROLLED_MERCHANT_STATE"){
   const count=f.orders!.filter(o=>o.status==="placed").length;
   const unique=new Set(f.orders!.map(o=>o.reference)).size===f.orders!.length;
   add(!unique||count!==f.activeOrders?"MERCHANT_COUNT_INCONSISTENT":count>1?"MULTIPLE_ACTIVE_ORDERS":count===1?"SINGLE_ACTIVE_ORDER":"NO_ACTIVE_ORDERS",e);
  }else if(e.source==="MERCHANT_DIAGNOSTIC"){
   performed.add(f.diagnostic!);
   const entries=f.entries!;
   if(f.diagnostic==="IDEMPOTENCY_KEYS"){
    const count=new Set(entries.map(x=>x.keyReference)).size;
    if(count!==f.distinctKeys)add("KEY_COUNT_INCONSISTENT",e);
    else if(count>0)add(count>1?"DISTINCT_WRITE_KEYS":"SINGLE_WRITE_KEY",e);
   }else if(f.diagnostic==="HANDLER_TIMING"){
    const pairs=f.pairs!.filter(x=>x.first!==x.second);
    if(pairs.some(p=>p.relation==="OVERLAP"))add("HANDLER_INTERVALS_OVERLAP",e);
    if(pairs.length&&pairs.every(p=>p.relation==="DISJOINT"))add("HANDLER_INTERVALS_DISJOINT",e);
    if(!pairs.length||pairs.some(p=>p.relation==="UNKNOWN"))add("TIMING_UNRESOLVED",e);
   }else{
    if(entries.length!==f.committedWrites)add("WRITE_COUNT_INCONSISTENT",e);
    else if(entries.length)add("COMMITTED_WRITES_OBSERVED",e);
   }
   const paths=new Set(entries.map(x=>x.handler));
   if(paths.size)add(paths.size>1?"MULTIPLE_WRITE_PATHS":"SINGLE_WRITE_PATH",e);
  }else add("PAYMENT_CONTEXT_WITHHELD",e);
 }
 // Empty diagnostic entries still provide a checkable observation of missing
 // information, without turning absence of a row into proof of a failed write.
 if(!facts.length)for(const e of projected.evidence)add("NO_DISCRIMINATING_MERCHANT_EVIDENCE",e);
 if(!facts.length||facts.length>100)throw new Error("AI_EGRESS_REJECTED");
 const catalog=Object.freeze(facts.map(f=>Object.freeze({...f,evidenceIds:Object.freeze([...f.evidenceIds])})));
 const payload=JSON.stringify({policy:GROUNDED_POLICY,evidence:projected.evidence,
  observations:catalog.map(({kind,text},index)=>({index,kind,text})),availableDiagnostics:diagnosticKinds.filter(kind=>!performed.has(kind)),
  performedDiagnostics:[...performed],diagnosticRelevance:mechanismDiagnostics,mechanisms:mechanismKinds});
 if(Buffer.byteLength(payload,"utf8")>24000)throw new Error("AI_EGRESS_REJECTED");
 return {payload,facts:catalog,performed:performed as ReadonlySet<DiagnosticKind>};
}
export type GroundedContext=ReturnType<typeof prepareGroundedContext>;
/** Untransformed static JSON Schema: no request-generated UUID enums. */
export function groundedResponseSchema(){
 const {$schema:_dialect,...responseSchema}=z.toJSONSchema(GroundedWirePlanSchema,{target:"draft-07"});
 return responseSchema;
}

const mechanismText:Record<Mechanism,{title:string;gap:string;support:readonly FactKind[];contradict:readonly FactKind[]}>= {
 KEY_SCOPE_MISMATCH:{title:"Different idempotency scopes may permit repeated merchant writes.",gap:"A key difference does not prove a retry or concurrency.",support:["DISTINCT_WRITE_KEYS"],contradict:["SINGLE_WRITE_KEY"]},
 OVERLAPPING_HANDLERS:{title:"Overlapping merchant handlers may bypass an atomic duplicate-write boundary.",gap:"Timing alone does not establish the write mechanism.",support:["HANDLER_INTERVALS_OVERLAP"],contradict:["HANDLER_INTERVALS_DISJOINT"]},
 SEQUENTIAL_DUPLICATE_WRITES:{title:"Repeated merchant writes may occur sequentially without a race.",gap:"Sequential intervals do not prove that a retry caused the writes.",support:["HANDLER_INTERVALS_DISJOINT"],contradict:["HANDLER_INTERVALS_OVERLAP"]},
 MULTIPLE_WRITE_PATHS:{title:"Different merchant handler paths may each perform a write.",gap:"Recorded paths do not establish why duplicate prevention failed.",support:["MULTIPLE_WRITE_PATHS"],contradict:["SINGLE_WRITE_PATH"]},
 WRITE_FAILURE_OR_INTERRUPTION:{title:"A merchant write may have failed or been interrupted.",gap:"Absence of a merchant row does not prove a failed attempt.",support:["NO_ACTIVE_ORDERS"],contradict:[]},
 UNKNOWN_CAUSE:{title:"The merchant cause remains unknown.",gap:"These observations do not independently prove a root cause.",support:[],contradict:[]},
};
const diagnosticText:Record<DiagnosticKind,string>={IDEMPOTENCY_KEYS:"Compare recorded merchant write keys to distinguish shared from separate deduplication scopes.",
 HANDLER_TIMING:"Compare recorded handler intervals to distinguish overlapping from sequential writes.",
 MERCHANT_WRITE_OUTCOMES:"Inspect committed merchant write paths; missing rows cannot prove failed attempts."};
export const mechanismDiagnostics:Record<Mechanism,readonly DiagnosticKind[]>={KEY_SCOPE_MISMATCH:["IDEMPOTENCY_KEYS"],OVERLAPPING_HANDLERS:["HANDLER_TIMING"],
 SEQUENTIAL_DUPLICATE_WRITES:["HANDLER_TIMING"],MULTIPLE_WRITE_PATHS:["MERCHANT_WRITE_OUTCOMES"],WRITE_FAILURE_OR_INTERRUPTION:["MERCHANT_WRITE_OUTCOMES"],UNKNOWN_CAUSE:diagnosticKinds};
const exhaustedReason="All diagnostics that distinguish these selected mechanisms are already recorded. Compare their existing findings; no additional diagnostic is available.";
function diagnosticState(kind:DiagnosticKind,compared:readonly Mechanism[],performed:ReadonlySet<DiagnosticKind>){
 const relevant=new Set(compared.flatMap(m=>mechanismDiagnostics[m]));
 if(!relevant.has(kind))return "IRRELEVANT_DIAGNOSTIC" as const;
 if(!performed.has(kind))return "AVAILABLE" as const;
 return [...relevant].every(d=>performed.has(d))?"EXHAUSTED" as const:"DIAGNOSTIC_ALREADY_PERFORMED" as const;
}
const summary="AI-selected merchant hypotheses follow. Observations and contradictions are checked by the backend; the cause remains unconfirmed.";
function describe(mechanism:Mechanism,facts:readonly GroundedFact[]){
 const rule=mechanismText[mechanism],opposition=facts.find(f=>rule.contradict.includes(f.kind)),support=facts.find(f=>rule.support.includes(f.kind));
 return {opposition,support,explanation:`${rule.title} ${opposition?`${opposition.text} This weakens this explanation.`:support?`${support.text} This is compatible, not causal proof.`:"No discriminating support is recorded."} ${rule.gap}`};
}
export type GroundedHypothesis={mechanism:Mechanism;status:"HYPOTHESIS";assessment:"WEAKENED"|"COMPATIBLE"|"UNRESOLVED";
 supportingFacts:GroundedFact[];contradictingFacts:GroundedFact[];selectedFacts:GroundedFact[];missingEvidence:string};
export type GroundedResult={policy:typeof GROUNDED_POLICY;observations:readonly GroundedFact[];hypotheses:GroundedHypothesis[];
 diagnostic:{kind:DiagnosticKind;status:"AVAILABLE"|"EXHAUSTED";compareMechanisms:Mechanism[];reason:string}};
type Failure="INVALID_SCHEMA"|"INVENTED_EVIDENCE"|"INVALID_COMPARISON"|"DIAGNOSTIC_ALREADY_PERFORMED"|"IRRELEVANT_DIAGNOSTIC";
/** Never coerce, clamp, filter or persist wire indexes. A bad index rejects the
 * entire response before unchanged internal semantic/citation validation. */
export function validateGroundedWirePlan(raw:unknown,context:GroundedContext):ReturnType<typeof validateGroundedPlan>|{ok:false;error:"INVALID_EVIDENCE_INDEX"}{
 const parsed=GroundedWirePlanSchema.safeParse(raw);if(!parsed.success)return {ok:false,error:"INVALID_SCHEMA"};
 if(parsed.data.hypotheses.some(h=>h.evidenceFactIndexes.some(index=>index>=context.facts.length)))return {ok:false,error:"INVALID_EVIDENCE_INDEX"};
 return validateGroundedPlan({...parsed.data,hypotheses:parsed.data.hypotheses.map(({mechanism,evidenceFactIndexes})=>({mechanism,evidenceFactIds:evidenceFactIndexes.map(index=>context.facts[index]!.id)}))},context);
}
/** IDs prove identity only. This validator independently computes relationships
 * from the complete catalog, so a model cannot conceal contradictory evidence. */
export function validateGroundedPlan(raw:unknown,context:GroundedContext):{ok:true;grounded:GroundedResult;investigation:Investigation}|{ok:false;error:Failure}{
 const parsed=GroundedPlanSchema.safeParse(raw);if(!parsed.success)return {ok:false,error:"INVALID_SCHEMA"};
 const plan=parsed.data,byId=new Map(context.facts.map(f=>[f.id,f]));
 if(plan.hypotheses.some(h=>h.evidenceFactIds.some(id=>!byId.has(id))))return {ok:false,error:"INVENTED_EVIDENCE"};
 const mechanisms=new Set(plan.hypotheses.map(h=>h.mechanism));
 if(mechanisms.size!==plan.hypotheses.length||new Set(plan.compareMechanisms).size!==2||plan.compareMechanisms.some(m=>!mechanisms.has(m)))return {ok:false,error:"INVALID_COMPARISON"};
 const diagnosticStatus=diagnosticState(plan.nextDiagnostic,plan.compareMechanisms,context.performed);
 if(diagnosticStatus==="IRRELEVANT_DIAGNOSTIC"||diagnosticStatus==="DIAGNOSTIC_ALREADY_PERFORMED")return {ok:false,error:diagnosticStatus};
 const reason=diagnosticStatus==="EXHAUSTED"?exhaustedReason:diagnosticText[plan.nextDiagnostic];
 const hypotheses:GroundedHypothesis[]=plan.hypotheses.map(h=>{
  const rule=mechanismText[h.mechanism];
  const supportingFacts=context.facts.filter(f=>rule.support.includes(f.kind));
  const contradictingFacts=context.facts.filter(f=>rule.contradict.includes(f.kind));
  return {mechanism:h.mechanism,status:"HYPOTHESIS",assessment:contradictingFacts.length?"WEAKENED":supportingFacts.length?"COMPATIBLE":"UNRESOLVED",
   supportingFacts,contradictingFacts,selectedFacts:h.evidenceFactIds.map(id=>byId.get(id)!),missingEvidence:rule.gap};
 });
 const grounded:GroundedResult={policy:GROUNDED_POLICY,observations:context.facts,hypotheses,
  diagnostic:{kind:plan.nextDiagnostic,status:diagnosticStatus,compareMechanisms:plan.compareMechanisms,reason}};
 const investigation:Investigation={summary,
  hypotheses:hypotheses.map(h=>{
   const {explanation,opposition,support}=describe(h.mechanism,context.facts);
   // The first visible support/opposition must always be cited. The complete
   // structured result retains all facts; legacy UI citations stay bounded.
   const cited=[opposition,support,...h.selectedFacts].filter((f):f is GroundedFact=>!!f);
   return {explanation,evidenceIds:[...new Set(cited.flatMap(f=>f.evidenceIds))].slice(0,10),confidence:"LOW",status:"HYPOTHESIS"};
  }),nextDiagnostic:plan.nextDiagnostic,diagnosticReason:reason};
 return {ok:true,grounded,investigation};
}

/** Revalidate the fixed-language projection on every service/cache/history
 * boundary. This is a finite checked grammar, not a prose keyword filter.
 * Citation validity alone never admits model-authored text. */
export function validateGroundedProjection(raw:unknown,evidence:readonly InvestigationEvidence[]):{ok:true;result:Investigation}|{ok:false;error:"UNSAFE_GROUNDED_RESULT"}{
 const parsed=InvestigationSchema.safeParse(raw);
 if(!parsed.success||parsed.data.summary!==summary||parsed.data.hypotheses.length<2)return {ok:false,error:"UNSAFE_GROUNDED_RESULT"};
 let context:GroundedContext;try{context=prepareGroundedContext(evidence);}catch{return {ok:false,error:"UNSAFE_GROUNDED_RESULT"};}
 const ids=new Set(evidence.map(e=>e.id)),selected=new Set<Mechanism>();
 for(const h of parsed.data.hypotheses){
  const mechanism=mechanismKinds.find(m=>describe(m,context.facts).explanation===h.explanation);
  if(!mechanism||selected.has(mechanism)||h.confidence!=="LOW"||h.evidenceIds.some(id=>!ids.has(id)))return {ok:false,error:"UNSAFE_GROUNDED_RESULT"};
  selected.add(mechanism);
  const {opposition,support}=describe(mechanism,context.facts);
  if([opposition,support].filter((f):f is GroundedFact=>!!f).some(f=>f.evidenceIds.some(id=>!h.evidenceIds.includes(id))))return {ok:false,error:"UNSAFE_GROUNDED_RESULT"};
 }
 const mechanisms=[...selected];
 const validReason=mechanisms.some((a,i)=>mechanisms.slice(i+1).some(b=>{
  const state=diagnosticState(parsed.data.nextDiagnostic,[a,b],context.performed);
  return state==="AVAILABLE"?parsed.data.diagnosticReason===diagnosticText[parsed.data.nextDiagnostic]:state==="EXHAUSTED"&&parsed.data.diagnosticReason===exhaustedReason;
 }));
 if(!validReason)return {ok:false,error:"UNSAFE_GROUNDED_RESULT"};
 return {ok:true,result:parsed.data};
}
