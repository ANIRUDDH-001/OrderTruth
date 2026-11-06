/** Offline report only. No caller-selected source, dynamic imports or model transport. */
import { evaluateBaseline, freezeDigest, freezeManifest } from "./evaluate.ts";
import { deterministicRepair, reviewProposal } from "./evaluate.ts";
import { cases } from "./fixtures.ts";
import { reviewedStaticSha, runReviewedRegressions } from "./regressions.ts";

const mode = process.argv.slice(2).join(" ");
if (!["--baseline","--freeze","--verify-reviewed-baseline"].includes(mode)) {
  console.error("Usage: pnpm exec tsx src/ai/code-investigation/main.ts --baseline|--freeze|--verify-reviewed-baseline");
  process.exitCode = 2;
} else {
  const report = mode === "--verify-reviewed-baseline" ? { freezeDigest, modelCalls:0, spendINR:0,
    rows:await Promise.all(cases.map(async item => ({ caseId:item.id, ...await runReviewedRegressions(reviewProposal(item.code,deterministicRepair(item.code)).proposedCode,
      { reviewedSha256:reviewedStaticSha[item.id]!,reviewer:"codex-static-fixture-review" }) }))) }
    : mode === "--freeze" ? { freezeDigest,manifest:freezeManifest } : evaluateBaseline();
  process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
}
