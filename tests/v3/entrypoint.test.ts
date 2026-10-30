import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SPECIFIER = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;
/** Every module specifier reachable from `entry` through relative imports, read statically (nothing is executed). */
function walk(entry: string): { files: Set<string>; specifiers: Set<string> } {
  const files = new Set<string>(), specifiers = new Set<string>(), queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
      const spec = m[1] ?? m[2] ?? m[3]!;
      specifiers.add(spec);
      if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec));
    }
  }
  return { files, specifiers };
}
const here = dirname(fileURLToPath(import.meta.url));
const testing = (s: string) => /(^|\/)testing(\/|$)/.test(s);

describe("production entry point (spec §6.1; plan Task 6)", () => {
  it("never reaches the testing module", () => {
    const { files, specifiers } = walk(resolve(here, "../../packages/guard/src/index.ts"));
    expect([...files].some(f => f.endsWith("guard.ts"))).toBe(true);       // the walk really followed the guard's imports
    expect([...files].some(f => f.endsWith("commit.ts"))).toBe(true);
    expect([...specifiers].filter(testing)).toEqual([]);
    expect([...files].filter(f => testing(f.replaceAll("\\", "/")))).toEqual([]);
  });

  it("the walker does detect a testing import (control)", () => {
    const { specifiers } = walk(resolve(here, "../v3-postgres/setup.ts"));
    expect([...specifiers].filter(testing).length).toBeGreaterThan(0);
  });
});
