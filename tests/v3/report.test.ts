import { describe, expect, it } from "vitest";
import { accept, compareForced, deriveNcObservation, evaluate, GATE_A_APPLICABLE, NC_INTENDED, REQUIRED_CHECKS, type NcId, type NcResult,
  type RungId, type RungResult, type RunReport, type RungStatus } from "../../packages/verifier/src/report.ts";

const M = { expectedManifestSha256: "m" };
const NCS = Object.keys(NC_INTENDED) as NcId[];
/** A rung whose every required check is present with the required kind and result. */
const rung = (id: RungId, failing: string[] = []): RungResult => {
  const checks = Object.entries(REQUIRED_CHECKS[id]).map(([name, kind]) => ({ name, kind, ok: !failing.includes(name), detail: "" }));
  return { id, status: failing.length ? "FAIL" : "PASS", checks };
};
/** Sets the structured facts a check observed. */
const observe = (x: RungResult, name: string, observed: Record<string, string | number | boolean | null>): RungResult =>
  ({ ...x, checks: x.checks.map(c => c.name === name ? { ...c, observed } : c) });
/** An NC's own run of its intended rung, with only the intended check failing, for exactly the intended reason. */
const ncResult = (id: NcId): NcResult => {
  const intended = NC_INTENDED[id];
  return { id, intended, result: observe(rung(intended.rung, [intended.check]), intended.check, { ...intended.expect }), observed: "REJECTED_AS_INTENDED", detail: "" };
};
const originalL4 = (orders: number) => ({ ...observe(rung("L4", ["forced:one_matching_order"]), "forced:one_matching_order", { orders }), reproduced: "forced" as const });
function goodReport(): RunReport {
  return {
    runId: "run-1", validity: "VALID", invalidReasons: [],
    candidates: { ORIGINAL: [originalL4(2)], REFERENCE_FIX: GATE_A_APPLICABLE.map(id => rung(id)) },
    negativeControls: NCS.map(ncResult),
    environment: { candidateNode: "v22.18.0", postgresVersion: "18.6", images: {}, controllerNode: "v24.11.0", manifestSha256: "m", sourceCommit: "c" },
    limitations: [],
  };
}
const mapFix = (r: RunReport, id: RungId, f: (x: RungResult) => RungResult): RunReport =>
  ({ ...r, candidates: { ...r.candidates, REFERENCE_FIX: r.candidates.REFERENCE_FIX.map(x => x.id === id ? f(x) : x) } });
const withRung = (r: RunReport, id: RungId, status: RungStatus) => mapFix(r, id, x => ({ ...x, status }));

describe("Gate A report acceptance (plan Task 7)", () => {
  it("accepts a valid run where every applicable rung passes on its required checks and every NC trips its oracle", () => {
    expect(evaluate(goodReport())).toEqual({ validity: "VALID", invalidReasons: [] });
    expect(accept(goodReport(), M)).toEqual({ accepted: true, reasons: [] });
  });

  for (const id of GATE_A_APPLICABLE)
    for (const status of ["FAIL", "FLAKY", "NOT_RUN", "INFRA_ERROR", "LIMITATION", "NOT_APPLICABLE"] as const)
      it(`refuses REFERENCE_FIX ${id} = ${status}`, () => {
        const r = accept(withRung(goodReport(), id, status), M);
        expect(r.accepted).toBe(false);
        expect(r.reasons.join("\n")).toContain(id);
      });

  it("refuses a REFERENCE_FIX with an applicable rung missing", () => {
    const r = goodReport();
    const out = accept({ ...r, candidates: { ...r.candidates, REFERENCE_FIX: r.candidates.REFERENCE_FIX.filter(x => x.id !== "L21") } }, M);
    expect(out.accepted).toBe(false);
    expect(out.reasons.join("\n")).toMatch(/L21/);
  });

  // Review R1: a PASS label can't override its observations.
  it("a PASS rung with a failed check is contradictory and refused", () => {
    const bad = mapFix(goodReport(), "L1", x => ({ ...x, checks: x.checks.map(c => c.name === "one_matching_order" ? { ...c, ok: false } : c) }));
    expect(evaluate(bad).invalidReasons.join("\n")).toMatch(/REFERENCE_FIX L1.*one_matching_order/);
    expect(accept(bad, M).accepted).toBe(false);
  });

  it("refuses PASS rungs with empty, missing, duplicated or wrongly sourced required checks", () => {
    const r = goodReport();
    const empty: RunReport = { ...r, candidates: { ...r.candidates, REFERENCE_FIX: r.candidates.REFERENCE_FIX.map(x => ({ ...x, checks: [] })) } };
    expect(accept(empty, M).accepted).toBe(false);
    expect(accept(empty, M).reasons.join("\n")).toMatch(/REFERENCE_FIX L0: no checks/);
    const missing = mapFix(r, "L21", x => ({ ...x, checks: x.checks.filter(c => c.name !== "f:still_unknown_after_restart") }));
    expect(accept(missing, M).reasons.join("\n")).toMatch(/L21.*f:still_unknown_after_restart.*missing/);
    const duplicated = mapFix(r, "L3", x => ({ ...x, checks: [...x.checks, x.checks[0]!] }));
    expect(accept(duplicated, M).accepted).toBe(false);
    const wrongKind = mapFix(r, "L1", x => ({ ...x, checks: x.checks.map(c => c.name === "one_matching_order" ? { ...c, kind: "shared_logic" as const } : c) }));
    expect(accept(wrongKind, M).reasons.join("\n")).toMatch(/one_matching_order.*shared_logic/);
  });

  it("a FAIL rung whose checks all passed is contradictory", () => {
    const bad = mapFix(goodReport(), "L7", x => ({ ...x, status: "FAIL" }));
    expect(evaluate(bad).invalidReasons.join("\n")).toMatch(/REFERENCE_FIX L7.*FAIL.*no failed check/);
  });

  it.each(["REJECTED_OTHERWISE", "PASSED", "INFRA_ERROR"] as const)("an NC recorded as %s makes the run INVALID", observed => {
    const r = goodReport();
    const bad = { ...r, negativeControls: r.negativeControls.map(n => n.id === "NC9" ? { ...n, observed } : n) };
    expect(evaluate(bad).validity).toBe("INVALID");
    expect(evaluate(bad).invalidReasons.join("\n")).toMatch(/NC9/);
    expect(accept(bad, M).accepted).toBe(false);
  });

  it("an NC's observation is derived from its own recorded checks, not taken from its label", () => {
    const n = ncResult("NC1");
    expect(deriveNcObservation(n)).toBe("REJECTED_AS_INTENDED");
    const otherwise = { ...n, result: rung("L3", ["reuse_corroborated:SYN-INT-1"]) };
    expect(deriveNcObservation(otherwise)).toBe("REJECTED_OTHERWISE");
    expect(deriveNcObservation({ ...n, result: rung("L3") })).toBe("PASSED");
    expect(deriveNcObservation({ ...n, result: { ...rung("L3"), status: "INFRA_ERROR" } })).toBe("INFRA_ERROR");
    expect(deriveNcObservation({ ...n, result: { ...n.result, checks: [] } })).toBe("REJECTED_OTHERWISE");
    const r = goodReport();
    const labelled = { ...r, negativeControls: r.negativeControls.map(x => x.id === "NC1" ? { ...otherwise, observed: "REJECTED_AS_INTENDED" as const } : x) };
    expect(evaluate(labelled).invalidReasons.join("\n")).toMatch(/NC1.*REJECTED_OTHERWISE/);
    const wrongRung = { ...r, negativeControls: r.negativeControls.map(x => x.id === "NC2" ? { ...x, result: rung("L3", ["one_matching_order:SYN-INT-1"]) } : x) };
    expect(evaluate(wrongRung).invalidReasons.join("\n")).toMatch(/NC2/);
  });

  // Review CP3 B2: failing the intended check for another reason (e.g. NC10 construction failing other than DATA_MODIFYING_CTE) doesn't count.
  it("an NC whose intended check failed for an unexpected reason is REJECTED_OTHERWISE", () => {
    for (const id of NCS) {
      const n = ncResult(id);
      expect(deriveNcObservation(n), id).toBe("REJECTED_AS_INTENDED");
      const key = Object.keys(NC_INTENDED[id].expect)[0]!;
      const wrong = { ...n, result: observe(n.result, NC_INTENDED[id].check, { ...NC_INTENDED[id].expect, [key]: "something else" }) };
      expect(deriveNcObservation(wrong), id).toBe("REJECTED_OTHERWISE");
      expect(deriveNcObservation({ ...n, result: observe(n.result, NC_INTENDED[id].check, {}) }), id).toBe("REJECTED_OTHERWISE");
    }
    expect(NC_INTENDED.NC10.expect).toEqual({ claimCode: "DATA_MODIFYING_CTE" });
    expect(NC_INTENDED.NC9.expect).toEqual({ orders: 0, claimCode: "STATEMENT_POSTCONDITION" });
  });

  it("a missing NC, or one mapped to another oracle, makes the run INVALID", () => {
    const r = goodReport();
    expect(evaluate({ ...r, negativeControls: r.negativeControls.filter(n => n.id !== "NC7") }).invalidReasons.join("\n")).toMatch(/NC7/);
    const remapped = { ...r, negativeControls: r.negativeControls.map(n => n.id === "NC1" ? { ...n, intended: { rung: "L1" as const, check: "one_matching_order" } } : n) };
    expect(evaluate(remapped).invalidReasons.join("\n")).toMatch(/NC1/);
  });

  it.each([
    ["ORIGINAL L4 passing", (r: RunReport) => ({ ...r, candidates: { ...r.candidates, ORIGINAL: [{ ...rung("L4"), reproduced: "forced" as const }] } }), /ORIGINAL L4/],
    ["ORIGINAL L4 labelled FAIL without the forced duplicate observed", (r: RunReport) => ({ ...r, candidates: { ...r.candidates,
      ORIGINAL: [{ ...rung("L4", ["stress:one_matching_order"]), reproduced: "forced" as const }] } }), /ORIGINAL L4.*forced:one_matching_order/],
    // Review CP3 B2: the positive control must show the duplicate itself, not just any failure of the order check.
    ["ORIGINAL L4 failing with 0 orders", (r: RunReport) => ({ ...r, candidates: { ...r.candidates, ORIGINAL: [originalL4(0)] } }), /ORIGINAL L4.*2 orders/],
    ["ORIGINAL L4 failing with 1 mismatched order", (r: RunReport) => ({ ...r, candidates: { ...r.candidates, ORIGINAL: [originalL4(1)] } }), /ORIGINAL L4.*2 orders/],
    ["ORIGINAL L4 with uncorroborated outcomes", (r: RunReport) => ({ ...r, candidates: { ...r.candidates,
      ORIGINAL: [{ ...observe(rung("L4", ["forced:one_matching_order", "forced:outcomes_corroborated"]), "forced:one_matching_order", { orders: 2 }), reproduced: "forced" as const }] } }), /ORIGINAL L4/],
    ["ORIGINAL L4 failing only under stress", (r: RunReport) => ({ ...r, candidates: { ...r.candidates, ORIGINAL: [{ ...r.candidates.ORIGINAL[0]!, reproduced: "stress_only" as const }] } }), /ORIGINAL L4/],
    ["ORIGINAL L4 missing", (r: RunReport) => ({ ...r, candidates: { ...r.candidates, ORIGINAL: [] } }), /ORIGINAL L4/],
    ["candidate Node v24.11.0", (r: RunReport) => ({ ...r, environment: { ...r.environment, candidateNode: "v24.11.0" } }), /v24\.11\.0/],
    ["PostgreSQL 17", (r: RunReport) => ({ ...r, environment: { ...r.environment, postgresVersion: "17.4" } }), /PostgreSQL/],
    ["a LIMITATION anywhere", (r: RunReport) => ({ ...r, candidates: { ...r.candidates, ORIGINAL: [...r.candidates.ORIGINAL, { ...rung("L1"), status: "LIMITATION" as const }] } }), /LIMITATION/],
    ["a controller-recorded reason", (r: RunReport) => ({ ...r, invalidReasons: ["manifest drift: packages/verifier/src/rungs.ts"] }), /manifest drift/],
  ])("%s makes the run INVALID", (_name, mutate, reason) => {
    const out = evaluate(mutate(goodReport()));
    expect(out.validity).toBe("INVALID");
    expect(out.invalidReasons.join("\n")).toMatch(reason);
    expect(accept(mutate(goodReport()), M).accepted).toBe(false);
  });

  it("requires the expected manifest", () => {
    expect(accept(goodReport(), { expectedManifestSha256: "other" }).accepted).toBe(false);
    expect(accept(goodReport(), { expectedManifestSha256: "" }).accepted).toBe(false);
  });

  it("compareForced ignores timings, seeds and details, and reports differing statuses, check results and NC observations", () => {
    const a = goodReport();
    const b = { ...goodReport(), runId: "run-2",
      candidates: { ...a.candidates, REFERENCE_FIX: a.candidates.REFERENCE_FIX.map(x => ({ ...x, seed: "999", checks: x.checks.map(c => ({ ...c, detail: "took 12 ms" })) })) } };
    expect(compareForced(a, b)).toEqual({ same: true, differences: [] });
    expect(compareForced(a, withRung(goodReport(), "L4", "FAIL")).differences.join("\n")).toMatch(/REFERENCE_FIX L4/);
    const flipped = mapFix(goodReport(), "L9", x => ({ ...x, checks: x.checks.map(c => c.name === "conflict_secondary" ? { ...c, ok: false } : c) }));
    expect(compareForced(a, flipped).differences.join("\n")).toMatch(/REFERENCE_FIX L9 conflict_secondary/);
    const d = { ...goodReport(), negativeControls: goodReport().negativeControls.map(n => n.id === "NC2" ? { ...n, result: rung("L1") } : n) };
    expect(compareForced(a, d).differences.join("\n")).toMatch(/NC2/);
  });

  it("names every NC's intended check among its rung's required checks", () => {
    for (const id of NCS) expect(Object.keys(REQUIRED_CHECKS[NC_INTENDED[id].rung])).toContain(NC_INTENDED[id].check);
  });
});
