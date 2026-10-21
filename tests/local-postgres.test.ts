import { mkdtempSync, mkdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localPostgres } from "../scripts/local-postgres.ts";

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ordertruth-local-pg-test-"));
  roots.push(root);
  mkdirSync(join(root, ".work"));
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("local PostgreSQL safety boundaries", () => {
  it("refuses an unknown command before touching a database", () => {
    expect(() => localPostgres("reset", fixture())).toThrow(/start, check or stop/);
  });
  it("refuses an unowned existing directory without overwriting its contents", () => {
    const root = fixture();
    const target = join(root, ".work", "postgres");
    mkdirSync(target);
    writeFileSync(join(target, "existing-data"), "DO NOT TOUCH");
    expect(() => localPostgres("start", root)).toThrow(/unmanaged/);
    expect(readFileSync(join(target, "existing-data"), "utf8")).toBe("DO NOT TOUCH");
  });
  it.each(["start", "check", "stop"])("refuses %s through a directory junction", command => {
    const root = fixture();
    const outside = fixture();
    symlinkSync(outside, join(root, ".work", "postgres"), "junction");
    expect(() => localPostgres(command, root)).toThrow(/symlink|junction/);
  });
  it("refuses a redirected .work parent before creating a cluster", () => {
    const root = fixture();
    rmdirSync(join(root, ".work"));
    const outside = fixture();
    symlinkSync(outside, join(root, ".work"), "junction");
    expect(() => localPostgres("start", root)).toThrow(/symlink|junction/);
  });
});
