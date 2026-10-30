import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { ROOT_INPUTS, snapshotSource, verifySnapshot } from "../packages/assurance/src/source-snapshot.ts";
const dirs: string[] = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(), "ordertruth-w1-snapshot-")); dirs.push(p); return p; };
afterEach(() => { for (const p of dirs.splice(0)) { if (!resolve(p).startsWith(resolve(tmpdir()))) throw new Error("unsafe cleanup"); rmSync(p, { recursive: true }); } });
function fixture() {
  const root = temp(); const put = (p: string, text: string) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); };
  for (const p of ROOT_INPUTS) put(p, "{}\n");
  for (const p of ["src/main.ts", "web/judge/lab/main.ts", "scripts/lab-build.ts", "packages/assurance/src/lab-record.ts", "tests/lab-build.test.ts", "docs/evidence/lab/manifest.json"])
    put(p, "initial\n");
  return { root, put };
}
describe("W1 exact permitted-source snapshot", () => {
  it("copies current new W1 code/config, verifies it, and binds the observed code to its digest", () => {
    const f = fixture(), output = temp(), s = snapshotSource(f.root, output);
    expect(s.files.some(x => x.path === "web/judge/lab/main.ts")).toBe(true);
    expect(readFileSync(join(output, "scripts/lab-build.ts"), "utf8")).toBe("initial\n");
    expect(verifySnapshot(output)).toBe(s.sha256);
  });
  it("a source/config change changes the digest and a stale snapshot fails", () => {
    const f = fixture(), old = temp(), first = snapshotSource(f.root, old);
    f.put("vite.judge.config.ts", "changed configuration\n"); f.put("web/judge/lab/main.ts", "changed observed code\n");
    const fresh = temp(), second = snapshotSource(f.root, fresh);
    expect(second.sha256).not.toBe(first.sha256);
    expect(readFileSync(join(fresh, "web/judge/lab/main.ts"), "utf8")).toBe("changed observed code\n");
    writeFileSync(join(old, "web/judge/lab/main.ts"), "changed observed code\n");
    expect(() => verifySnapshot(old)).toThrow(/snapshot/);
  });
  it("excludes credential sentinels, private state, dependencies and generated output before copying", () => {
    const f = fixture(), output = temp();
    // Synthetic sentinels only. Their contents must never be read by the snapshotter.
    for (const p of [".env", "web/.env.local", "packages/credentials/key.json", "src/secrets/key.json", "src/private.key", "web/node_modules/a.js", "scripts/.work/log.json", "web/dist/a.js"])
      f.put(p, "excluded synthetic sentinel");
    const s = snapshotSource(f.root, output);
    expect(s.files.length).toBeGreaterThan(ROOT_INPUTS.length);
    for (const p of [".env", "web/.env.local", "packages/credentials/key.json", "src/secrets/key.json", "src/private.key", "web/node_modules/a.js", "scripts/.work/log.json", "web/dist/a.js"])
      expect(existsSync(join(output, p))).toBe(false);
  });
  it("detects unlisted source added after snapshot generation", () => {
    const f = fixture(), output = temp(); snapshotSource(f.root, output);
    mkdirSync(join(output, "web/judge/lab"), { recursive: true });
    writeFileSync(join(output, "web/judge/lab/extra.ts"), "unlisted source");
    expect(() => verifySnapshot(output)).toThrow(/snapshot/);
  });
  it("includes public SQL inputs used by the frozen Gate A offline tests", () => {
    const f = fixture(), output = temp(); f.put("packages/guard/sql/guard-v1.sql", "SELECT 1;\n");
    const snapshot = snapshotSource(f.root, output);
    expect(snapshot.files.some(x => x.path === "packages/guard/sql/guard-v1.sql")).toBe(true);
    expect(readFileSync(join(output, "packages/guard/sql/guard-v1.sql"), "utf8")).toBe("SELECT 1;\n");
  });
});
