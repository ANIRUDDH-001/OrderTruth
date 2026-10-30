import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { loadLab, createPublication, writePublication, jsonBytes, byteSha, FILES, type ArtifactRole } from "../packages/assurance/src/lab-files.ts";
import { fixturePublication } from "./helpers/lab-publication.ts";

const dirs: string[] = [];
const hash = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");
function temp() { const p = mkdtempSync(join(tmpdir(), "ordertruth-lab-")); dirs.push(p); return p; }
afterEach(() => { for (const p of dirs.splice(0)) { if (!resolve(p).startsWith(resolve(tmpdir()) + "/") && !resolve(p).startsWith(resolve(tmpdir()) + "\\")) throw new Error("unsafe test cleanup"); rmSync(p, { recursive: true }); } });

describe("public lab file admission", () => {
  it("publishes a deterministic self-contained bundle, without inventing a patch, AI or coverage claim", () => {
    const p = fixturePublication(), root = temp();
    writePublication(root, p); const loaded = loadLab(root, p.pins);
    expect(loaded.proof.candidate.diffSha256).toBeNull();
    expect(loaded.proof.candidate.origin).toBe("REFERENCE_FIX");
    expect(loaded.proof.policyGate).toBe("NOT_APPLICABLE_REFERENCE_FIX");
    expect(loaded.proof.coverage.historical).toBe("NOT_TESTED");
    expect(loaded.proof.provenance.authority).toBe("TEST");
    expect(loaded.proof.review.attestation).toBe("NOT_INDEPENDENT");
    expect(p.manifest.files).toHaveLength(7);
    expect(p.manifest.files.some(f => f.file === "manifest.json")).toBe(false);
    expect(jsonBytes(createPublication(p.raw, p.pins).manifest)).toEqual(jsonBytes(p.manifest));
  });
  it("rejects missing public artifacts", () => { expect(() => loadLab(temp())).toThrow(); });
  it("rejects path traversal before opening an artifact", () => {
    const root = temp(); writeFileSync(join(root, "manifest.json"), JSON.stringify({ protocol: "ordertruth.lab-publication/v1", files: [{ role: "report1", file: "../outside.json", sha256: "0".repeat(64) }] }));
    expect(() => loadLab(root)).toThrow();
  });
  it("rejects empty or malformed success flags instead of deriving a proof", () => {
    const root = temp(); writeFileSync(join(root, "manifest.json"), JSON.stringify({ qualifying: true, accepted: true }));
    expect(() => loadLab(root)).toThrow();
  });

  for (const role of Object.keys(FILES) as ArtifactRole[]) it(`rejects changed ${role} bytes`, () => {
    const p = fixturePublication(), root = temp(); writePublication(root, p);
    writeFileSync(join(root, FILES[role]), Buffer.concat([p.artifacts[role], Buffer.from(" ")]));
    expect(() => loadLab(root, p.pins)).toThrow(/artifact hash mismatch/);
  });

  it.each(["summary", "cleanup", "proof", "verifier", "reference"] as const)("rehashing a fabricated %s in the neighboring manifest does not authorize it", role => {
    const p = fixturePublication(), root = temp(); writePublication(root, p);
    const x = JSON.parse(p.artifacts[role].toString());
    if (role === "summary") x.runId = "fabricated";
    if (role === "cleanup") x.downExit = 4;
    if (role === "proof") x.candidate.origin = "AI_AGENT";
    if (role === "verifier") x.files[0].sha256 = "0".repeat(64);
    if (role === "reference") x.reference.content += "// forged";
    const bytes = jsonBytes(x); writeFileSync(join(root, FILES[role]), bytes);
    p.manifest.files.find(f => f.role === role)!.sha256 = byteSha(bytes);
    writeFileSync(join(root, "manifest.json"), jsonBytes(p.manifest));
    expect(() => loadLab(root, p.pins)).toThrow(/historical|fabricated|source/);
  });

  it.each(["missing", "duplicate", "escape"])("rejects %s artifact roles/paths before artifact access", mode => {
    const p = fixturePublication(), root = temp();
    if (mode === "missing") p.manifest.files.pop();
    if (mode === "duplicate") p.manifest.files[1] = { ...p.manifest.files[0]! };
    if (mode === "escape") p.manifest.files[0]!.file = "../not-present.json";
    writeFileSync(join(root, "manifest.json"), jsonBytes(p.manifest));
    expect(() => loadLab(root, p.pins)).toThrow(/malformed|duplicate|unsafe/);
  });

  it("rejects a symlink publication root", () => {
    const p = fixturePublication(), root = temp(), link = join(temp(), "linked"); writePublication(root, p);
    symlinkSync(root, link, "junction"); expect(() => loadLab(link, p.pins)).toThrow(/unsafe publication directory/);
  });

  it("rejects oversized artifacts and refuses to replace existing different output", () => {
    const p = fixturePublication(), root = temp(); writePublication(root, p);
    writeFileSync(join(root, FILES.proof), Buffer.alloc(2 * 1024 * 1024 + 1, 32));
    expect(() => loadLab(root, p.pins)).toThrow(/size/);
    expect(() => writePublication(root, p)).toThrow(/size|refusing/);
    expect(readFileSync(join(root, FILES.report1))).toEqual(p.raw.report1);
  });
});
