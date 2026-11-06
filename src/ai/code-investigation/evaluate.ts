import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { cases,context,type CodeCase } from "./fixtures.ts";
import { sourceSha } from "./interpreter.ts";
import { detectAndPropose,tokens } from "./baseline.ts";
export const outputSchema=z.strictObject({
  diagnoses:z.array(z.enum(["RACE","CROSS_PATH","IDENTITY","RETRY","CLEAN","ABSTAIN"])).min(1).max(4),
  sharedIdentity:z.string().min(1).max(200),
  evidenceLines:z.array(z.number().int().positive().max(100)).min(1).max(8),
  explanation:z.string().min(1).max(1200),
  edits:z.array(z.strictObject({before:z.string().min(1).max(4000),after:z.string().min(1).max(4000)})).max(1),
}).superRefine((value,ctx)=>{
  if(new Set(value.diagnoses).size!==value.diagnoses.length)ctx.addIssue({code:"custom",message:"Duplicate diagnoses"});
  if(value.diagnoses.length>1&&value.diagnoses.some(v=>v==="CLEAN"||v==="ABSTAIN"))ctx.addIssue({code:"custom",message:"Clean/abstain must stand alone"});
  if(value.diagnoses.some(v=>v==="CLEAN"||v==="ABSTAIN")&&value.edits.length)ctx.addIssue({code:"custom",message:"No patch for clean or abstention"});
});
export type Investigation=z.infer<typeof outputSchema>;
export const policy=Object.freeze({version:4,scaffoldRevision:2,inputBytes:12000,outputBytes:10000,maxChangedLines:16,
  pilot:{provider:"UNSPECIFIED",maximumCalls:8,maximumCallsIncludingRepairAndRetry:8,callsPerCase:1,retries:0,maximumINR:0,status:"PENDING_AUTHORIZATION",responseDeadlineMs:30000},
  scoring:"Accept all cited defensible labels from a presealed set; report abstention separately. Clean patches are false positives. Retain invalid/schema/parser/unscorable rows in denominator. Formatting-equivalent edits accepted when unique, otherwise UNSCORABLE. Actual code execution and interpreter checks are distinct, source-hash-bound evidence; no model test/minimality credit by assertion.",
  privateHoldouts:{expected:4,incorporated:0,status:"PENDING_OWNER_RELAY"},
  gate:"No AI usefulness claim from exposed smoke corpus or interpreter checks; private holdouts and independently reviewed actual patch regressions remain required."});
export function promptFor(item:Pick<CodeCase,"code">):string {
  const prompt=`${context}\nReturn only JSON matching ${JSON.stringify(z.toJSONSchema(outputSchema))}. Multiple supported mechanisms may be listed; abstain when the excerpt cannot establish a defect.\nCODE\n${item.code.split("\n").map((line,i)=>`${i+1}: ${line}`).join("\n")}`;
  if(Buffer.byteLength(prompt)>policy.inputBytes)throw Error("INPUT_LIMIT");return prompt;
}
export function deterministicRepair(code:string):Investigation {
  const result=detectAndPropose(code);
  return{diagnoses:result.diagnoses,sharedIdentity:result.sharedIdentity,evidenceLines:result.evidenceLines,explanation:result.explanation,edits:result.edit?[result.edit]:[]};
}
function deepFreeze<T>(value:T):T {if(value&&typeof value==="object"){for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}return value;}
const frozenFiles=["fixtures.ts","baseline.ts","interpreter.ts","evaluate.ts","regressions.ts","actual-smoke.ts","actual-smoke-child.mjs","main.ts","../../../tests/code-investigation.test.ts","../../../tests/code-investigation-regression.test.ts","../../../tests/code-investigation-actual.test.ts","../../../docs/CODE_INVESTIGATION_PROTOCOL.md"];
const implementationSha256=Object.fromEntries(frozenFiles.map(file=>[file,sourceSha(readFileSync(new URL(file,import.meta.url),"utf8"))]));
export const evaluatorManifest=deepFreeze({version:4,scaffoldRevision:2,stage:"PRE_PRIVATE_HOLDOUT",context,policy,implementationSha256,outputSchema:z.toJSONSchema(outputSchema)});
export const evaluatorDigest=sourceSha(JSON.stringify(evaluatorManifest));
export const freezeManifest=deepFreeze({version:4,scaffoldRevision:2,evaluatorDigest,evaluator:evaluatorManifest,developmentSmoke:cases.map(item=>({...item,sourceSha256:sourceSha(item.code),prompt:promptFor(item),promptSha256:sourceSha(promptFor(item))}))});
export const freezeDigest=createHash("sha256").update(JSON.stringify(freezeManifest)).digest("hex");
/** Owner-relayed data only: no file discovery/reads, no model calls, evaluator remains sealed. */
export function sealRelayedHoldouts(input:unknown){
  const diagnosis=z.enum(["RACE","CROSS_PATH","IDENTITY","RETRY","CLEAN","ABSTAIN"]);
  const batch=z.array(z.strictObject({id:z.string().regex(/^[A-Z0-9_]{1,40}$/),code:z.string().min(1).max(12000),
    expected:diagnosis,acceptableDiagnoses:z.array(diagnosis).min(1).max(6)})).length(4).parse(input);
  if(new Set(batch.map(item=>item.id)).size!==4)throw Error("DUPLICATE_HOLDOUT_ID");
  const manifest=deepFreeze({evaluatorDigest,status:"OWNER_RELAYED_NOT_EXECUTED",cases:batch.map(item=>({...item,sourceSha256:sourceSha(item.code),prompt:promptFor(item),promptSha256:sourceSha(promptFor(item))}))});
  return{holdoutDigest:sourceSha(JSON.stringify(manifest)),manifest};
}
/** Edits remain inert. Formatting matches token-for-token; ambiguous or absent spans are UNSCORABLE. */
export function reviewProposal(code:string,result:Investigation) {
  const parsed=outputSchema.parse(result);let proposedCode=code,changedLines=0;
  for(const edit of parsed.edits){
    if(code.split(edit.before).length!==2){
      if(tokens(code).join("|")===tokens(edit.before).join("|"))proposedCode=edit.after;
      else throw Error("UNSCORABLE_EDIT_MATCH");
    }else proposedCode=code.replace(edit.before,()=>edit.after);
    changedLines+=edit.before.split("\n").length+edit.after.split("\n").length;
  }
  return{proposedCode,proposedSha256:sourceSha(proposedCode),changedLines};
}
type ScoreCase=Pick<CodeCase,"id"|"code"|"expected">&{acceptableDiagnoses?:readonly string[]};
const acceptable=(item:ScoreCase):readonly string[]=>item.acceptableDiagnoses??(item.expected==="CROSS_PATH"?["CROSS_PATH","RACE"]:item.expected==="IDENTITY"?["IDENTITY","RACE"]:item.expected==="CLEAN"?["CLEAN","ABSTAIN"]:[item.expected]);
/** One row for every attempted response, including all failures. No selective throw-away outputs. */
export function score(item:ScoreCase,raw:string) {
  const base={caseId:item.id,freezeDigest,evaluatorDigest,outputSha256:sourceSha(raw),status:"INVALID_OUTPUT",diagnosisAccepted:false,abstained:false,falsePositive:false,
    editBudgetMet:false,repairProposed:false,proposedSha256:null as string|null,actualCodeRegressions:"NOT_TESTED",interpreterChecks:"NOT_TESTED",testCorrectness:"NOT_TESTED",minimality:"REQUIRES_INDEPENDENT_REVIEW",identityCorrectness:"REQUIRES_INDEPENDENT_REVIEW",explanationCorrectness:"REQUIRES_INDEPENDENT_REVIEW",reason:""};
  if(Buffer.byteLength(raw)>policy.outputBytes)return{...base,reason:"OUTPUT_LIMIT"};
  let result:Investigation;
  try{result=outputSchema.parse(JSON.parse(raw));}catch{return{...base,reason:"JSON_OR_SCHEMA_INVALID"};}
  if(result.evidenceLines.some(line=>line>item.code.split("\n").length))return{...base,reason:"UNKNOWN_EVIDENCE_LINE"};
  const parsed=detectAndPropose(item.code);
  if(parsed.status==="PARSER_FAILURE")return{...base,status:"PARSER_FAILURE",reason:"SOURCE_PARSE_ERROR"};
  if(parsed.status==="UNSCORABLE")return{...base,status:"UNSCORABLE",reason:"SOURCE_SYNTAX_OUTSIDE_LEXICAL_SUBSET"};
  let proposal:ReturnType<typeof reviewProposal>;
  try{proposal=reviewProposal(item.code,result);}catch{return{...base,status:"UNSCORABLE",reason:"EDIT_MATCH_FAILED"};}
  return{...base,status:"VALID",reason:"",diagnosisAccepted:result.diagnoses.every(label=>acceptable(item).includes(label)),abstained:result.diagnoses.includes("ABSTAIN"),
    falsePositive:item.expected==="CLEAN"&&(!result.diagnoses.every(label=>["CLEAN","ABSTAIN"].includes(label))||result.edits.length>0),
    editBudgetMet:proposal.changedLines<=policy.maxChangedLines,repairProposed:result.edits.length>0,proposedSha256:proposal.proposedSha256};
}
export function scoreBatch(items:readonly ScoreCase[],rawOutputs:readonly (string|null)[]){
  const rows=items.map((item,index)=>{
    const raw=rawOutputs[index];const row=score(item,raw??"");
    return raw===null||raw===undefined?{...row,status:"NO_OUTPUT",reason:"MISSING_OR_TIMED_OUT_ATTEMPT"}:row;
  });
  const unexpectedOutputs=rawOutputs.slice(items.length).map(raw=>({status:"UNEXPECTED_OUTPUT",outputSha256:sourceSha(raw??""),reason:"NO_FROZEN_CASE_SLOT"}));
  return{expectedAttempts:items.length,rows,unexpectedOutputs,retainedAttempts:rows.length+unexpectedOutputs.length};
}
export function evaluateBaseline(){
  const rows=cases.map(item=>score(item,JSON.stringify(deterministicRepair(item.code))));
  return{status:"DEVELOPMENT_SMOKE_ONLY",modelCalls:0,spendINR:0,freezeDigest,evaluatorDigest,privateHoldouts:policy.privateHoldouts,
    summary:{attempts:rows.length,valid:rows.filter(row=>row.status==="VALID").length,accepted:rows.filter(row=>row.diagnosisAccepted).length,
      abstained:rows.filter(row=>row.abstained).length,falsePositives:rows.filter(row=>row.falsePositive).length,repairs:rows.filter(row=>row.repairProposed).length,actualCodeRegressions:0,interpreterChecks:0},rows};
}
