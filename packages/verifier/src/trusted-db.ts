/** Trusted verifier connections: a stalled query destroys its connection instead of merely abandoning a promise. */
import pg from "pg";

export const TRUSTED_QUERY_MS = 10_000;
const finiteMs = (ms: number) => { if (!Number.isInteger(ms) || ms < 1) throw new Error("database deadline must be a positive integer"); };

/** pg supports both promises and callbacks; Pool.query uses the latter internally. Streaming is deliberately unsupported here. */
export function boundQueries<T extends pg.Client>(client: T, ms = TRUSTED_QUERY_MS): T {
  finiteMs(ms);
  client.on("error", () => {}); // a leased observer client must not crash the controller on its forced socket close
  const query = client.query.bind(client) as (...args: unknown[]) => unknown;
  client.query = ((...args: unknown[]) => {
    if (typeof (args[0] as { submit?: unknown } | null)?.submit === "function") throw new Error("trusted database queries cannot stream");
    const callback = typeof args.at(-1) === "function" ? args.pop() as (error: Error | null, result?: unknown) => void : undefined;
    const execute = (finish: (error: Error | null, result?: unknown) => void) => {
      let settled = false;
      const done = (error: Error | null, result?: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timer); finish(error, result);
      };
      const timer = setTimeout(() => {
        const error = new Error(`trusted database query exceeded ${ms} ms`);
        client.connection.stream.destroy(error);
        done(error);
      }, ms);
      try { query(...args, done); } catch (error) { done(error instanceof Error ? error : new Error(String(error))); }
    };
    if (callback) { execute(callback); return; }
    return new Promise((resolve, reject) => execute((error, result) => error ? reject(error) : resolve(result)));
  }) as pg.Client["query"];
  return client;
}

export function trustedClient(config: pg.ClientConfig, ms = TRUSTED_QUERY_MS): pg.Client {
  const client = boundQueries(new pg.Client({ ...config, connectionTimeoutMillis: ms, pipeline: false }), ms);
  return client;
}

const poolClients = new WeakMap<pg.Pool, Set<pg.Client>>();
export function trustedPool(config: pg.PoolConfig, ms = TRUSTED_QUERY_MS): pg.Pool {
  finiteMs(ms);
  const clients = new Set<pg.Client>();
  class TrustedPgClient extends pg.Client {
    constructor(options?: pg.ClientConfig) {
      super(options); boundQueries(this, ms);
      clients.add(this); // includes connecting clients, before pg emits its pool 'connect' event
    }
  }
  const pool = new pg.Pool({ ...config, Client: TrustedPgClient, connectionTimeoutMillis: ms, pipeline: false });
  poolClients.set(pool, clients);
  pool.on("remove", client => clients.delete(client));
  pool.on("error", () => {});
  return pool;
}

export async function closeClient(client: pg.Client, ms = 2000): Promise<void> {
  finiteMs(ms);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([client.end(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { client.connection.stream.destroy(); reject(new Error("trusted database client shutdown timed out")); }, ms);
    })]);
  } finally { clearTimeout(timer); }
}

export async function closePool(pool: pg.Pool, ms = 2000): Promise<void> {
  finiteMs(ms);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([pool.end(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        for (const client of poolClients.get(pool) ?? []) {
          client.connection.stream.destroy();
          try { if ("release" in client && typeof client.release === "function") client.release(true); }
          catch { /* an idle or already released client is removed on stream close */ }
        }
        reject(new Error("trusted database pool shutdown timed out; remaining connections destroyed"));
      }, ms);
    })]);
  } finally { clearTimeout(timer); }
}
