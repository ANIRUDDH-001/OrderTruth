import { admitReviewedFixture, type Admission, type Payment } from "./interpreter.ts";
/** Explicit fixture-engineer review admission. Never derive these from a model's current output. */
export const reviewedStaticSha: Readonly<Record<string,string>> = Object.freeze({
  C01:"70c5c981ea2ffdceec9b5cb31868addc31d47ebc2c2e1bdafba3ad70b9617ed4",
  C02:"70c5c981ea2ffdceec9b5cb31868addc31d47ebc2c2e1bdafba3ad70b9617ed4",
  C03:"70c5c981ea2ffdceec9b5cb31868addc31d47ebc2c2e1bdafba3ad70b9617ed4",
  C04:"70c5c981ea2ffdceec9b5cb31868addc31d47ebc2c2e1bdafba3ad70b9617ed4",
  C05:"3780cd851e708101c65705313125950ada399c1879d84db80bbd0dc5a4d47d0a",
  C06:"ec24b0299a352913881d2086689f7a1ffd2483429433eebea1725a1713151b5d",
  C07:"54ed68f4c1fd060e9648535dc35129689163c8175590832251638dbebd511de2",
  C08:"70c5c981ea2ffdceec9b5cb31868addc31d47ebc2c2e1bdafba3ad70b9617ed4",
});
const payment: Payment = { merchantId:"m1",intentId:"i1",captureId:"c1",amountMinor:100,currency:"USD" };
const insist = (condition: boolean, label: string) => { if (!condition) throw new Error(`REGRESSION_FAILED:${label}`); };
const rejects = async (action: () => Promise<unknown>, expected: string) => {
  try { await action(); } catch (error) { insist(error instanceof Error && error.message === expected,"unexpected-refusal"); return; }
  throw new Error(`REGRESSION_FAILED:missing-${expected}`);
};
/** Independent behavioral assertions; no diagnosis/expected-label access. Cannot run without exact admission. */
export async function runReviewedRegressions(source: string, admission: Admission) {
  const fresh = () => admitReviewedFixture(source,admission);
  const checks: string[] = [];
  const sequential = fresh();
  const first = await sequential.handle(payment,"return"); await sequential.handle(payment,"event");
  insist(sequential.snapshot().length === 1,"sequential"); checks.push("sequential");
  const overlap = fresh();
  await Promise.all([overlap.handle(payment,"return"),overlap.handle(payment,"event")]);
  insist(overlap.snapshot().length === 1,"overlap"); checks.push("overlap");
  const replay = await sequential.handle(payment,"return");
  insist(first?.id === replay?.id && sequential.snapshot().length === 1,"replay"); checks.push("replay");
  await sequential.handle({ ...payment,intentId:"i2",captureId:"c2" },"return");
  insist(sequential.snapshot().length === 2,"distinct-intents"); checks.push("distinct-intents");
  for (const changed of [{ captureId:"c3" },{ intentId:"i3" },{ amountMinor:200 },{ currency:"EUR" }]) {
    await rejects(() => sequential.handle({ ...payment,...changed },"event"),"IDENTITY_CONFLICT");
  }
  insist(sequential.snapshot().length === 2,"identity-mismatch"); checks.push("identity-mismatch");
  await sequential.handle({ ...payment,merchantId:"m2" },"event");
  insist(sequential.snapshot().length === 3,"cross-merchant"); checks.push("cross-merchant");
  const rollback = fresh();
  await rejects(() => rollback.handle(payment,"return",{ failBeforeCommit:true }),"INJECTED_FAILURE");
  insist(rollback.snapshot().length === 0,"rollback"); checks.push("rollback");
  await rollback.handle(payment,"retry"); insist(rollback.snapshot().length === 1,"crash-retry"); checks.push("crash-retry");
  return { status:"VERIFIED_RESTRICTED_INTERPRETER" as const, reviewedSha256:admission.reviewedSha256,
    reviewer:admission.reviewer, checks, passed:checks.length, failed:0, scope:"in-memory finite grammar only; no PostgreSQL/process/provider claims" };
}
