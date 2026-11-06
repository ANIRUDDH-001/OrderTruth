import { describe,expect,it } from "vitest";
import { cases } from "../src/ai/code-investigation/fixtures.ts";
import { deterministicRepair,reviewProposal } from "../src/ai/code-investigation/evaluate.ts";
import { runActualReviewedSmoke } from "../src/ai/code-investigation/actual-smoke.ts";
import { reviewedStaticSha } from "../src/ai/code-investigation/regressions.ts";
describe("actual pinned JavaScript patch smoke, separate from interpreter",()=>{
  it("executes reviewed source functions in a permission-restricted child against seven independent assertions",()=>{
    for(const index of [0,4,5,6]){
      const item=cases[index]!,proposal=reviewProposal(item.code,deterministicRepair(item.code));
      const report=runActualReviewedSmoke(proposal.proposedCode,{reviewedSha256:reviewedStaticSha[item.id]!,reviewer:"codex-static-fixture-review"});
      expect(report).toMatchObject({status:"ACTUAL_REVIEWED_JAVASCRIPT_SMOKE",passed:7,failed:0});
    }
  });
  it("never executes unreviewed arbitrary or merely formatting-equivalent candidate text",()=>{
    expect(runActualReviewedSmoke("process.exit()",{reviewedSha256:"0".repeat(64),reviewer:"reviewer"})).toMatchObject({status:"UNSCORABLE"});
    const item=cases[0]!,proposal=reviewProposal(item.code,deterministicRepair(item.code));
    expect(runActualReviewedSmoke(proposal.proposedCode+" ",{reviewedSha256:reviewedStaticSha[item.id]!,reviewer:"reviewer"})).toMatchObject({status:"UNSCORABLE"});
  });
});
