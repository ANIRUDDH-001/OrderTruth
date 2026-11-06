import { describe, expect, it } from "vitest";
import { cases } from "../src/ai/code-investigation/fixtures.ts";
import { deterministicRepair, reviewProposal } from "../src/ai/code-investigation/evaluate.ts";
import { admitReviewedFixture, sourceSha, type Payment } from "../src/ai/code-investigation/interpreter.ts";
import { reviewedStaticSha, runReviewedRegressions } from "../src/ai/code-investigation/regressions.ts";
const payment: Payment = { merchantId:"m1",intentId:"i1",captureId:"c1",amountMinor:100,currency:"USD" };
const admit = (source: string) => admitReviewedFixture(source,{ reviewedSha256:sourceSha(source),reviewer:"synthetic-test-author" });
const barrier = () => { let arrivals = 0; let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; }); return async () => { if (++arrivals === 2) release(); await ready; }; };
describe("independent restricted-interpreter regression assertions", () => {
  it("executes the frozen original sequential/overlap/multiple-intent expectation table", async () => {
    for (const item of cases) {
      const sequential = admit(item.code);
      await sequential.handle(payment,"return"); await sequential.handle(payment,"event");
      expect(sequential.snapshot()).toHaveLength(item.expectedBehavior.sequentialOrders);
      const overlapping = admit(item.code), afterCheck = barrier();
      await Promise.all([overlapping.handle(payment,"return",{ afterCheck }),overlapping.handle(payment,"event",{ afterCheck })]);
      expect(overlapping.snapshot()).toHaveLength(item.expectedBehavior.overlappingOrders);
      const distinct = admit(item.code);
      await distinct.handle(payment,"return"); await distinct.handle({ ...payment,intentId:"i2",captureId:"c2" },"return");
      expect(distinct.snapshot()).toHaveLength(item.expectedBehavior.distinctIntentOrders);
    }
  });
  it("requires exact reviewed source SHA and rejects arbitrary host code even with matching SHA", () => {
    expect(() => admitReviewedFixture(cases[0]!.code,{ reviewedSha256:"0".repeat(64),reviewer:"reviewer" })).toThrow("REVIEW_ADMISSION_REQUIRED");
    expect(() => admit("process.exit();")).toThrow("UNSUPPORTED_GRAMMAR");
    expect(() => admit(cases[0]!.code + "\nfetch('http://localhost')")).toThrow("UNSUPPORTED_GRAMMAR");
  });
  it("reproduces sequential path-key duplicates without forced overlap including distributed handlers", async () => {
    for (const index of [0,5]) {
      const fixture = admit(cases[index]!.code);
      await fixture.handle(payment,"return"); await fixture.handle(payment,"event");
      expect(fixture.snapshot()).toHaveLength(2);
      expect(fixture.trace().filter(row => row.event === "EXISTENCE_CHECK").map(row => row.found)).toEqual([false,false]);
    }
  });
  it("race is sequentially healthy and duplicate only after both actual checks pass", async () => {
    const sequential = admit(cases[1]!.code);
    await sequential.handle(payment,"return"); await sequential.handle(payment,"event"); expect(sequential.snapshot()).toHaveLength(1);
    const overlap = admit(cases[1]!.code), afterCheck = barrier();
    await Promise.all([overlap.handle(payment,"return",{ afterCheck }),overlap.handle(payment,"event",{ afterCheck })]);
    expect(overlap.snapshot()).toHaveLength(2);
    expect(overlap.trace().slice(0,2).map(row => [row.event,row.found])).toEqual([["EXISTENCE_CHECK",false],["EXISTENCE_CHECK",false]]);
  });
  it("original intent key silently aliases conflicting capture and marker loses order after crash", async () => {
    const identity = admit(cases[3]!.code);
    const original = await identity.handle(payment,"return");
    expect(await identity.handle({ ...payment,captureId:"c2" },"event")).toEqual(original);
    const retry = admit(cases[7]!.code);
    await expect(retry.handle(payment,"return",{ afterMark:async () => { throw new Error("CRASH"); } })).rejects.toThrow("CRASH");
    expect(await retry.handle(payment,"event")).toBeUndefined(); expect(retry.snapshot()).toHaveLength(0);
    expect(retry.trace().map(row => row.event)).toEqual(["MARK_COMMIT","SUPPRESSED"]);
  });
  for (const item of cases) it(`${item.id}: reviewed static repair/clean source passes independent synthetic regressions`, async () => {
    const output = deterministicRepair(item.code), proposal = reviewProposal(item.code,output);
    // Test-author admission is explicit and limited to the reviewed finite grammar.
    // This does not admit an arbitrary model proposal or attest a human security review.
    expect(proposal.proposedSha256).toBe(reviewedStaticSha[item.id]);
    const admission = { reviewedSha256:reviewedStaticSha[item.id]!,reviewer:"codex-static-fixture-review" };
    const fixture = admitReviewedFixture(proposal.proposedCode,admission);
    const report = await runReviewedRegressions(proposal.proposedCode,admission);
    expect(report.passed).toBe(8); expect(report.failed).toBe(0);
    await fixture.handle(payment,"return");
    await Promise.all([fixture.handle(payment,"event"),fixture.handle(payment,"retry")]);
    expect(fixture.snapshot()).toHaveLength(1);
    await fixture.handle({ ...payment,intentId:"i2",captureId:"c2" },"return");
    expect(fixture.snapshot()).toHaveLength(2);
    for (const changed of [{ captureId:"c3" },{ intentId:"i3" },{ amountMinor:200 },{ currency:"EUR" }]) {
      await expect(fixture.handle({ ...payment,...changed },"event")).rejects.toThrow("IDENTITY_CONFLICT");
    }
    await fixture.handle({ ...payment,merchantId:"m2" },"event"); expect(fixture.snapshot()).toHaveLength(3);
    const rollback = admit(proposal.proposedCode);
    await expect(rollback.handle(payment,"return",{ failBeforeCommit:true })).rejects.toThrow("INJECTED_FAILURE");
    expect(rollback.snapshot()).toHaveLength(0);
    await rollback.handle(payment,"retry"); expect(rollback.snapshot()).toHaveLength(1);
    expect(rollback.trace().map(row => row.event)).toEqual(["ROLLBACK","COMMIT"]);
  });
  it("bounds schedule waits and state growth", async () => {
    const fixture = admit(cases[1]!.code);
    await expect(fixture.handle(payment,"return",{ afterCheck:() => new Promise(() => {}) })).rejects.toThrow("SCHEDULE_TIMEOUT");
    expect(fixture.snapshot()).toHaveLength(0);
    const bounded = admit(cases[2]!.code);
    for (let index = 0; index < 32; index++) await bounded.handle({ ...payment,intentId:`i${index}`,captureId:`c${index}` },"return");
    await expect(bounded.handle({ ...payment,intentId:"overflow",captureId:"overflow" },"return")).rejects.toThrow("ROW_LIMIT");
    expect(bounded.snapshot()).toHaveLength(32);
  });
});
