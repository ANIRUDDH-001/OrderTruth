import { fixtureBundle, SOURCE, SUBJECT, RUN } from "./lab.ts";
import { createPublication, jsonBytes, byteSha, type RawArtifacts } from "../../packages/assurance/src/lab-files.ts";
import type { InputPins } from "../../packages/assurance/src/gate-a-inputs.ts";
export function fixturePublication() {
  const original = { path: "packages/lab-merchant/src/v-a/original.ts", content: "export const original = true;\n", sha256: "" };
  const reference = { path: "packages/lab-merchant/src/v-a/reference-fix.ts", content: "export const reference = true;\n", sha256: "" };
  for (const x of [original, reference]) x.sha256 = byteSha(x.content);
  const verifier = { protocol: "ordertruth-v3-gate-a-verifier", fileHashing: "sha256 of UTF-8 text with CRLF normalized to LF",
    files: [original, reference].map(x => ({ path: x.path, sha256: x.sha256 })) };
  const verifierHash = byteSha(JSON.stringify(verifier)), b = fixtureBundle();
  for (const r of b.reports) r.environment.manifestSha256 = verifierHash;
  b.summary.environment.manifestSha256 = verifierHash; b.summary.manifestSha256 = verifierHash;
  const raw: RawArtifacts = { report1: jsonBytes(b.reports[0]), report2: jsonBytes(b.reports[1]), summary: jsonBytes(b.summary), cleanup: jsonBytes(b.cleanup),
    verifier: jsonBytes(verifier), reference: jsonBytes({ protocol: "reference-source-comparison/v1", sourceCommit: SOURCE, original, reference }) };
  const pins: InputPins = { sourceCommit: SOURCE, runId: RUN, verifierManifestSha256: verifierHash, subjectSha256: SUBJECT, reviewEvidenceSha256: "f".repeat(64),
    raw: { report1: byteSha(raw.report1), report2: byteSha(raw.report2), summary: byteSha(raw.summary), cleanup: byteSha(raw.cleanup) } };
  return { ...createPublication(raw, pins), pins, raw };
}
