import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { drift, recordedManifest, subjectFiles, subjectTreeSha, textSha, TRUSTED_FILES, verifierManifest } from "../../packages/verifier/src/manifest.ts";

describe("verifier manifest (plan Task 10 step 1)", () => {
  it("hashes text with CRLF normalized to LF", () => {
    expect(textSha(Buffer.from("a\r\nb\r\n"))).toBe(textSha(Buffer.from("a\nb\n")));
    expect(textSha(Buffer.from("a\nb"))).not.toBe(textSha(Buffer.from("a\nc")));
  });

  it("covers the fixed trusted list, every file once", () => {
    const m = verifierManifest();
    expect(m.files.map(f => f.path)).toEqual([...TRUSTED_FILES]);
    expect(new Set(TRUSTED_FILES).size).toBe(TRUSTED_FILES.length);
    for (const required of ["packages/verifier/src/controller-main.ts", "packages/verifier/src/rungs.ts", "packages/verifier/src/observer.ts",
      "packages/verifier/src/barrier.ts", "packages/verifier/src/proxy.ts", "packages/verifier/src/report.ts", "packages/verifier/src/manifest.ts",
      "packages/verifier/sql/roles.sql", "packages/guard/fixtures/synthetic-fixture.json", "packages/lab-merchant/src/v-a/ordertruth.config.ts",
      "packages/lab-merchant/src/v-a/original.ts", "packages/lab-merchant/src/v-a/reference-fix.ts", "packages/guard/sql/guard-v1.sql",
      "packages/lab-merchant/src/schema.ts", "packages/verifier/docker/base.Dockerfile", "packages/verifier/docker/proxy.Dockerfile",
      "packages/verifier/docker/gate-a.compose.yml", "package.json", "pnpm-lock.yaml",
      // review CP3 B3: what the controller executes to build templates, and what decides L0
      "packages/guard/src/schema.ts", "packages/guard/src/identity.ts", "src/domain/canonical.ts", "tests/v3/report.test.ts", "tests/v3/manifest.test.ts",
      "tests/v3-postgres/setup.ts", "packages/tsconfig.json", "tsconfig.json", "vitest.config.ts", "pnpm-workspace.yaml"])
      expect(TRUSTED_FILES).toContain(required);
    expect(m.files.every(f => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
  });

  it("drift names a changed, missing or extra file, and nothing when unchanged", () => {
    const m = verifierManifest();
    expect(drift(m, m)).toEqual([]);
    const changed = { ...m, files: m.files.map(f => f.path === "packages/verifier/src/rungs.ts" ? { ...f, sha256: "0".repeat(64) } : f) };
    expect(drift(changed, m)).toEqual(["changed: packages/verifier/src/rungs.ts"]);
    expect(drift({ ...m, files: m.files.filter(f => f.path !== "pnpm-lock.yaml") }, m)).toEqual(["not recorded: pnpm-lock.yaml"]);
    expect(drift({ ...m, files: [...m.files, { path: "extra.ts", sha256: "1".repeat(64) }] }, m)).toEqual(["no longer present: extra.ts"]);
  });

  it("hashes the subject under test (the guard tree and canonical encoding) for the report", () => {
    const files = subjectFiles();
    for (const f of ["packages/guard/src/guard.ts", "packages/guard/src/commit.ts", "packages/guard/src/testing/index.ts", "packages/guard/sql/guard-v1.sql",
      "packages/guard/fixtures/synthetic-fixture.json", "src/domain/canonical.ts"]) expect(files).toContain(f);
    expect(files).toEqual([...files].sort());
    expect(subjectTreeSha()).toMatch(/^[0-9a-f]{64}$/);
    expect(subjectTreeSha()).toBe(subjectTreeSha());
  });

  it("the committed verifier-manifest.json matches the tree", () => {
    const recorded = recordedManifest();
    expect(drift(recorded)).toEqual([]);
    expect(JSON.parse(readFileSync(new URL("../../packages/verifier/verifier-manifest.json", import.meta.url), "utf8"))).toEqual(recorded);
  });
});
