import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { GATE_A_INPUTS } from "../packages/assurance/src/gate-a-inputs.ts";
import { byteSha, createPublication, jsonBytes, readBounded, writePublication } from "../packages/assurance/src/lab-files.ts";

export function exportLab(runDirectory: string, outputDirectory: string, root = fileURLToPath(new URL("../", import.meta.url))) {
  const atSource = (path: string) => execFileSync("git", ["show", `${GATE_A_INPUTS.sourceCommit}:${path}`], { cwd: root, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  const sourceModule = (path: string) => {
    const content = atSource(path).toString("utf8").replace(/\r\n/g, "\n");
    return { path, content, sha256: byteSha(content) };
  };
  const publication = createPublication({ report1: readBounded(runDirectory, "run-1/report.json"), report2: readBounded(runDirectory, "run-2/report.json"),
    summary: readBounded(runDirectory, "summary.json"), cleanup: readBounded(runDirectory, "cleanup.json"),
    verifier: atSource("packages/verifier/verifier-manifest.json"), reference: jsonBytes({ protocol: "reference-source-comparison/v1", sourceCommit: GATE_A_INPUTS.sourceCommit,
      original: sourceModule("packages/lab-merchant/src/v-a/original.ts"), reference: sourceModule("packages/lab-merchant/src/v-a/reference-fix.ts") }) });
  writePublication(outputDirectory, publication);
  return { runId: publication.manifest.runId, sourceCommit: publication.manifest.sourceCommit, manifestSha256: byteSha(jsonBytes(publication.manifest)) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error("usage: publish-lab-evidence.ts <accepted run directory> <output directory>");
  console.log(JSON.stringify(exportLab(input, output), null, 2));
}
