import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { z } from "zod";
import { byteSha, jsonBytes } from "./lab-files.ts";

export const ROOT_INPUTS = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "vite.config.ts", "vite.console.config.ts", "vite.judge.config.ts", "vite.owner.config.ts", "vitest.config.ts", "vitest.postgres.config.ts", "vitest.v3-postgres.config.ts", "vercel.json"];
const ROOTS = ["src", "web", "scripts", "packages", "tests", "docs/evidence/lab"];
const denied = new Set([".git", ".work", "node_modules", "dist", "build", "coverage", ".tmp", ".cache", "secrets", "credentials", "test-results", "playwright-report"]);
const excluded = (path: string) => path.split("/").some(p => denied.has(p) || p === ".env" || p.startsWith(".env.") || /\.(?:pem|key|p12|pfx|crt)$/i.test(p));
const permitted = (p: string) => !excluded(p) && (ROOT_INPUTS.includes(p) || ROOTS.some(r => p.startsWith(r + "/")))
  && /\.(?:[cm]?[jt]sx?|json|sql|html|css|svg|png|jpe?g|webp|ico|woff2?|sh|ya?ml|md|Dockerfile|dockerignore)$/.test(p);
const norm = (p: string) => process.platform === "win32" ? p.toLowerCase() : p;
const fact = (ok: boolean, why: string) => { if (!ok) throw new Error(`W1 snapshot: ${why}`); };
function directory(path: string) { fact(lstatSync(path).isDirectory() && norm(realpathSync(path)) === norm(resolve(path)), "symlink/unsafe directory"); }
function inventory(root: string) {
  directory(root);
  const files: string[] = [];
  const walk = (p: string) => {
    if (excluded(p)) return; // exclusions precede lstat/read/copy, including synthetic sentinel tests
    const absolute = resolve(root, p), stat = lstatSync(absolute);
    fact(!stat.isSymbolicLink() && norm(realpathSync(absolute)) === norm(absolute), "symlink input");
    if (stat.isDirectory()) for (const name of readdirSync(absolute).sort()) walk(`${p}/${name}`);
    else if (permitted(p)) { fact(stat.isFile() && stat.size <= 20 * 1024 * 1024, "source size/type"); files.push(p); }
  };
  for (const p of ROOT_INPUTS) { fact(existsSync(resolve(root, p)), `missing ${p}`); walk(p); }
  for (const p of ROOTS) if (existsSync(resolve(root, p))) walk(p);
  fact(files.length <= 10_000, "too many source files");
  return [...new Set(files)].sort();
}
const schema = z.object({ protocol: z.literal("ordertruth.w1-source/v1"), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  files: z.array(z.object({ path: z.string().max(512), sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().min(0).max(20 * 1024 * 1024) }).strict()).max(10_000) }).strict();
export function snapshotSource(root: string, output: string) {
  root = resolve(root); output = resolve(output); directory(root); directory(output);
  fact(readdirSync(output).length === 0 && output !== root, "output must be a fresh empty directory");
  const files = inventory(root).map(path => {
    const bytes = readFileSync(resolve(root, path));
    const target = resolve(output, path);
    fact(target.startsWith(output + sep), "output path escape");
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes, { flag: "wx" });
    return { path, sha256: byteSha(bytes), size: bytes.length };
  });
  fact(files.reduce((sum, f) => sum + f.size, 0) <= 128 * 1024 * 1024, "source snapshot too large");
  const snapshot = { protocol: "ordertruth.w1-source/v1" as const, sha256: byteSha(JSON.stringify(files)), files };
  writeFileSync(resolve(output, "source-snapshot.json"), jsonBytes(snapshot), { flag: "wx" });
  return snapshot;
}
export function verifySnapshot(root: string): string {
  directory(root);
  const bytes = readFileSync(resolve(root, "source-snapshot.json")); fact(bytes.length <= 2 * 1024 * 1024, "metadata too large");
  const s = schema.parse(JSON.parse(bytes.toString("utf8")));
  fact(s.sha256 === byteSha(JSON.stringify(s.files)), "metadata digest mismatch");
  const paths = s.files.map(f => f.path);
  fact(new Set(paths).size === paths.length && paths.every(p => !p.split("/").some(x => x === ".." || x === "." || x.includes("\\")) && permitted(p)), "unsafe/duplicate input path");
  fact(JSON.stringify(paths) === JSON.stringify(inventory(root)), "source inventory mismatch");
  for (const f of s.files) {
    const content = readFileSync(resolve(root, f.path));
    fact(content.length === f.size && byteSha(content) === f.sha256, `source hash mismatch: ${f.path}`);
  }
  return s.sha256;
}
