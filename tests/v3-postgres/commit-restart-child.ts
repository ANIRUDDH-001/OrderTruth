// Child process for "resolution after process restart": runs one runGuardTx through the fault proxy and exits from the
// commit-failure path BEFORE resolving, so only durable records can tell the parent what happened.
import pg from "pg";
import { runGuardTx } from "../../packages/guard/src/commit.ts";

const args = JSON.parse(process.argv[2]!) as { op: pg.PoolConfig; aux: pg.PoolConfig };
process.env.ORDERTRUTH_GUARD_MODE = "verifier";
const pools = { op: new pg.Pool({ ...args.op, max: 2, connectionTimeoutMillis: 5000 }), aux: new pg.Pool({ ...args.aux, max: 2, connectionTimeoutMillis: 5000 }) };
try {
  const r = await runGuardTx(pools, "OPERATION", { merchantId: "SYN-M-A", test: "restart" }, async (tx, { callId }) => {
    await tx.query("INSERT INTO public.effects (call_id) VALUES ($1)", [callId]);
    return { value: "done", outcomeRecord: { outcome: "TEST_EFFECT", callId } };
  }, { hooks: { afterCommitFailure: ({ callId }) => { console.log(JSON.stringify({ exited: "commit-failure", callId })); process.exit(0); } } });
  console.log(JSON.stringify({ unexpected: "returned", r }));
} catch (error) {
  console.log(JSON.stringify({ unexpected: "threw", error: String(error) }));
}
process.exit(1);
