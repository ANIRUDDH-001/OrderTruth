import { Duplex } from "node:stream";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { closeClient, closePool, trustedClient, trustedPool } from "../../packages/verifier/src/trusted-db.ts";

/** A PostgreSQL handshake and query responses in memory; no socket, credentials or database. */
class ServerStream extends Duplex {
  started = false;
  answerQueries = false;
  answerTerminate = true;
  override _read() {}
  connect() { queueMicrotask(() => this.emit("connect")); }
  setNoDelay() {}
  setKeepAlive() {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    if (!this.started) {
      this.started = true;
      queueMicrotask(() => this.push(Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73])));
    } else if (chunk[0] === 81 && this.answerQueries) {
      queueMicrotask(() => this.push(Buffer.concat([Buffer.from([67, 0, 0, 0, 13]), Buffer.from("SELECT 1\0"), Buffer.from([90, 0, 0, 0, 5, 73])])));
    } else if (chunk[0] === 88 && this.answerTerminate) queueMicrotask(() => this.destroy());
    done();
  }
}
const config = (stream: ServerStream) => ({ user: "review", database: "review", ssl: false as const, stream: () => stream });

describe("trusted verifier database deadlines", () => {
  it("destroys a frozen query's connection, rather than merely timing out its promise", async () => {
    const stream = new ServerStream();
    const c = trustedClient(config(stream), 30);
    await c.connect();
    await expect(c.query("SELECT 1")).rejects.toThrow(/exceeded 30 ms/);
    expect(stream.destroyed).toBe(true);
    await closeClient(c);
  });

  it("preserves successful promise and callback query results", async () => {
    const stream = new ServerStream(); stream.answerQueries = true;
    const c = trustedClient(config(stream), 1000);
    await c.connect();
    try {
      expect((await c.query("SELECT 1")).command).toBe("SELECT");
      await new Promise<void>((resolve, reject) => c.query("SELECT 1", (error, result) => {
        if (error) reject(error); else { expect(result.command).toBe("SELECT"); resolve(); }
      }));
    } finally { await closeClient(c); }
  });

  it("pool queries evict a timed-out connection and a fresh connection can serve the next query", async () => {
    const streams: ServerStream[] = [];
    const pool = trustedPool({ user: "review", database: "review", ssl: false, max: 1, stream: () => {
      const stream = new ServerStream(); stream.answerQueries = streams.length > 0; streams.push(stream); return stream;
    } }, 40);
    try {
      await expect(pool.query("SELECT 1")).rejects.toThrow(/exceeded 40 ms/);
      expect(streams[0]!.destroyed).toBe(true);
      expect((await pool.query("SELECT 1")).command).toBe("SELECT");
      expect(streams.length).toBe(2);
    } finally { await closePool(pool); }
  });

  it("bounded pool shutdown destroys and releases a checked-out connection", async () => {
    const stream = new ServerStream();
    const pool = trustedPool({ ...config(stream), max: 1 }, 1000);
    await pool.connect(); // deliberate leaked lease: shutdown must not wait forever
    await expect(closePool(pool, 20)).rejects.toThrow(/shutdown timed out/);
    expect(stream.destroyed).toBe(true);
    expect(pool.totalCount).toBe(0);
  });

  it("bounded idle-client shutdown destroys a peer that never finishes closing", async () => {
    const stream = new ServerStream(); stream.answerTerminate = false;
    const c = trustedClient(config(stream), 1000);
    await c.connect();
    await expect(closeClient(c, 20)).rejects.toThrow(/shutdown timed out/);
    expect(stream.destroyed).toBe(true);
  });
});
