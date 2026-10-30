import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { startFaultProxy, type FaultProxy } from "../../packages/verifier/src/proxy.ts";
import { adminConfig } from "./harness.ts";

// Proxy hardening before Checkpoint 3 relies on it (review NB7): transaction-scoped state must not outlive its transaction,
// and the control API must be reachable only where the controller is. Runs against the real PostgreSQL 18.
let proxy: FaultProxy | undefined;
const clients: pg.Client[] = [];
afterEach(async () => { for (const c of clients.splice(0)) await c.end().catch(() => {}); await proxy?.close(); proxy = undefined; });
const target = () => { const c = adminConfig(); return { host: String(c.host), port: Number(c.port) }; };
async function through(p: FaultProxy) {
  const c = new pg.Client({ ...adminConfig(), host: "127.0.0.1", port: p.port });
  c.on("error", () => {});
  await c.connect(); clients.push(c);
  return c;
}
const tagged = async (c: pg.Client, boundary: string) => { await c.query("BEGIN"); await c.query(`SET LOCAL application_name = 'ot:${boundary}'`); await c.query("SELECT 1"); return c.query("COMMIT"); };

describe("fault proxy transaction-scoped state (review NB7)", () => {
  it("a boundary tag does not outlive its transaction", async () => {
    proxy = await startFaultProxy({ listenPort: 0, controlPort: 0, target: target() });
    const c = await through(proxy);
    await tagged(c, "OPERATION");                        // tags the connection, then commits and goes idle
    proxy.arm({ boundary: "OPERATION", mode: "drop-commit-ack" });
    await c.query("BEGIN"); await c.query("SELECT 1");
    await expect(c.query("COMMIT")).resolves.toBeDefined();   // untagged: the stale OPERATION tag must not target it
    expect(proxy.events().some(e => e.action === "commit-ack-dropped")).toBe(false);
    await expect(tagged(c, "OPERATION")).rejects.toThrow();   // the next tagged transaction is the one targeted
    expect(proxy.events().some(e => e.boundary === "OPERATION" && e.action === "commit-ack-dropped")).toBe(true);
  });

  it("a rule consumed by a COMMIT that rolled back does not drop a later acknowledgement", async () => {
    proxy = await startFaultProxy({ listenPort: 0, controlPort: 0, target: target() });
    const c = await through(proxy);
    proxy.arm({ boundary: "OPERATION", mode: "drop-commit-ack" });
    await c.query("BEGIN"); await c.query("SET LOCAL application_name = 'ot:OPERATION'");
    await expect(c.query("SELECT 1/0")).rejects.toThrow();
    expect((await c.query("COMMIT")).command).toBe("ROLLBACK");    // an aborted transaction's COMMIT is answered with ROLLBACK
    await expect(c.query("BEGIN").then(() => c.query("COMMIT"))).resolves.toBeDefined();
    expect(proxy.events().some(e => e.action === "commit-ack-dropped")).toBe(false);
    expect(proxy.events().some(e => e.action === "armed-commit-rolled-back")).toBe(true);
  });
});

describe("fault proxy control API (review NB7)", () => {
  it("listens only on its control host, separately from the data port", async () => {
    proxy = await startFaultProxy({ listenPort: 0, controlPort: 0, target: target(), host: "127.0.0.1", controlHost: "127.0.0.2" });
    await expect(fetch(`http://127.0.0.1:${proxy.controlPort}/events`)).rejects.toThrow();
    expect((await fetch(`http://127.0.0.2:${proxy.controlPort}/events`)).status).toBe(200);
  });

  it("refuses requests without the per-run bearer token", async () => {
    proxy = await startFaultProxy({ listenPort: 0, controlPort: 0, target: target(), controlToken: "t".repeat(32) });
    const url = `http://127.0.0.1:${proxy.controlPort}`;
    expect((await fetch(`${url}/events`)).status).toBe(401);
    expect((await fetch(`${url}/arm`, { method: "POST", body: JSON.stringify({ boundary: "OPERATION", mode: "hold-commit" }),
      headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect(proxy.events().some(e => e.action.startsWith("armed"))).toBe(false);
    expect((await fetch(`${url}/events`, { headers: { authorization: `Bearer ${"t".repeat(32)}` } })).status).toBe(200);
  });
});
