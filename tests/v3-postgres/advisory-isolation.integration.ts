import pg from "pg";
import {expect,it} from "vitest";
import {createDisposableDatabase} from "./harness.ts";
import {countAdvisoryWaiters} from "./advisory-waiters.ts";
import {until} from "./setup.ts";
it("never mistakes a different database's advisory waiters for its local schedule",async()=>{
  const a=await createDisposableDatabase(),b=await createDisposableDatabase();
  const blocked=new pg.Client(b.config);await blocked.connect();let pending:Promise<unknown>|undefined;
  try{
    await b.client.query("SELECT pg_advisory_lock(4101::bigint)");
    const pid=(await blocked.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    pending=blocked.query("SELECT pg_advisory_lock(4101::bigint)");
    await until(async()=>Number((await a.client.query("SELECT count(*) AS n FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",[pid])).rows[0].n)===1);
    expect(await countAdvisoryWaiters(a.client,4101)).toBe(0);
    expect(await countAdvisoryWaiters(b.client,4101)).toBe(1);
  }finally{
    await b.client.query("SELECT pg_advisory_unlock_all()");await pending;await blocked.end();await a.drop();await b.drop();
  }
});
