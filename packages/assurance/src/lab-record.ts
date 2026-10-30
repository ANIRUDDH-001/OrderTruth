import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { qualification, evaluate, NC_INTENDED, type RunReport } from "../../verifier/src/report.ts";

const sha = z.string().regex(/^[0-9a-f]{64}$/), commit = z.string().regex(/^[0-9a-f]{40}$/);
const text = z.string().max(65_536), short = z.string().min(1).max(256);
const status = z.enum(["PASS", "FAIL", "FLAKY", "LIMITATION", "NOT_APPLICABLE", "NOT_RUN", "INFRA_ERROR"]);
const id = z.enum(["L0", "L1", "L3", "L4", "L5", "L7", "L9", "L21", "L22", "AUTH"]);
const observed = z.record(z.string().max(128), z.union([z.string().max(1024), z.number().finite(), z.boolean(), z.null()]));
const check = z.object({ name: short, kind: z.enum(["independent_state", "trusted_log", "shared_logic"]), ok: z.boolean(), detail: text,
  observed: observed.optional() }).strict();
const rung = z.object({ id, status, reproduced: z.enum(["forced", "stress_only"]).optional(), seed: short.optional(), checks: z.array(check).max(128) }).strict();
const ncObservation = z.enum(["REJECTED_AS_INTENDED", "REJECTED_OTHERWISE", "PASSED", "INFRA_ERROR"]);
const nc = z.object({ id: z.enum(["NC1", "NC2", "NC3", "NC6", "NC7", "NC8", "NC9", "NC10", "NC12"]),
  intended: z.object({ rung: id, check: short, expect: observed.optional() }).strict(), result: rung, observed: ncObservation, detail: text }).strict();
const environment = z.object({ candidateNode: short, controllerNode: short, postgresVersion: short, sourceCommit: commit,
  manifestSha256: sha, subjectSha256: sha, manifestAnchor: z.literal("committed HEAD:packages/verifier/verifier-manifest.json"),
  images: z.record(short, z.string().regex(/^[\w./:-]+@sha256:[0-9a-f]{64}$/)) }).strict();
const acceptance = z.object({ accepted: z.boolean(), reasons: z.array(text).max(256) }).strict();
const comparison = z.object({ same: z.boolean(), differences: z.array(text).max(256) }).strict();
const cleanup = z.object({ ok: z.boolean(), errors: z.array(text).max(128), downExit: z.number().int().nullable(), remaining: z.object({
  containers: z.array(short).max(128), volumes: z.array(short).max(128), networks: z.array(short).max(128),
}).strict() }).strict();
const report = z.object({ runId: short, validity: z.enum(["VALID", "INVALID"]), invalidReasons: z.array(text).max(256),
  candidates: z.object({ ORIGINAL: z.array(rung).max(10), REFERENCE_FIX: z.array(rung).length(10) }).strict(), negativeControls: z.array(nc).length(9),
  environment, limitations: z.array(text).max(64), acceptance: acceptance.optional() }).strict();
const summary = z.object({ runId: short, partial: z.boolean(), qualifying: z.boolean(), verificationQualified: z.boolean(),
  qualificationReasons: z.array(text).max(256), cleanup, manifestSha256: sha, environment, comparison, acceptance: z.array(acceptance).length(2),
  validity: z.array(z.enum(["VALID", "INVALID"])).length(2),
  statuses: z.array(z.record(short, z.record(short, status))).length(2), negativeControls: z.array(z.record(short, ncObservation)).length(2),
}).strict();
const bundle = z.object({ reports: z.array(report).length(2), summary, cleanup }).strict();
export type RunBundle = { reports: RunReport[]; summary: z.infer<typeof summary>; cleanup: z.infer<typeof cleanup> };
const requireFact = (fact: boolean, reason: string) => { if (!fact) throw new Error(`Lab admission: ${reason}`); };

export function validateRunBundle(input: unknown): RunBundle {
  const parsed = bundle.safeParse(input);
  if (!parsed.success) throw new Error(`Lab admission: malformed input at ${parsed.error.issues[0]?.path.join(".") ?? "root"}`);
  // The schemas check every field before the historical report API sees it. Optional JSON properties are left intact.
  const b = input as RunBundle, s = b.summary, c = b.cleanup;
  requireFact(b.reports.every((r, i) => r.runId === `${s.runId}-run${i + 1}`), "mixed run identity");
  requireFact(b.reports.every(r => isDeepStrictEqual(r.environment, s.environment)), "mixed source/environment identity");
  for (const r of b.reports) for (const n of r.negativeControls) {
    const facts = (n.intended as { expect?: unknown }).expect;
    if (facts !== undefined) requireFact(isDeepStrictEqual(facts, NC_INTENDED[n.id].expect), "recorded intended oracle changed");
  }
  requireFact(s.manifestSha256 === s.environment.manifestSha256, "manifest identity disagreement");
  const q = qualification(b.reports, { expectedManifestSha256: s.manifestSha256, requestedRuns: 2, filtered: false });
  requireFact(q.qualifying && b.reports.every(r => r.validity === "VALID" && evaluate(r).validity === "VALID"), "reports do not qualify");
  requireFact(!s.partial && s.verificationQualified && s.qualifying && s.qualificationReasons.length === 0, "final qualification incomplete");
  requireFact(c.ok && c.errors.length === 0 && c.downExit === 0 && Object.values(c.remaining).every(xs => xs.length === 0), "cleanup did not succeed");
  requireFact(isDeepStrictEqual(c, s.cleanup), "summary hides or disagrees with authoritative cleanup");
  const expected = {
    comparison: q.comparison, acceptance: q.acceptance, validity: b.reports.map(r => r.validity),
    statuses: b.reports.map(r => Object.fromEntries(Object.entries(r.candidates).map(([k, rs]) => [k, Object.fromEntries(rs.map(x => [x.id, x.status]))]))),
    negativeControls: b.reports.map(r => Object.fromEntries(r.negativeControls.map(n => [n.id, n.observed]))),
  };
  for (const key of ["comparison", "acceptance", "validity", "statuses", "negativeControls"] as const)
    requireFact(isDeepStrictEqual(s[key], expected[key]), `recorded ${key} contradicts recomputed facts`);
  b.reports.forEach((r, i) => { const recorded = (r as RunReport & { acceptance?: unknown }).acceptance;
    if (recorded !== undefined) requireFact(isDeepStrictEqual(recorded, q.acceptance[i]), "report acceptance contradicts recomputed facts"); });
  return b;
}

export const LAB_LABEL = "Reference integration, verified offline in an isolated container, using a synthetic PayPal-shaped fixture (no PayPal data). Separate from your judge case, which uses a genuine PayPal Sandbox observation.";
export const LAB_LIMITATIONS = [
  "Fixed V-A P1/T1 lab only; not deployed or production-verified.",
  "Candidate INSERT/UPDATE access can conceal effects or fabricate records; arbitrary hostile or AI-generated code is not qualified.",
  "The candidate container is reused; exec timeout does not establish that all candidate descendants stopped.",
  "Only the two exercised V-A paths are covered; undiscovered paths and historical coverage are not tested.",
  "External exactly-once effects are unsupported. P2, T2, consumers, ingest and legacy reconciliation are deferred.",
  "Gate A establishes no AI migration value. No applied migration patch was recorded.",
  "Build hashes establish consistency with recorded evidence, not independent attestation of execution.",
];

export function deriveProof(b: RunBundle, comparisonSha256: string, referenceSha256: string, reviewEvidenceSha256: string) {
  validateRunBundle(b);
  return { protocol: "ordertruth.protection-proof/v1", variant: "V-A", defect: "REF-BUG-1", profile: "P1", tier: "T1",
    contract: { id: "OT_V3_OBLIGATION", version: "0.1.0" }, sdkVersion: "0.1.0-gate-a", sourceCommit: b.summary.environment.sourceCommit,
    runId: b.summary.runId, environment: b.summary.environment,
    candidate: { origin: "REFERENCE_FIX", implementationSha256: referenceSha256, diffSha256: null, diffStatus: "NOT_RECORDED_GATE_A", referenceComparisonSha256: comparisonSha256 },
    policyGate: "NOT_APPLICABLE_REFERENCE_FIX", review: { decision: "RECORDED_GATE_A_PASS", evidenceSha256: reviewEvidenceSha256, attestation: "NOT_INDEPENDENT" },
    provenance: { authority: "TEST", label: LAB_LABEL, execution: "LOCAL_CONTAINERS" },
    coverage: { paths: [{ pathId: "checkout_return", tier: "T1" }, { pathId: "webhook", tier: "T1" }], historical: "NOT_TESTED", scope: "EXERCISED_LAB_PATHS_ONLY" },
    qualification: { qualifying: true, cleanup: b.cleanup, comparison: b.summary.comparison },
    runs: b.reports.map(r => ({ runId: r.runId, original: r.candidates.ORIGINAL, reference: r.candidates.REFERENCE_FIX, negativeControls: r.negativeControls })),
    limitations: [...new Set([...LAB_LIMITATIONS, ...b.reports.flatMap(r => r.limitations)])],
  } as const;
}
export type LabProof = ReturnType<typeof deriveProof>;
