/** Disposable supported-runtime validation. Only the explicitly permitted snapshot enters Docker. */
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { snapshotSource, verifySnapshot } from "../packages/assurance/src/source-snapshot.ts";
import { jsonBytes } from "../packages/assurance/src/lab-files.ts";
import { readBuildIdentity } from "./lab-build.ts";
import { checkPackagedLab } from "./check-packaged-lab.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
function insideCommand(args: string[], timeout = 240_000) {
  const r = spawnSync("node", args, { cwd: root, stdio: "inherit", timeout, windowsHide: true });
  if (r.status !== 0 || r.error) throw new Error(`W1 check failed: ${args.slice(0, 4).join(" ")} (${String(r.status)})`);
}
async function inside() {
  const digest = verifySnapshot(root), expected = process.argv[process.argv.indexOf("--expected-snapshot") + 1];
  if (process.argv.includes("--expected-snapshot") && digest !== expected) throw new Error("W1 stale source snapshot: expected identity does not match image");
  if (process.argv.includes("--verify-only")) { console.log(`W1 snapshot verified ${digest}`); return; }
  if (process.version !== "v22.18.0" || readFileSync("/opt/w1-pnpm-version", "utf8").trim() !== "11.4.0") throw new Error("W1 unsupported runtime/dependency manager");
  console.log(`W1 Node ${process.version}; pnpm 11.4.0; source snapshot ${digest}`);
  insideCommand(["node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.json"]);
  insideCommand(["node_modules/typescript/bin/tsc", "--noEmit", "-p", "packages/tsconfig.json"]);
  const w1Tests = readdirSync(resolve(root, "tests")).filter(p => /^lab-.*\.test\.ts$/.test(p)).map(p => `tests/${p}`);
  insideCommand(["node_modules/vitest/vitest.mjs", "run", "tests/v3", ...w1Tests, "--configLoader", "runner"]);
  for (const configFile of ["vite.config.ts", "vite.console.config.ts", "vite.judge.config.ts", "vite.owner.config.ts"])
    await build({ configFile: resolve(root, configFile), configLoader: "runner", envDir: false });
  insideCommand(["scripts/package-frontend.mjs"]);
  const packaged = await checkPackagedLab(resolve(root, "dist/judge"));
  writeFileSync(resolve(root, "dist/w1-validation.json"), jsonBytes({ node: process.version, pnpm: "11.4.0", snapshotSha256: digest, packaged, passed: true }));
  console.log("W1 supported-runtime checks and packaged routes PASS");
}
function host() {
  const checkpoint = resolve(root, ".work/v3/w1/checkpoint-1"); mkdirSync(checkpoint, { recursive: true });
  const context = mkdtempSync(resolve(checkpoint, "source-context-")), snapshot = snapshotSource(root, context), identity = { ...readBuildIdentity(root), snapshotSha256: snapshot.sha256 };
  writeFileSync(resolve(context, "w1-build-identity.json"), jsonBytes(identity));
  const name = `ot-w1-${snapshot.sha256.slice(0, 12)}`, image = `ot-v3-w1-validation:${snapshot.sha256.slice(0, 12)}`;
  const output = mkdtempSync(resolve(checkpoint, "node22-output-")), logPath = resolve(checkpoint, "node22-driver.log"), log = openSync(logPath, "w");
  const docker = (args: string[], timeout = 120_000, capture = false) => spawnSync("docker", args, { cwd: root, timeout, windowsHide: true,
    ...(capture ? { encoding: "utf8" as const } : { stdio: ["ignore", log, log] as ["ignore", number, number] }) });
  let passed = false, staleRejected = false, imageId = "", baseImage = "", cleanup = false;
  const cleanupErrors: string[] = [], resources: Record<string, string[]> = {};
  try {
    baseImage = readFileSync(resolve(context, "packages/assurance/docker/w1.Dockerfile"), "utf8").match(/^FROM (node:22\.18\.0-bookworm-slim@sha256:[0-9a-f]{64})$/m)?.[1] ?? "";
    if (!baseImage) throw new Error("W1 base image must be pinned by digest");
    const built = docker(["build", "-t", image, "-f", resolve(context, "packages/assurance/docker/w1.Dockerfile"), context], 1_200_000);
    if (built.status !== 0 || built.error) throw new Error("W1 Docker build failed; see node22-driver.log");
    const inspected = docker(["image", "inspect", image, "--format", '{{.Id}}|{{index .Config.Labels "ordertruth.w1.base"}}'], 30_000, true);
    if (inspected.status !== 0) throw new Error("W1 image identity unavailable");
    const [id, recordedBase] = String(inspected.stdout).trim().split("|");
    if (!id || recordedBase !== baseImage) throw new Error("W1 image base label does not match the pinned Dockerfile");
    imageId = id;
    const common = ["--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "256", "--memory", "2g", "--cpus", "2", "--label", "ordertruth.validation=w1",
      "--tmpfs", "/tmp:rw,mode=1777", "--tmpfs", "/app/node_modules/.vite:uid=1000,gid=1000", "--tmpfs", "/app/node_modules/.vite-temp:uid=1000,gid=1000"];
    const run = docker(["run", "--name", name, ...common, "--mount", `type=bind,source=${output},target=/app/dist`, image,
      "node", "--import", "tsx", "scripts/validate-w1.ts", "--inside", "--expected-snapshot", snapshot.sha256], 600_000);
    if (run.status !== 0 || run.error) throw new Error("W1 Node22 checks failed; see node22-driver.log");
    const stale = docker(["run", "--name", name + "-stale", ...common, image, "node", "--import", "tsx", "scripts/validate-w1.ts", "--inside", "--verify-only", "--expected-snapshot", "0".repeat(64)], 60_000, true);
    staleRejected = stale.status === 1 && String(stale.stderr).includes("stale source snapshot");
    writeFileSync(resolve(checkpoint, "stale-image-probe.log"), String(stale.stdout) + String(stale.stderr));
    if (!staleRejected) throw new Error("W1 stale-image negative control invalid");
    const result = JSON.parse(readFileSync(resolve(output, "w1-validation.json"), "utf8")) as { passed?: boolean; snapshotSha256?: string };
    passed = result.passed === true && result.snapshotSha256 === snapshot.sha256;
    if (!passed) throw new Error("W1 output does not match frozen source");
  } finally {
    for (const n of [name, name + "-stale"]) {
      const removed = docker(["rm", "-f", n], 60_000);
      if (removed.status !== 0) cleanupErrors.push(`container removal failed: ${n}`);
    }
    for (const [kind, args] of Object.entries({ containers: ["ps", "-aq"], volumes: ["volume", "ls", "-q"], networks: ["network", "ls", "-q"] })) {
      const inventory = docker([...args, "--filter", "label=ordertruth.validation=w1"], 30_000, true);
      if (inventory.status !== 0) cleanupErrors.push(`inventory failed: ${kind}`);
      resources[kind] = String(inventory.stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
      if (resources[kind]!.length) cleanupErrors.push(`remaining ${kind}`);
    }
    cleanup = cleanupErrors.length === 0;
    closeSync(log);
    writeFileSync(resolve(checkpoint, "node22-result.json"), jsonBytes({ passed: passed && cleanup, snapshot, identity, imageId, baseImage, staleRejected, cleanup,
      cleanupErrors, resources, context, output, log: logPath }));
    if (!cleanup) throw new Error("W1 cleanup failed");
  }
  console.log(JSON.stringify({ passed, cleanup, imageId, snapshotSha256: snapshot.sha256, output, log: logPath }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--inside")) await inside(); else host();
}
