import { Pool, types, type PoolClient } from "pg";

export function createPostgresPool(url: string): Pool {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Invalid PostgreSQL connection configuration"); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname || !parsed.username || !parsed.password || parsed.pathname.length < 2) {
    throw new Error("PostgreSQL connection requires an explicit host, database and credentials");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  // Build explicit options so URL sslmode cannot silently disable certificate verification.
  const pool = new Pool({
    host: parsed.hostname.replace(/^\[|\]$/g, ""), port: Number(parsed.port || "5432"),
    user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.slice(1)),
    ssl: loopback ? false : { rejectUnauthorized: true },
    max: 4, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
    types: { getTypeParser: (oid, format) => {
      if (oid === 20 && format !== "binary") return (text: string) => {
        const value = Number(text);
        if (!Number.isSafeInteger(value)) throw new Error("Database integer exceeds JavaScript's exact range");
        return value;
      };
      return types.getTypeParser(oid, format);
    } },
    options: "-c statement_timeout=15000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=15000",
  });
  pool.on("error", () => { console.error("PostgreSQL idle connection closed; the pool will replace it"); });
  return pool;
}
export async function withTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  let committing = false;
  // Connection termination is also reported by the pending query. Handle the
  // event so a checked-out client's failure cannot crash the whole service.
  const disconnected = () => { discard = true; };
  client.on("error", disconnected);
  try {
    await client.query("BEGIN");
    const value = await action(client);
    committing = true;
    await client.query("COMMIT");
    return value;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    // A lost commit response cannot establish rollback. Callers must read the
    // durable operation identity, never automatically repeat the correction.
    if (committing) {
      discard = true;
      throw new Error("PostgreSQL commit outcome unknown; read the durable operation before retrying");
    }
    throw error;
  } finally {
    client.release(discard);
    client.off("error", disconnected);
  }
}
