import { describe, expect, it } from "vitest";
import { validateRunBundle } from "../packages/assurance/src/lab-record.ts";
import { fixtureBundle } from "./helpers/lab.ts";
import { NC_INTENDED } from "../packages/verifier/src/report.ts";

describe("public lab admission, independently of historical byte pins", () => {
  it("accepts two complete consistent reports with authoritative successful cleanup", () => {
    expect(validateRunBundle(fixtureBundle()).reports).toHaveLength(2);
  });
  it("accepts the controller's recorded intended-oracle facts, but rejects a different oracle", () => {
    const b = fixtureBundle();
    for (const r of b.reports) for (const n of r.negativeControls) Object.assign(n.intended, { expect: { ...NC_INTENDED[n.id].expect } });
    expect(() => validateRunBundle(b)).not.toThrow();
    Object.assign(b.reports[0]!.negativeControls[0]!.intended, { expect: { orders: 0 } });
    expect(() => validateRunBundle(b)).toThrow();
  });
  it.each([
    ["missing cleanup", (b: any) => { delete b.cleanup; }],
    ["failed cleanup hidden by summary", (b: any) => { b.cleanup.ok = false; b.cleanup.errors = ["down failed"]; }],
    ["nonzero teardown", (b: any) => { b.cleanup.downExit = 1; b.summary.cleanup = b.cleanup; }],
    ["leftover volume", (b: any) => { b.cleanup.remaining.volumes = ["left"]; b.summary.cleanup = b.cleanup; }],
    ["missing inventory is not empty", (b: any) => { delete b.cleanup.remaining.networks; b.summary.cleanup = b.cleanup; }],
    ["false acceptance hidden by summary", (b: any) => { b.reports[0].candidates.REFERENCE_FIX[0].checks[0].ok = false; }],
    ["wrong NC defect", (b: any) => { b.reports[0].negativeControls[0].result.checks.find((c: any) => !c.ok).observed.orders = 0; }],
    ["mixed source", (b: any) => { b.reports[1].environment.sourceCommit = "e".repeat(40); }],
    ["mixed run", (b: any) => { b.reports[1].runId = "another-run2"; }],
    ["dirty source", (b: any) => { for (const r of b.reports) r.environment.sourceCommit += "+dirty"; }],
    ["fabricated final qualification", (b: any) => { b.summary.partial = true; }],
    ["stale status summary", (b: any) => { b.summary.statuses[0].REFERENCE_FIX.L1 = "FAIL"; }],
    ["stale NC summary", (b: any) => { b.summary.negativeControls[0].NC1 = "PASSED"; }],
    ["inconsistent images", (b: any) => { b.summary.environment.images.candidate = "other"; }],
    ["incomplete report", (b: any) => { delete b.reports[0].negativeControls; }],
  ])("rejects %s", (_label, mutate) => {
    const b = fixtureBundle(); mutate(b); expect(() => validateRunBundle(b)).toThrow();
  });
});
