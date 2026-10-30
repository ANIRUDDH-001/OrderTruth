/**
 * Verifier barriers (plan Task 9). The controller holds a PostgreSQL advisory lock that candidate code blocks on at a fixed
 * point, counts the blocked waiters in pg_locks, and releases it: a forced interleaving, not a timing guess.
 */
import type pg from "pg";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function poll(what: string, timeoutMs: number, check: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`barrier: timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(20);
  }
}

/** Holds advisory lock `key` on one observer connection until release(). Keys are small integers, so pg_locks shows them as objid. */
export async function holdBarrier(observerPool: pg.Pool, key: number): Promise<{ waitForWaiters(n: number, timeoutMs: number): Promise<void>; release(): Promise<void> }> {
  if (!Number.isInteger(key) || key <= 0 || key > 2 ** 31 - 1) throw new Error("holdBarrier: key must be a positive 32-bit integer");
  const holder = await observerPool.connect();
  await holder.query("SELECT pg_advisory_lock($1)", [key]);
  let released = false;
  return {
    waitForWaiters: (n, timeoutMs) => poll(`${n} waiter(s) on barrier ${key}`, timeoutMs, async () => Number((await observerPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = $1 AND objsubid = 1 AND NOT granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`, [key])).rows[0]?.n) >= n),
    async release() {
      if (released) return;
      released = true;
      try { await holder.query("SELECT pg_advisory_unlock($1)", [key]); } finally { holder.release(); }
    },
  };
}

/** Waits until a backend whose application_name matches `appNameLike` is blocked on a heavyweight lock (pg_stat_activity). */
export function waitForLockWait(observerPool: pg.Pool, appNameLike: string, timeoutMs: number): Promise<void> {
  return poll(`a lock wait by ${appNameLike}`, timeoutMs, async () => Number((await observerPool.query<{ n: string }>(
    `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name LIKE $1 AND wait_event_type = 'Lock'`,
    [appNameLike])).rows[0]?.n) > 0);
}
