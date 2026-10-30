import { NC_INTENDED, REQUIRED_CHECKS, type NcId, type RungId, type RungResult, type RunReport, qualification } from "../../packages/verifier/src/report.ts";

export const SOURCE = "a".repeat(40), MANIFEST = "b".repeat(64), SUBJECT = "c".repeat(64), RUN = "gate-a-fixture";
const rung = (id: RungId): RungResult => ({ id, status: "PASS", checks: Object.entries(REQUIRED_CHECKS[id]).map(([name, kind]) => ({ name, kind, ok: true, detail: "fixture" })) });
export function fixtureReport(n: number): RunReport {
  const original = rung("L4"); original.status = "FAIL"; original.reproduced = "forced";
  Object.assign(original.checks[0]!, { ok: false, observed: { orders: 2 } });
  return { runId: `${RUN}-run${n}`, validity: "VALID", invalidReasons: [],
    candidates: { ORIGINAL: [original], REFERENCE_FIX: (Object.keys(REQUIRED_CHECKS) as RungId[]).map(rung) },
    negativeControls: (Object.keys(NC_INTENDED) as NcId[]).map(id => {
      const want = NC_INTENDED[id], result = rung(want.rung); result.status = "FAIL";
      Object.assign(result.checks.find(c => c.name === want.check)!, { ok: false, observed: { ...want.expect } });
      return { id, intended: { rung: want.rung, check: want.check }, result, observed: "REJECTED_AS_INTENDED", detail: "fixture" };
    }),
    environment: { candidateNode: "v22.18.0", controllerNode: "v24.11.0", postgresVersion: "18.6", sourceCommit: SOURCE,
      manifestSha256: MANIFEST, subjectSha256: SUBJECT, manifestAnchor: "committed HEAD:packages/verifier/verifier-manifest.json",
      images: { candidate: "candidate:fixture@sha256:" + "d".repeat(64) } }, limitations: ["Synthetic fixture"] };
}
export function fixtureBundle() {
  const reports = [fixtureReport(1), fixtureReport(2)], cleanup = { ok: true, errors: [] as string[], downExit: 0, remaining: { containers: [] as string[], volumes: [] as string[], networks: [] as string[] } };
  const q = qualification(reports, { expectedManifestSha256: MANIFEST, requestedRuns: 2, filtered: false });
  return { reports, cleanup, summary: { runId: RUN, partial: false, qualifying: true, verificationQualified: true, qualificationReasons: [], cleanup: structuredClone(cleanup),
    manifestSha256: MANIFEST, environment: structuredClone(reports[0]!.environment), comparison: q.comparison, acceptance: q.acceptance,
    validity: reports.map(r => r.validity), statuses: reports.map(r => Object.fromEntries(Object.entries(r.candidates).map(([k, rs]) => [k, Object.fromEntries(rs.map(x => [x.id, x.status]))]))),
    negativeControls: reports.map(r => Object.fromEntries(r.negativeControls.map(n => [n.id, n.observed]))) } };
}
