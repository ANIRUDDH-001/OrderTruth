import type { Plugin } from "vite";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { InputPins } from "../packages/assurance/src/gate-a-inputs.ts";
import type { LabProof } from "../packages/assurance/src/lab-record.ts";
import type { PublicationManifest } from "../packages/assurance/src/lab-files.ts";
import { loadLab } from "../packages/assurance/src/lab-files.ts";
export type BuildIdentity = { commit: string | null; dirty: boolean; snapshotSha256?: string };
export type LabPageData = { proof: LabProof; publication: { manifestSha256: string; files: PublicationManifest["files"]; sourceAvailability: "NOT_VERIFIED" }; build: BuildIdentity };
export function readBuildIdentity(root: string): BuildIdentity {
  if (!existsSync(resolve(root, ".git")) && existsSync(resolve(root, "w1-build-identity.json"))) {
    const bytes = readFileSync(resolve(root, "w1-build-identity.json"));
    if (bytes.length > 2048) throw new Error("build identity exceeds limit");
    return z.object({ commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(), dirty: z.boolean(), snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict().parse(JSON.parse(bytes.toString("utf8")));
  }
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000, windowsHide: true }).trim();
    return { commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--untracked-files=normal") !== "" };
  } catch { return { commit: null, dirty: true }; }
}
export function labPlugin(o: { publicationRoot: string; projectRoot?: string; pins?: InputPins; identity?: BuildIdentity }): Plugin {
  let loaded: ReturnType<typeof loadLab>;
  return { name: "ordertruth-lab",
    config() {
      loaded = loadLab(o.publicationRoot, o.pins);
      const data: LabPageData = { proof: loaded.proof, publication: { manifestSha256: loaded.manifestSha256, files: loaded.manifest.files, sourceAvailability: "NOT_VERIFIED" },
        build: o.identity ?? readBuildIdentity(o.projectRoot ?? process.cwd()) };
      return { define: { __ORDERTRUTH_LAB__: JSON.stringify(data) } };
    },
    generateBundle() {
      for (const f of loaded.manifest.files) this.emitFile({ type: "asset", fileName: `lab/evidence/${f.file}`, source: loaded.artifacts[f.role] });
      this.emitFile({ type: "asset", fileName: "lab/evidence/manifest.json", source: loaded.manifestBytes });
    },
  };
}
