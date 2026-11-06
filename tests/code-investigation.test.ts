import { describe,expect,it } from "vitest";
import { readFileSync } from "node:fs";
import { cases,context } from "../src/ai/code-investigation/fixtures.ts";
import { deterministicRepair,evaluateBaseline,evaluatorDigest,freezeDigest,freezeManifest,outputSchema,promptFor,reviewProposal,score,scoreBatch,sealRelayedHoldouts } from "../src/ai/code-investigation/evaluate.ts";
import { detectAndPropose } from "../src/ai/code-investigation/baseline.ts";
describe("v4 pre-private-holdout scaffold",()=>{
  it("seals the evaluator and exposed smoke data without incorporating private cases",()=>{
    const artifact=JSON.parse(readFileSync(new URL("../src/ai/code-investigation/pilot-freeze-v4-r2.json",import.meta.url),"utf8"));
    expect(artifact).toEqual({freezeDigest,manifest:freezeManifest});expect(evaluatorDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(freezeManifest.evaluator.policy.privateHoldouts).toEqual({expected:4,incorporated:0,status:"PENDING_OWNER_RELAY"});
    expect(cases.every(item=>item.partition==="development")).toBe(true);
    expect(context).not.toContain("createOrderOnce");expect(context).not.toContain("captureId");
    for(const item of cases){const prompt=promptFor(item);expect(prompt).not.toContain(item.id);expect(prompt).not.toContain(item.category);expect(prompt).not.toContain(".ts");}
  });
  it("seals an expected ABSTAIN case and accepts abstention without any patch",()=>{
    const code="export function uncertain(db, purchase) { return db.unknown(purchase); }";
    const local={id:"LOCAL_AMBIGUOUS",code,expected:"ABSTAIN" as const,acceptableDiagnoses:["ABSTAIN"]};
    const answer=deterministicRepair(code);
    expect(answer.diagnoses).toEqual(["ABSTAIN"]);expect(answer.edits).toEqual([]);
    const sealed=sealRelayedHoldouts(Array.from({length:4},(_,index)=>({...local,id:`LOCAL_${index}`})));
    expect(sealed.manifest.cases.every(item=>item.expected==="ABSTAIN")).toBe(true);
    expect(score(local,JSON.stringify(answer))).toMatchObject({status:"VALID",diagnosisAccepted:true,abstained:true,repairProposed:false});
    expect(outputSchema.safeParse({...answer,edits:[{before:code,after:"replacement"}]}).success).toBe(false);
    expect(outputSchema.safeParse({...answer,diagnoses:["ABSTAIN","RACE"]}).success).toBe(false);
  });
  it("uses general lexical detection beyond exact fixture strings and abstains on near misses",()=>{
    const source=`async function put(store, purchase, route) { const dedup = purchase.captureId + route; const old = await store.lookup(dedup); if (old) return old; return store.insertOrder(dedup, purchase, route); }`;
    expect(detectAndPropose(source).diagnoses).toEqual(["RACE","CROSS_PATH"]);
    expect(detectAndPropose(`function put(db,p,path) { const auditPath = path; db.audit(auditPath); return db.createOrderOnce(p,path); }`).diagnoses).toEqual(["ABSTAIN"]);
    expect(detectAndPropose(`function put(db,k) { const old = db.find(k); if(old) return old; return db.insert(k); }`).diagnoses).toEqual(["ABSTAIN"]);
    expect(detectAndPropose(`async function put(db,k) { return db.transaction(async () => { const old = await db.find(k); if(old) return old; return db.insert(k); }); }`).diagnoses).toEqual(["ABSTAIN"]);
    expect(readFileSync(new URL("../src/ai/code-investigation/baseline.ts",import.meta.url),"utf8")).not.toContain('from "./fixtures');
  });
  it("retains every smoke row and separately reports accepted answers and abstentions",()=>{
    const report=evaluateBaseline();expect(report.summary).toEqual({attempts:8,valid:8,accepted:8,abstained:3,falsePositives:0,repairs:5,actualCodeRegressions:0,interpreterChecks:0});
    expect(report.rows.every(row=>row.actualCodeRegressions==="NOT_TESTED"&&row.interpreterChecks==="NOT_TESTED")).toBe(true);
  });
  it("retains invalid, parser, missing-citation and unscorable rows instead of throwing",()=>{
    const item=cases[0]!,result=deterministicRepair(item.code);
    expect(score(item,"x".repeat(10001))).toMatchObject({status:"INVALID_OUTPUT",reason:"OUTPUT_LIMIT"});
    expect(score(item,"{" )).toMatchObject({status:"INVALID_OUTPUT",reason:"JSON_OR_SCHEMA_INVALID"});
    expect(score(item,JSON.stringify({...result,evidenceLines:[99]}))).toMatchObject({status:"INVALID_OUTPUT",reason:"UNKNOWN_EVIDENCE_LINE"});
    expect(score({...item,code:"export async function ("},JSON.stringify({...result,evidenceLines:[1],edits:[]}))).toMatchObject({status:"PARSER_FAILURE"});
    expect(score(item,JSON.stringify({...result,edits:[{before:"missing",after:"replacement"}]}))).toMatchObject({status:"UNSCORABLE"});
    expect(outputSchema.safeParse({...result,execute:true}).success).toBe(false);
    const batch=scoreBatch([item,item,item],["{",null]);
    expect(batch.rows.map(row=>row.status)).toEqual(["INVALID_OUTPUT","NO_OUTPUT","NO_OUTPUT"]);
    expect(batch.retainedAttempts).toBe(3);
  });
  it("accepts multiple defensible labels and free identity text without an answer literal",()=>{
    const item=cases[3]!,result=deterministicRepair(item.code);
    expect(score(item,JSON.stringify({...result,diagnoses:["RACE","IDENTITY"],sharedIdentity:"Purchase identity is carried by the intent lookup."})).diagnosisAccepted).toBe(true);
    expect(score(item,JSON.stringify({...result,diagnoses:["RETRY"]})).diagnosisAccepted).toBe(false);
    expect(outputSchema.safeParse({...result,diagnoses:["CLEAN","RACE"]}).success).toBe(false);
  });
  it("handles formatting equivalence or marks edits unscorable; replacement is literal",()=>{
    const item=cases[0]!,result=deterministicRepair(item.code);
    const before=item.code.replaceAll("\n"," ").replaceAll("  "," ");
    expect(reviewProposal(item.code,{...result,edits:[{before,after:"replacement"}]}).proposedCode).toBe("replacement");
    expect(reviewProposal("original",{...result,edits:[{before:"original",after:"$& $` $'"}]}).proposedCode).toBe("$& $` $'");
    expect(()=>promptFor({code:"x".repeat(12000)})).toThrow("INPUT_LIMIT");
  });
});
