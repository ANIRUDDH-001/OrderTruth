import { describe, expect, it } from "vitest";
import { cleanup, type CleanupResult, type Resources } from "../../packages/verifier/src/cleanup.ts";

const empty = (): Resources => ({ containers: [], volumes: [], networks: [] });
describe("verifier finalization", () => {
  it("records success only after teardown and independent empty resource inventory", async () => {
    const events: string[] = [];
    let recorded: CleanupResult | undefined;
    const out = await cleanup({ evidence: async () => { events.push("evidence"); }, observers: async () => { events.push("observers"); },
      down: async () => { events.push("down"); return { exit: 0 }; }, inventory: async () => { events.push("inventory"); return empty(); },
      record: r => { events.push("record"); recorded = r; } });
    expect(out.ok).toBe(true);
    expect(recorded).toEqual(out);
    expect(events).toEqual(["evidence", "observers", "down", "inventory", "record"]);
  });

  it.each(["evidence", "observers", "down", "inventory"] as const)("continues every later cleanup step when %s throws", async phase => {
    const events: string[] = [];
    const hit = (name: string) => { events.push(name); if (phase === name) throw new Error("injected failure"); };
    const out = await cleanup({ evidence: async () => { hit("evidence"); }, observers: async () => { hit("observers"); },
      down: async () => { hit("down"); return { exit: 0 }; }, inventory: async () => { hit("inventory"); return empty(); }, record: () => { hit("record"); } });
    expect(out.ok).toBe(false);
    expect(out.errors.join("\n")).toContain(`${phase}: injected failure`);
    expect(events).toEqual(["evidence", "observers", "down", "inventory", "record"]);
  });

  it("a stuck observer cannot prevent teardown, inventory or the final failure record", async () => {
    let down = false;
    const out = await cleanup({ evidence: async () => {}, observers: () => new Promise(() => {}),
      down: async () => { down = true; return { exit: 0 }; }, inventory: async () => empty(), record: () => {} }, { observers: 10 });
    expect(down).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.errors.join("\n")).toContain("observers deadline exceeded");
  });

  it("nonzero teardown fails even if inventory is empty", async () => {
    const out = await cleanup({ evidence: async () => {}, observers: async () => {}, down: async () => ({ exit: 7 }), inventory: async () => empty(), record: () => {} });
    expect(out.ok).toBe(false);
    expect(out.errors).toContain("down: exit 7");
  });

  it.each(["containers", "volumes", "networks"] as const)("leftover %s fail even after a successful teardown command", async kind => {
    const out = await cleanup({ evidence: async () => {}, observers: async () => {}, down: async () => ({ exit: 0 }),
      inventory: async () => ({ ...empty(), [kind]: ["remaining-resource"] }), record: () => {} });
    expect(out.ok).toBe(false);
    expect(out.errors.join("\n")).toContain(`remaining ${kind}: remaining-resource`);
  });

  it("record-write failure prevents a successful exit decision", async () => {
    const out = await cleanup({ evidence: async () => {}, observers: async () => {}, down: async () => ({ exit: 0 }), inventory: async () => empty(),
      record: () => { throw new Error("disk full"); } });
    expect(out.ok).toBe(false);
    expect(out.errors).toContain("record: disk full");
  });
});
