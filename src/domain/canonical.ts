import { createHash } from "node:crypto";

/** Sorted object keys; array order remains part of the evidence identity. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}
export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
