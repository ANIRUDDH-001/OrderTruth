import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { labPlugin } from "../scripts/lab-build.ts";
import { writePublication, FILES, jsonBytes, byteSha } from "../packages/assurance/src/lab-files.ts";
import { fixturePublication } from "./helpers/lab-publication.ts";
import { SOURCE } from "./helpers/lab.ts";
const dirs: string[] = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(), "ordertruth-lab-build-")); dirs.push(p); return p; };
afterEach(() => { for (const p of dirs.splice(0)) { if (!resolve(p).startsWith(resolve(tmpdir()))) throw new Error("unsafe cleanup"); rmSync(p, { recursive: true }); } });
function setup() {
  const p = fixturePublication(), site = temp(), records = temp(); writePublication(records, p);
  writeFileSync(join(site, "index.html"), '<html><body><script type="module">console.log(__ORDERTRUTH_LAB__)</script></body></html>');
  const run = () => build({ root: site, configFile: false, envDir: false, logLevel: "silent", plugins: [labPlugin({ publicationRoot: records, pins: p.pins,
    identity: { commit: "e".repeat(40), dirty: true } })], build: { write: false, minify: false } });
  return { p, site, records, run };
}
describe("actual Vite lab build", () => {
  it("embeds the validated source identity separately from the dirty publication identity and emits seven evidence assets", async () => {
    const { run } = setup(); const result = await run();
    const output = Array.isArray(result) ? result[0]!.output : "output" in result ? result.output : [];
    const code = output.flatMap(x => x.type === "chunk" ? [x.code] : []).join("\n");
    expect(code).toContain(SOURCE); expect(code).toContain("e".repeat(40)); expect(code).toContain('"dirty": true');
    expect(output.filter(x => x.type === "asset" && x.fileName.startsWith("lab/evidence/"))).toHaveLength(8);
  });
  it("fails the actual build for changed evidence bytes", async () => {
    const { records, run } = setup(); writeFileSync(join(records, FILES.cleanup), "{}");
    await expect(run()).rejects.toThrow(/artifact hash mismatch/);
  });
  it("fails even after a fabricated cleanup is rehashed in the adjacent manifest", async () => {
    const { p, records, run } = setup(); const fake = jsonBytes({ ...JSON.parse(p.raw.cleanup.toString()), downExit: 7 });
    writeFileSync(join(records, FILES.cleanup), fake); p.manifest.files.find(f => f.role === "cleanup")!.sha256 = byteSha(fake);
    writeFileSync(join(records, "manifest.json"), jsonBytes(p.manifest));
    await expect(run()).rejects.toThrow(/historical cleanup hash mismatch/);
  });
  it("emits the exact manifest bytes whose hash the page embeds, including harmless formatting", async () => {
    const { records, run } = setup();
    const bytes = Buffer.concat([readFileSync(join(records, "manifest.json")), Buffer.from("  \n")]);
    writeFileSync(join(records, "manifest.json"), bytes);
    const result = await run();
    const output = Array.isArray(result) ? result[0]!.output : "output" in result ? result.output : [];
    const asset = output.find(x => x.type === "asset" && x.fileName === "lab/evidence/manifest.json");
    expect(asset?.type).toBe("asset");
    if (asset?.type !== "asset") throw new Error("manifest asset missing");
    expect(Buffer.from(asset.source)).toEqual(bytes);
    expect(output.flatMap(x => x.type === "chunk" ? [x.code] : []).join("\n")).toContain(byteSha(bytes));
  });
});
