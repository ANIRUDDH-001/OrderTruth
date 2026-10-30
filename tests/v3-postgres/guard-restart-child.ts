// Child process for the guard restart matrix (plan Task 6): makes one guard call (or one issuance) through the fault proxy and
// exits from the commit-failure path BEFORE resolving, so the parent can recover only from durable records.
import pg from "pg";
import type { CaptureCapability } from "../../packages/guard/src/capability.ts";
import { createGuard } from "../../packages/guard/src/guard.ts";
import { createTestCaptureAuthority } from "../../packages/guard/src/testing/index.ts";
import { fixture, V_A_CONFIG } from "./setup.ts";

type Call = { kind: "issue"; observationId: string }
  | { kind: "order"; capture: CaptureCapability; intentId: string; pathId: string; siteId: string; nowMs: number; acceptTestAuthority: boolean; orderLocatorSql?: string };
const a = JSON.parse(process.argv[2]!) as { op: pg.PoolConfig; auxConnectionString: string; capabilityKey: string; testKey: string; call: Call };
process.env.ORDERTRUTH_GUARD_MODE = "verifier";
const exit = ({ callId }: { callId: string }) => { console.log(JSON.stringify({ exited: "commit-failure", callId })); process.exit(0); };
const testKey = Buffer.from(a.testKey, "hex");
const pool = new pg.Pool({ ...a.op, max: 2, connectionTimeoutMillis: 5000 });
pool.on("error", () => {});
try {
  if (a.call.kind === "issue") {
    const aux = new pg.Pool({ connectionString: a.auxConnectionString, max: 2, connectionTimeoutMillis: 5000 });
    await createTestCaptureAuthority({ pools: { op: pool, aux }, merchantId: "SYN-M-A", fixture, key: testKey, hooks: { afterCommitFailure: exit } })
      .issue(a.call.observationId);
  } else {
    const call = a.call;
    const guard = await createGuard({ pool, auxConnectionString: a.auxConnectionString, auxMax: 2, merchantId: "SYN-M-A", buildId: "restart-child",
      paypalEnv: "sandbox", capabilityKey: Buffer.from(a.capabilityKey, "hex"), freshnessMs: 60_000, now: () => call.nowMs,
      config: call.orderLocatorSql ? { ...V_A_CONFIG, orderLocator: { ...V_A_CONFIG.orderLocator, sql: call.orderLocatorSql } } : V_A_CONFIG,
      timeouts: { lockMs: 2000, statementMs: 5000, connectionMs: 5000 },
      ...(call.acceptTestAuthority ? { acceptTestAuthority: true, testAuthorityKey: testKey } : {}), testHooks: { afterCommitFailure: exit } });
    await guard.createOrderOnce({ capture: call.capture, intentId: call.intentId, pathId: call.pathId, siteId: call.siteId });
  }
  console.log(JSON.stringify({ unexpected: "returned" }));
} catch (error) {
  console.log(JSON.stringify({ unexpected: "threw", error: String(error) }));
}
process.exit(1);
