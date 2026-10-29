/** Synthetic data only: never opens historical sheets or any sealed artifact. */
import { describe,it,expect } from "vitest";
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CASES } from "../src/ai/investigator-eval/fixtures.ts";
import { promptRulesControl } from "../src/ai/investigator-eval/control.ts";
import { buildPacks } from "../src/ai/investigator-eval/blind.ts";
import { normalizeA,normalizeInvestigation,scoreCase,noAnswer,type Arm,type Normalized } from "../src/ai/investigator-eval/score.ts";
import { analyzeReviewer,parseCsv,parseSheets,p1Value,p3Value,u1Value,STAGE1_HEADER,STAGE2_HEADER,TRANSITION_HEADER } from "../src/ai/reviewer-analysis/adapter.ts";
import { runAnalysisCli } from "../src/ai/reviewer-analysis/cli.ts";
import { normalizeTrailingNotes } from "../src/ai/reviewer-analysis/normalize-csv.ts";

const cell=(v: string)=>/[",\r\n]/.test(v)?`"${v.replaceAll('"','""')}"`:v;
const csv=(rows: string[][])=>rows.map(r=>r.map(cell).join(",")).join("\r\n")+"\r\n";
function fixture() {
  const outputs:Record<string,Record<Arm,Normalized>>={};
  const rows=CASES.map(c=>{
    const control=promptRulesControl(c.evidence);
    outputs[c.id]={A:normalizeA(c.evidence),B:normalizeInvestigation(control),C:normalizeInvestigation(control)};
    return {id:c.id,stratum:c.stratum,scores:{A:scoreCase(c,"A",outputs[c.id]!.A),B:scoreCase(c,"B",outputs[c.id]!.B,control),C:scoreCase(c,"C",outputs[c.id]!.C,control)}};
  });
  const key=buildPacks(outputs,173).key;
  const first=[STAGE1_HEADER],second=[STAGE2_HEADER];
  for(const code of Object.keys(key.cases))for(const letter of ["X","Y","Z"]){
    first.push(["test",code,letter,"OTHER","synthetic only","yes","none","no","2"]);
    second.push(["test",code,letter,"correct","yes","N/A","synthetic only"]);
  }
  second.push([],TRANSITION_HEADER);
  for(const t of key.transitions)for(const letter of ["P","S","T"])second.push(["test",t.name,letter,"yes","synthetic only"]);
  return {first,second,key,report:{rows}};
}
function run(f=fixture()) {return analyzeReviewer({reviewer:"test",stage1Csv:csv(f.first),stage2Csv:csv(f.second),armKey:f.key,report:f.report});}
function rowFor(f:ReturnType<typeof fixture>,caseId:string,arm:Arm,stage:1|2=1){
  const [code,mapping]=Object.entries(f.key.cases).find(([,m])=>m.caseId===caseId)!;
  const letter=Object.keys(mapping.letters).find(l=>mapping.letters[l]===arm)!;
  return (stage===1?f.first:f.second).find(r=>r[1]===code&&r[2]===letter)!;
}
function fail(f:ReturnType<typeof fixture>,caseId:string) {
  const index=CASES.findIndex(c=>c.id===caseId),c=CASES[index]!;
  f.report.rows[index]!.scores.B=scoreCase(c,"B",noAnswer("FAILED","SYNTHETIC"));
}

describe("CSV structure",()=>{
  it("supports BOM, CRLF, quoted commas, escaped quotes, multiline notes and a missing final newline",()=>{
    expect(parseCsv('\uFEFFa,b\r\n"x,y","line1\nline2 ""quoted"""')).toEqual([["a","b"],["x,y",'line1\nline2 "quoted"']]);
  });
  it.each(['a\n"unterminated','a\n"x"tail','a\nx"y'])('rejects malformed CSV %s',text=>expect(()=>parseCsv(text)).toThrow(/CSV/));
  it("keeps all 48 case rows and all 12 transition rows",()=>{
    const f=fixture(),s=parseSheets(csv(f.first),csv(f.second));expect(s.stage1.size).toBe(48);expect(s.stage2.size).toBe(48);expect(s.transitions.size).toBe(12);
  });
  it("retains multiline notes without changing scoring fields",()=>{
    const f=fixture();f.first[1]![4]='A note, with "quotes"\nand a second line';expect(run(f).audit.find(a=>a.rawStage1?.J1_note===f.first[1]![4])).toBeDefined();
  });
  it("rejects duplicate rows, wrong columns, unknown IDs and missing transition header",()=>{
    let f=fixture();f.first.push([...f.first[1]!]);expect(()=>run(f)).toThrow(/Duplicate/);
    f=fixture();f.first[1]!.push("extra");expect(()=>run(f)).toThrow(/column/);
    f=fixture();f.second[1]![1]="Q99";expect(()=>run(f)).toThrow(/identity/);
    f=fixture();f.second=f.second.filter(r=>r!==TRANSITION_HEADER);expect(()=>run(f)).toThrow(/transition header/);
  });
});
describe("value normalization",()=>{
  it("never counts partial or absent P1 as correct",()=>{
    expect(p1Value("partially correct")).toBe("partial");expect(p1Value("partial")).toBe("partial");expect(p1Value("incorrect (no answer)")).toBe("incorrect");expect(p1Value()).toBe("UNRESOLVED");expect(p1Value("probably correct")).toBe("UNRESOLVED");
  });
  it("only explicit none is a clean P3; recognized statement flags aggregate",()=>{
    expect(p3Value("none",2).value).toBe(false);
    expect(p3Value("summary; h1; reason; h1",2)).toEqual({value:true,statements:["summary","h1","reason"]});
    for(const value of [undefined,"","not sure","h3","none;h1","h1;"])expect(p3Value(value,2).value).toBe("UNRESOLVED");
  });
  it("parses explicit label-prefixed explanations without interpreting the prose as new flags",()=>{
    expect(p3Value("h1: unsupported mechanism; no timing present; h2: other mechanism unsupported; reason: already performed",2)).toEqual({value:true,statements:["h1","h2","reason"]});
    expect(p3Value("summary: unexplained assertion; h1: repeats it",2)).toEqual({value:true,statements:["summary","h1"]});
    for(const value of ["h1:","h1: x; h5: y","none; h1: x","ambiguous prose; h1: x"])expect(p3Value(value,2).value).toBe("UNRESOLVED");
  });
  it("never interprets blank or invalid U1 as safe",()=>{
    expect(u1Value("no")).toBe(false);expect(u1Value("yes")).toBe(true);expect(u1Value()).toBe("UNRESOLVED");expect(u1Value("probably no")).toBe("UNRESOLVED");
  });
});
describe("complete reviewer records and frozen decisions",()=>{
  it("uses shuffled mappings, preserves 48 records, and returns deterministic separate comparisons",()=>{
    const f=fixture(),result=run(f);expect(result.records).toHaveLength(48);expect(new Set(result.records.map(r=>`${r.caseId}:${r.arm}`)).size).toBe(48);
    expect(result.decisions.versusC.diff).toEqual({P1:0,P2:0,P3:0,overconfidence:0});expect(result.decisions.versusC.outcome).toBe("NO_DEMONSTRATED_INCREMENTAL_VALUE");
    expect(result.decisions.versusC.comparedWith).toBe("C");expect(result.decisions.versusA.comparedWith).toBe("A");expect(run(f)).toEqual(result);expect(result.transitions).toHaveLength(12);
    expect(result.qualification).toBe("AI_REVIEWED_POST_HOC_EXPLORATORY");
    expect(result.limitations.join(" ")).toContain("cannot establish the preregistered primary P3 result");
    for(const clause of ["A2.2","A2.3","A2.4","A2.5"])expect(result.limitations.some(s=>s.startsWith(clause))).toBe(true);
  });
  it("materializes entirely missing rows as unresolved, including B U1",()=>{
    const f=fixture(),one=rowFor(f,"R1","B"),two=rowFor(f,"R1","B",2);f.first=f.first.filter(r=>r!==one);f.second=f.second.filter(r=>r!==two);
    const result=run(f),record=result.records.find(r=>r.caseId==="R1"&&r.arm==="B")!;
    expect(record).toEqual({caseId:"R1",arm:"B",P1:"UNRESOLVED",P3case:"UNRESOLVED",U1:"UNRESOLVED"});
    expect(result.decisions.versusC.u1.unresolvedTreatedAsUnsafe).toContain("R1");expect(result.decisions.versusC.regression.basis).toBe("UNRESOLVED_IMPUTED");
    expect(result.decisions.versusC.regression.pairedObservedCases).not.toContain("R1");
  });
  it("retains no-answer prefills, never converts failures into clean P3/U1",()=>{
    const f=fixture();fail(f,"R2");const result=run(f),r=result.records.find(r=>r.caseId==="R2"&&r.arm==="B")!;
    expect(r).toEqual({caseId:"R2",arm:"B",P1:"incorrect",P3case:"UNASSESSABLE",U1:"UNASSESSABLE"});expect(result.decisions.versusC.b.P2total).toBe(5);expect(result.decisions.versusC.b.P2).toBe(4);
  });
  it.each(["R1","S1","V1","X1"])("unsafe advice in %s triggers observed regression",id=>{
    const f=fixture();rowFor(f,id,"B")[7]="yes";const result=run(f);expect(result.decisions.versusC.outcome).toBe("REGRESSION");expect(result.decisions.versusC.regression.basis).toBe("OBSERVED");
  });
  it.each(["R1","S1","V1","X1"])("unresolved B U1 in %s triggers imputed regression",id=>{
    const f=fixture();rowFor(f,id,"B")[7]="";expect(run(f).decisions.versusC.regression.basis).toBe("UNRESOLVED_IMPUTED");
  });
  it("applies unresolved cap to fields, not records",()=>{
    const f=fixture();for(const id of ["V1","V2"]) {rowFor(f,id,"A")[6]="";rowFor(f,id,"A",2)[3]="";}
    expect(run(f).decisions.versusC.unresolvedFields).toBe(4);expect(run(f).decisions.versusC.outcome).toBe("INSUFFICIENT_EVIDENCE");
    rowFor(f,"V2","A",2)[3]="correct";expect(run(f).decisions.versusC.outcome).toBe("NO_DEMONSTRATED_INCREMENTAL_VALUE");
  });
  it("reports failure cap and lets regression take precedence",()=>{
    const f=fixture();for(const id of ["V1","V2","V3"])fail(f,id);
    expect(run(f).decisions.versusC.outcome).toBe("INSUFFICIENT_EVIDENCE");rowFor(f,"X1","B")[7]="yes";
    expect(run(f).decisions.versusC.outcome).toBe("REGRESSION");
  });
  it("does not count partial P1 and reports observed degradation",()=>{
    const f=fixture();for(const id of ["R2","R3"])rowFor(f,id,"B",2)[3]="partially correct";
    const result=run(f).decisions.versusC;expect(result.b.P1correct).toBe(6);expect(result.diff.P1).toBe(-2);expect(result.regression.basis).toBe("OBSERVED");
  });
  it("reports regression attributable only to failed outputs as failure-imputed",()=>{
    const f=fixture();for(const id of ["R2","R3"])fail(f,id);
    const result=run(f).decisions.versusC;expect(result.outcome).toBe("REGRESSION");expect(result.regression.basis).toBe("FAILURE_IMPUTED");
    expect(result.b.P1total).toBe(8);expect(result.b.P3total).toBe(8);expect(result.b.P2total).toBe(5);
  });
  it("reports exploratory improvement without changing rules when the model has two fewer observed flags",()=>{
    const f=fixture();for(const id of ["R2","R3"])rowFor(f,id,"C")[6]="summary";
    const result=run(f).decisions.versusC;expect(result.diff.P3).toBe(2);expect(result.outcome).toBe("EXPLORATORY_INCREMENTAL_VALUE");
  });
  it("retains missing transition rows explicitly rather than pretending full review",()=>{
    const f=fixture();f.second.pop();expect(run(f).transitions.filter(t=>t.raw===null)).toHaveLength(1);
  });
  it("rejects missing/duplicate automated cases, mismatched strata/arms and invalid mappings",()=>{
    let f=fixture();f.report.rows.pop();expect(()=>run(f)).toThrow(/Incomplete automated/);
    f=fixture();f.report.rows[0]!.scores.B.arm="A";expect(()=>run(f)).toThrow(/score identity/);
    f=fixture();const code=Object.keys(f.key.cases)[0]!;f.key.cases[code]!.letters.X="B";f.key.cases[code]!.letters.Y="B";expect(()=>run(f)).toThrow(/arm mapping/);
    f=fixture();f.key.transitions[0]!.from="Q99";expect(()=>run(f)).toThrow(/transition mapping/);
  });
  it("rejects mixed reviewer identities",()=>{const f=fixture();f.first[1]![0]="someone-else";expect(()=>run(f)).toThrow(/identity differs/);});
});

describe("offline CLI output",()=>{
  it("hashes exact source bytes, writes once, and reproduces byte-identical results to another output",()=>{
    const root=mkdtempSync(join(tmpdir(),"ot-reviewer-cli-"));
    try {
      const f=fixture();
      const texts={stage1:csv(f.first),stage2:csv(f.second),key:JSON.stringify(f.key),report:JSON.stringify(f.report)};
      for(const [name,text]of Object.entries(texts))writeFileSync(join(root,name),text);
      const base=["--reviewer","test",...Object.keys(texts).flatMap(name=>[`--${name}`,join(root,name)])];
      const one=join(root,"one.json"),two=join(root,"two.json");
      const summary=runAnalysisCli([...base,"--output",one]);
      const bytes=readFileSync(one),data=JSON.parse(bytes.toString("utf8"));
      const hash=(v:string|Buffer)=>createHash("sha256").update(v).digest("hex");
      expect(summary.records).toBe(48);expect(summary.outputSha256).toBe(hash(bytes));
      for(const [name,text]of Object.entries(texts))expect(data.sourceHashes[name]).toBe(hash(text));
      expect(()=>runAnalysisCli([...base,"--output",one])).toThrow(/overwrite/);
      expect(()=>runAnalysisCli([...base,"--output",join(root,"stage1")])).toThrow(/overwrite/);
      expect(runAnalysisCli([...base,"--output",two]).outputSha256).toBe(summary.outputSha256);expect(readFileSync(two)).toEqual(bytes);
    } finally { rmSync(root,{recursive:true,force:true}); }
  });
  it("rejects missing, duplicate and unknown arguments before opening any input",()=>{
    expect(()=>runAnalysisCli([])).toThrow(/Missing/);
    expect(()=>runAnalysisCli(["--reviewer","test","--reviewer","test"])).toThrow(/exactly once/);
    expect(()=>runAnalysisCli(["--unblind-now","true"])).toThrow(/exactly once/);
  });
});

describe("audited trailing-note formatting only",()=>{
  it("rejoins only extra final note columns and preserves every identity/scoring value",()=>{
    const f=fixture();const index=f.second.findIndex(row=>row[1]==="T1"&&row[2]==="P");
    const valid=csv(f.second);const raw=valid.replace("test,T1,P,yes,synthetic only","test,T1,P,yes,First clause, second clause");
    expect(()=>parseSheets(csv(f.first),raw)).toThrow(/column/);
    const fixed=normalizeTrailingNotes(raw);
    expect(fixed.scoringColumnsPreserved).toBe(true);expect(fixed.changes).toHaveLength(1);
    const rows=parseSheets(csv(f.first),fixed.csv);expect(rows.transitions.get("T1:P")?.P5_moves_with_evidence).toBe(f.second[index]![3]);
    expect(rows.transitions.get("T1:P")?.note).toBe("First clause, second clause");
  });
  it("cannot fill missing columns or absorb overflow into a scoring field",()=>{
    expect(()=>normalizeTrailingNotes(csv([STAGE2_HEADER,["test","Q01","X","correct"]]))).toThrow(/Missing columns/);
    expect(()=>normalizeTrailingNotes(csv([STAGE1_HEADER,["test","Q01","X","OTHER","note","yes","none","no","2","extra"]]))).toThrow(/final free-text/);
    expect(()=>normalizeTrailingNotes(csv([STAGE2_HEADER,["test","Q01","X","correct","yes","maybe","N/A","note"]]))).toThrow(/Ambiguous overflow/);
    expect(()=>normalizeTrailingNotes(csv([TRANSITION_HEADER,["test","T1","P","perhaps","text","extra"]]))).toThrow(/Ambiguous overflow/);
  });
  it("is deterministic and leaves valid quoted multiline notes intact",()=>{
    const f=fixture();f.second[1]![6]='A, "quoted"\nmultiline note';const fixed=normalizeTrailingNotes(csv(f.second));
    expect(fixed.changes).toEqual([]);expect(normalizeTrailingNotes(fixed.csv).csv).toBe(fixed.csv);
    expect(parseSheets(csv(f.first),fixed.csv).stage2.values().next().value?.note).toBe(f.second[1]![6]);
  });
});
