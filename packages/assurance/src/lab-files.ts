import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { GATE_A_INPUTS, type InputPins } from "./gate-a-inputs.ts";
import { deriveProof, validateRunBundle } from "./lab-record.ts";

export const FILES = {
  report1: "gate-a-run-1.report.json", report2: "gate-a-run-2.report.json", summary: "gate-a-final-summary.json", cleanup: "gate-a-final-cleanup.json",
  verifier: "gate-a-verifier-manifest.json", reference: "gate-a-reference-source.json", proof: "gate-a-proof.json",
} as const;
export type ArtifactRole = keyof typeof FILES;
export type RawArtifacts = Record<Exclude<ArtifactRole, "proof">, Buffer>;
export const byteSha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/), sourceSchema = z.string().regex(/^[0-9a-f]{40}$/);
const manifestSchema = z.object({ protocol: z.literal("ordertruth.lab-publication/v1"), hashing: z.literal("sha256 of actual artifact bytes"),
  sourceCommit: sourceSchema, runId: z.string().min(1).max(256), verifierManifestSha256: hashSchema, subjectSha256: hashSchema,
  reviewEvidenceSha256: hashSchema, execution: z.literal("LOCAL_CONTAINERS"), publicSourceAvailability: z.literal("NOT_VERIFIED"),
  files: z.array(z.object({ role: z.enum(["report1", "report2", "summary", "cleanup", "verifier", "reference", "proof"]),
    file: z.string().min(1).max(96), sha256: hashSchema }).strict()).length(7),
}).strict();
export type PublicationManifest = z.infer<typeof manifestSchema>;
const originalPath = "packages/lab-merchant/src/v-a/original.ts", referencePath = "packages/lab-merchant/src/v-a/reference-fix.ts";
const moduleSchema = (path: string) => z.object({ path: z.literal(path), content: z.string().max(131_072), sha256: hashSchema }).strict();
const referenceSchema = z.object({ protocol: z.literal("reference-source-comparison/v1"), sourceCommit: sourceSchema,
  original: moduleSchema(originalPath), reference: moduleSchema(referencePath) }).strict();
const verifierSchema = z.object({ protocol: z.literal("ordertruth-v3-gate-a-verifier"), fileHashing: z.literal("sha256 of UTF-8 text with CRLF normalized to LF"),
  files: z.array(z.object({ path: z.string().max(256), sha256: hashSchema }).strict()).min(1).max(512) }).strict();
function parseJson(bytes: Buffer, label: string): unknown {
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`Lab files: invalid JSON in ${label}`); }
}
function checked<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`Lab files: malformed ${label}`);
  return parsed.data;
}
const fact = (ok: boolean, why: string) => { if (!ok) throw new Error(`Lab files: ${why}`); };
const normalizedSha = (text: string) => byteSha(text.replace(/\r\n/g, "\n"));

function validateArtifacts(raw: RawArtifacts, pins: InputPins) {
  for (const role of ["report1", "report2", "summary", "cleanup"] as const)
    fact(byteSha(raw[role]) === pins.raw[role], `reviewed historical ${role} hash mismatch`);
  const b = validateRunBundle({ reports: [parseJson(raw.report1, "report1"), parseJson(raw.report2, "report2")],
    summary: parseJson(raw.summary, "summary"), cleanup: parseJson(raw.cleanup, "cleanup") });
  fact(b.summary.runId === pins.runId && b.summary.environment.sourceCommit === pins.sourceCommit, "unreviewed run/source identity");
  fact(b.summary.manifestSha256 === pins.verifierManifestSha256 && b.summary.environment.subjectSha256 === pins.subjectSha256, "unreviewed verifier/guard identity");
  const v = checked(verifierSchema, parseJson(raw.verifier, "source verifier manifest"), "source verifier manifest");
  fact(byteSha(JSON.stringify(v)) === pins.verifierManifestSha256, "source verifier manifest hash mismatch");
  fact(new Set(v.files.map(f => f.path)).size === v.files.length, "duplicate source manifest file");
  const ref = checked(referenceSchema, parseJson(raw.reference, "source comparison"), "source comparison");
  fact(ref.sourceCommit === pins.sourceCommit, "source comparison commit mismatch");
  for (const entry of [ref.original, ref.reference])
    fact(normalizedSha(entry.content) === entry.sha256 && v.files.find(f => f.path === entry.path)?.sha256 === entry.sha256, "source comparison not bound to verified modules");
  return { b, proof: deriveProof(b, byteSha(raw.reference), ref.reference.sha256, pins.reviewEvidenceSha256) };
}

export function createPublication(raw: RawArtifacts, pins: InputPins = GATE_A_INPUTS) {
  const { proof } = validateArtifacts(raw, pins);
  const artifacts = { ...raw, proof: jsonBytes(proof) };
  const manifest: PublicationManifest = { protocol: "ordertruth.lab-publication/v1", hashing: "sha256 of actual artifact bytes",
    sourceCommit: pins.sourceCommit, runId: pins.runId, verifierManifestSha256: pins.verifierManifestSha256, subjectSha256: pins.subjectSha256,
    reviewEvidenceSha256: pins.reviewEvidenceSha256, execution: "LOCAL_CONTAINERS", publicSourceAvailability: "NOT_VERIFIED",
    files: (Object.keys(FILES) as ArtifactRole[]).map(role => ({ role, file: FILES[role], sha256: byteSha(artifacts[role]) })) };
  return { artifacts, manifest, proof };
}

const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
export function readBounded(root: string, file: string): Buffer {
  fact(file.endsWith(".json") && file.split("/").every(part => /^[\w][\w.-]*$/.test(part) && part !== "." && part !== ".."), "unsafe artifact path");
  const base = resolve(root), path = resolve(base, file);
  fact(lstatSync(base).isDirectory() && samePath(realpathSync(base), base), "unsafe publication directory");
  const info = lstatSync(path);
  fact(info.isFile() && !info.isSymbolicLink() && samePath(realpathSync(path), path), "artifact symlink or non-file");
  fact(info.size > 0 && info.size <= 2 * 1024 * 1024, "artifact size out of bounds");
  return readFileSync(path);
}

export function loadLab(root: string, pins: InputPins = GATE_A_INPUTS) {
  const manifestBytes = readBounded(root, "manifest.json");
  const manifest = checked(manifestSchema, parseJson(manifestBytes, "manifest"), "manifest");
  fact(manifest.sourceCommit === pins.sourceCommit && manifest.runId === pins.runId && manifest.verifierManifestSha256 === pins.verifierManifestSha256
    && manifest.subjectSha256 === pins.subjectSha256 && manifest.reviewEvidenceSha256 === pins.reviewEvidenceSha256, "publication identity not reviewed");
  fact(new Set(manifest.files.map(f => f.role)).size === 7, "duplicate artifact role");
  // Validate all paths/roles before opening any of the listed files.
  for (const entry of manifest.files) fact(entry.file === FILES[entry.role], "unsafe or incorrect artifact path");
  const artifacts = {} as Record<ArtifactRole, Buffer>;
  for (const entry of manifest.files) {
    const bytes = readBounded(root, entry.file);
    fact(byteSha(bytes) === entry.sha256, `artifact hash mismatch: ${entry.role}`);
    artifacts[entry.role] = bytes;
  }
  const { proof } = validateArtifacts(artifacts, pins);
  fact(isDeepStrictEqual(parseJson(artifacts.proof, "proof"), proof), "fabricated protection proof");
  return { manifest, manifestBytes, manifestSha256: byteSha(manifestBytes), proof, artifacts };
}

export function writePublication(root: string, publication: ReturnType<typeof createPublication>): void {
  const base = resolve(root);
  let ancestor = base;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  fact(samePath(realpathSync(ancestor), ancestor), "output directory has a symlink ancestor");
  mkdirSync(base, { recursive: true });
  fact(lstatSync(base).isDirectory() && samePath(realpathSync(base), base), "unsafe output directory");
  const files = { ...Object.fromEntries((Object.keys(FILES) as ArtifactRole[]).map(r => [FILES[r], publication.artifacts[r]])), "manifest.json": jsonBytes(publication.manifest) };
  // Preflight the whole set: no partial overwrite when one existing artifact differs.
  for (const [file, bytes] of Object.entries(files)) if (existsSync(resolve(base, file))) fact(byteSha(readBounded(base, file)) === byteSha(bytes), `refusing to replace existing ${file}`);
  for (const [file, bytes] of Object.entries(files)) if (!existsSync(resolve(base, file))) writeFileSync(resolve(base, file), bytes, { flag: "wx" });
}
