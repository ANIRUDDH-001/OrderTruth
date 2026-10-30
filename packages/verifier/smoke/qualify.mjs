// `pnpm v3:qualify`: runs the qualify container against a disposable postgres:18, then always tears everything down.
// Usage: pnpm v3:qualify [checkpoint-N]   (default checkpoint-1). Output: .work/v3/gate-a/<checkpoint>/qualify.log
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const checkpoint = process.argv[2] ?? "checkpoint-1";
if (!/^checkpoint-[0-9]$/.test(checkpoint)) throw new Error(`invalid checkpoint name ${checkpoint}`);
mkdirSync(`.work/v3/gate-a/${checkpoint}`, { recursive: true });
const compose = ["compose", "-f", "packages/verifier/smoke/smoke.compose.yml", "--profile", "qualify"];
const env = { ...process.env, OT_CHECKPOINT: checkpoint };
const run = spawnSync("docker", [...compose, "run", "--rm", "--build", "qualify"], { stdio: "inherit", env, timeout: 20 * 60_000 });
const down = spawnSync("docker", [...compose, "down", "-v", "--remove-orphans"], { stdio: "inherit", env, timeout: 2 * 60_000 });
if (down.status !== 0) console.error("warning: teardown did not complete cleanly");
process.exitCode = run.status ?? 1;
