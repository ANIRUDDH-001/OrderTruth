/**
 * The verifier manifest (plan Task 10). Pins, before any candidate runs, the hash of every trusted file: the verifier, its
 * roles, the fixture, the lab merchant's trusted configuration, handlers and negative controls, the guard migration, the images,
 * the compose file and the locked dependencies. The controller refuses to run on drift.
 * Hashing follows src/ai/ask-eval/runner.ts: sha256 of UTF-8 text with CRLF normalized to LF.
 *
 *   tsx packages/verifier/src/manifest.ts --write     regenerates packages/verifier/verifier-manifest.json (operator step)
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../../../", import.meta.url);
const RECORDED = new URL("../verifier-manifest.json", import.meta.url);

export const TRUSTED_FILES: readonly string[] = [
  "packages/verifier/src/controller-main.ts", "packages/verifier/src/rungs.ts", "packages/verifier/src/observer.ts", "packages/verifier/src/barrier.ts",
  "packages/verifier/src/proxy.ts", "packages/verifier/src/proxy-main.ts", "packages/verifier/src/report.ts", "packages/verifier/src/manifest.ts",
  "packages/verifier/sql/roles.sql",
  "packages/guard/fixtures/synthetic-fixture.json", "packages/guard/sql/guard-v1.sql",
  "packages/lab-merchant/src/schema.ts", "packages/lab-merchant/src/types.ts", "packages/lab-merchant/src/candidate-main.ts",
  "packages/lab-merchant/src/v-a/ordertruth.config.ts", "packages/lab-merchant/src/v-a/original.ts", "packages/lab-merchant/src/v-a/reference-fix.ts",
  "packages/lab-merchant/src/nc/nc1-event-id-dedup.ts", "packages/lab-merchant/src/nc/nc2-suppress.ts", "packages/lab-merchant/src/nc/nc3-key-on-path.ts",
  "packages/lab-merchant/src/nc/nc6-hardcoded-capture.ts", "packages/lab-merchant/src/nc/nc7-oracle-probe.ts", "packages/lab-merchant/src/nc/nc8-fake-evidence.ts",
  "packages/lab-merchant/src/nc/nc9-lying-returning.ts", "packages/lab-merchant/src/nc/nc10-dml-cte.ts", "packages/lab-merchant/src/nc/nc12-fake-report.ts",
  "packages/verifier/docker/base.Dockerfile", "packages/verifier/docker/base.Dockerfile.dockerignore", "packages/verifier/docker/proxy.Dockerfile",
  "packages/verifier/docker/proxy.Dockerfile.dockerignore", "packages/verifier/docker/gate-a.compose.yml", "packages/verifier/docker/l0-in-container.sh",
  "package.json", "pnpm-lock.yaml",
  // Executed by the controller to build the templates (migrateGuard and its imports), review CP3 B3.
  "packages/guard/src/schema.ts", "packages/guard/src/identity.ts", "src/domain/canonical.ts",
  // What decides L0: the offline suite, its shared setup and the compiler/test/workspace configuration.
  "tests/v3/capability.test.ts", "tests/v3/config.test.ts", "tests/v3/entrypoint.test.ts", "tests/v3/guard-options.test.ts", "tests/v3/identity.test.ts",
  "tests/v3/manifest.test.ts", "tests/v3/proxy-frame.test.ts", "tests/v3/report.test.ts", "tests/v3-postgres/setup.ts", "tests/v3-postgres/harness.ts",
  "packages/tsconfig.json", "tsconfig.json", "vitest.config.ts", "pnpm-workspace.yaml",
];

/**
 * The subject under test is the guard itself: it isn't pinned (it may change between runs), but every report records a hash
 * of its whole tree, plus the canonical encoding it shares with v2, so an accepted run names exactly what it accepted.
 */
export function subjectFiles(): string[] {
  const walk = (dir: string): string[] => readdirSync(new URL(dir, ROOT)).flatMap(name => {
    const path = `${dir}/${name}`;
    return statSync(new URL(path, ROOT)).isDirectory() ? walk(path) : [path];
  });
  return [...walk("packages/guard"), "src/domain/canonical.ts"].sort();
}
export function subjectTreeSha(): string {
  return createHash("sha256").update(subjectFiles().map(p => `${p}\0${textSha(readFileSync(new URL(p, ROOT)))}\n`).join("")).digest("hex");
}

export type Manifest = { protocol: "ordertruth-v3-gate-a-verifier"; fileHashing: string; files: Array<{ path: string; sha256: string }> };

export const textSha = (bytes: Buffer) => createHash("sha256").update(bytes.toString("utf8").replace(/\r\n/g, "\n")).digest("hex");

export function verifierManifest(): Manifest {
  return { protocol: "ordertruth-v3-gate-a-verifier", fileHashing: "sha256 of UTF-8 text with CRLF normalized to LF",
    files: TRUSTED_FILES.map(path => ({ path, sha256: textSha(readFileSync(new URL(path, ROOT))) })) };
}
export const manifestSha256 = (m: Manifest) => createHash("sha256").update(JSON.stringify(m)).digest("hex");
export function recordedManifest(): Manifest { return JSON.parse(readFileSync(RECORDED, "utf8")) as Manifest; }

/** Names every trusted file that differs from the recorded manifest; empty means unchanged. */
export function drift(recorded: Manifest, current: Manifest = verifierManifest()): string[] {
  const out: string[] = [];
  const was = new Map(recorded.files.map(f => [f.path, f.sha256]));
  for (const f of current.files) {
    if (!was.has(f.path)) out.push(`not recorded: ${f.path}`);
    else if (was.get(f.path) !== f.sha256) out.push(`changed: ${f.path}`);
  }
  const now = new Set(current.files.map(f => f.path));
  for (const f of recorded.files) if (!now.has(f.path)) out.push(`no longer present: ${f.path}`);
  if (recorded.protocol !== current.protocol || recorded.fileHashing !== current.fileHashing) out.push("manifest protocol differs");
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  writeFileSync(RECORDED, `${JSON.stringify(verifierManifest(), null, 2)}\n`);
  console.log(`wrote ${fileURLToPath(RECORDED)}`);
}
