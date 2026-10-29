/** Forward-only instrument check; never reads or regenerates historical packs. */
import { readFileSync } from "node:fs";
import { expect,it } from "vitest";
import { buildPacks } from "../src/ai/investigator-eval/blind.ts";
import { CASES } from "../src/ai/investigator-eval/fixtures.ts";
import { promptRulesControl } from "../src/ai/investigator-eval/control.ts";
import { normalizeA,normalizeInvestigation,type Arm,type Normalized } from "../src/ai/investigator-eval/score.ts";

it("future Stage 1 packs include the exact P3 definition and preserve the other corrected rubric definitions",()=>{
  const document=readFileSync(new URL("../docs/INVESTIGATOR_EVAL_PREREGISTRATION.md",import.meta.url),"utf8");
  const outputs:Record<string,Record<Arm,Normalized>>={};
  for(const c of CASES){const out=normalizeInvestigation(promptRulesControl(c.evidence));outputs[c.id]={A:normalizeA(c.evidence),B:out,C:out};}
  const pack=buildPacks(outputs,17).stage1;
  for(const metric of ["P3","J2","U1","H"]){
    const row=document.split(/\r?\n/).find(line=>line.startsWith("|")&&line.split("|")[1]?.replaceAll("*","").trim()===metric);
    const definition=row?.split("|")[4]?.trim();expect(definition).toBeTruthy();expect(pack).toContain(definition!);
  }
});
