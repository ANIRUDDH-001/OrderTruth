/** Test child: only local disposable PostgreSQL + supplied synthetic readback, no network provider. */
import pg from "pg";
import { createReferenceRuntime } from "../../src/merchant/lab-reference-runtime.ts";
const input = JSON.parse(process.argv[2]!);
if (!["127.0.0.1", "localhost"].includes(input.db.host) || !/^otg_[0-9a-f]{20}$/.test(input.db.database)) throw new Error("disposable child only");
const pool = new pg.Pool({ ...input.db, connectionTimeoutMillis: 5000 });
const aux = new pg.Pool({ ...input.db, connectionTimeoutMillis: 5000 });
const url = `postgres://${encodeURIComponent(input.db.user)}:${encodeURIComponent(input.db.password)}@${input.db.host}:${input.db.port}/${input.db.database}`;
const runtime = await createReferenceRuntime({ pool,aux,auxConnectionString:url,config:input.config,
  capabilityKey:Buffer.alloc(32,11),testKey:Buffer.alloc(32,12),
  provider:{apiBase:"https://api-m.sandbox.paypal.com",getOrder:async()=>input.raw},
  inbox:{getEvent:()=>undefined,getDelivery:()=>undefined},
  afterHandler:async()=>{
    await new Promise<void>(resolve => process.stdout.write("REFERENCE_COMMITTED_CRASH_HOOK\n",() => resolve()));
    process.kill(process.pid,"SIGKILL"); await new Promise(()=>{});
  },
});
await runtime.returnFor(input.intentId);
throw new Error("crash hook not reached");
