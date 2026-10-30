import { describe, expect, it } from "vitest";
import { closePool, trustedPool } from "../../packages/verifier/src/trusted-db.ts";
import { adminConfig } from "./harness.ts";

describe("trusted controller deadlines on PostgreSQL 18", () => {
  it("destroys an unresponsive query's lease and replaces it for a successful next query", async () => {
    const pool = trustedPool({ ...adminConfig(), max: 1 }, 300);
    try {
      await expect(pool.query("SELECT pg_sleep(2)")).rejects.toThrow(/trusted database query exceeded 300 ms/);
      const result = await pool.query<{ answer: number }>("SELECT 42 AS answer");
      expect(result.rows[0]?.answer).toBe(42);
      expect(pool.waitingCount).toBe(0);
      expect(pool.totalCount).toBe(1);
    } finally { await closePool(pool); }
    expect(pool.totalCount).toBe(0);
  });

  it("a leaked observer lease cannot block bounded shutdown", async () => {
    const pool = trustedPool({ ...adminConfig(), max: 1 }, 1000);
    await pool.connect();
    await expect(closePool(pool, 30)).rejects.toThrow(/shutdown timed out/);
    expect(pool.totalCount).toBe(0);
    expect(pool.waitingCount).toBe(0);
  });
});
