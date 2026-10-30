import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { checkPackagedLab } from "../scripts/check-packaged-lab.ts";
const dirs: string[] = [];
afterEach(() => { for (const p of dirs.splice(0)) { if (!resolve(p).startsWith(resolve(tmpdir()))) throw new Error("unsafe cleanup"); rmSync(p, { recursive: true }); } });
function site(missingAsset = false) {
  const root = mkdtempSync(join(tmpdir(), "ordertruth-packaged-")); dirs.push(root);
  for (const d of ["lab", "owner", "assets"]) mkdirSync(join(root, d));
  writeFileSync(join(root, "index.html"), '<html>Judge<script src="/assets/app.js"></script></html>');
  writeFileSync(join(root, "lab/index.html"), '<html>Integration Lab<script src="/assets/app.js"></script></html>');
  writeFileSync(join(root, "owner/index.html"), '<html>Owner<script src="/assets/app.js"></script></html>');
  if (!missingAsset) writeFileSync(join(root, "assets/app.js"), 'console.log("fixture")');
  return root;
}
describe("actual packaged static routing, no backend or sockets", () => {
  it("serves direct lab/judge/owner routes and their packaged assets", async () => {
    const result = await checkPackagedLab(site());
    expect(result.routes).toEqual(["/", "/lab/", "/lab/index.html", "/owner/"]);
    expect(result.assets).toContain("/assets/app.js");
  });
  it("rejects a missing packaged asset rather than accepting an HTML fallback", async () => {
    await expect(checkPackagedLab(site(true))).rejects.toThrow(/asset/);
  });
});
