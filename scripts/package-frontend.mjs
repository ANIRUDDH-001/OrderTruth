import { cpSync,existsSync } from "node:fs";
import { assertDeploymentTarget } from "./preview-isolation.ts";
import { frontendSource } from "./frontend-source.ts";
import { writeReleaseManifest } from "./release-manifest.ts";
import { execFileSync } from "node:child_process";
assertDeploymentTarget(process.env);
// Copy only built public assets. Never copy the repository or private env files.
if (!existsSync("dist/judge/index.html") || !existsSync("dist/owner/index.html")) throw new Error("Build both public frontends first");
cpSync("dist/owner","dist/judge/owner",{ recursive: true });
let commit=null;
try {commit=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim();} catch {}
writeReleaseManifest("dist/judge",frontendSource(process.env,commit),process.env.VERCEL_ENV ?? (process.env.CI ? "ci" : "local"));
