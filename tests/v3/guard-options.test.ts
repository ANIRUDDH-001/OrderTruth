import { describe, expect, it, vi } from "vitest";

// pg.Pool is replaced by a stub that records its options and throws, so these tests never open a socket.
const constructed = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("pg", () => ({ default: { Pool: class { constructor(o: Record<string, unknown>) { constructed.push(o); throw new Error("stub: pool constructed"); } } } }));

const { createGuard } = await import("../../packages/guard/src/guard.ts");
const { V_A_CONFIG } = await import("../v3-postgres/setup.ts");
type Options = Parameters<typeof createGuard>[0];

const fakePool = { options: { connectionTimeoutMillis: 1000 } } as unknown as Options["pool"];
const base = (timeouts: unknown): Options => ({ pool: fakePool, auxConnectionString: "postgres://unused@127.0.0.1:1/unused", auxMax: 2, merchantId: "SYN-M-A",
  buildId: "options-test", paypalEnv: "sandbox", capabilityKey: Buffer.alloc(32, 9), config: V_A_CONFIG, freshnessMs: 60_000,
  timeouts: timeouts as Options["timeouts"] });
const valid = { lockMs: 2000, statementMs: 5000, connectionMs: 5000 };

describe("createGuard timeout validation (review R1; spec §5.4b bounded waits)", () => {
  it.each([
    ["connectionMs omitted", { lockMs: 2000, statementMs: 5000 }, /timeouts\.connectionMs/],
    ["lockMs omitted", { statementMs: 5000, connectionMs: 5000 }, /timeouts\.lockMs/],
    ["statementMs omitted", { lockMs: 2000, connectionMs: 5000 }, /timeouts\.statementMs/],
    ["connectionMs undefined", { ...valid, connectionMs: undefined }, /timeouts\.connectionMs/],
    ["connectionMs as a string", { ...valid, connectionMs: "5000" }, /timeouts\.connectionMs/],
    ["connectionMs zero", { ...valid, connectionMs: 0 }, /timeouts\.connectionMs/],
    ["lockMs negative", { ...valid, lockMs: -1 }, /timeouts\.lockMs/],
    ["statementMs NaN", { ...valid, statementMs: Number.NaN }, /timeouts\.statementMs/],
    ["connectionMs Infinity", { ...valid, connectionMs: Infinity }, /timeouts\.connectionMs/],
    ["lockMs fractional", { ...valid, lockMs: 1.5 }, /timeouts\.lockMs/],
    ["timeouts missing", undefined, /timeouts/],
    ["timeouts not an object", 5000, /timeouts/],
  ])("refuses %s before constructing any pool", async (_name, timeouts, message) => {
    constructed.length = 0;
    await expect(createGuard(base(timeouts))).rejects.toThrow(message);
    expect(constructed).toHaveLength(0);
  });

  it("passes valid timeouts on to the auxiliary pool", async () => {
    constructed.length = 0;
    await expect(createGuard(base({ ...valid }))).rejects.toThrow(/stub: pool constructed/);
    expect(constructed).toHaveLength(1);
    expect(constructed[0]).toMatchObject({ connectionTimeoutMillis: 5000, statement_timeout: 5000, lock_timeout: 2000 });
  });
});
