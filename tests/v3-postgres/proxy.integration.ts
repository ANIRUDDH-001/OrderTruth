import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FrameParser, commandTag, queryText, startFaultProxy, type FaultProxy } from "../../packages/verifier/src/proxy.ts";

// A minimal fake PostgreSQL server: answers startup with AuthenticationOk + ReadyForQuery and every Query with
// CommandComplete(<first word>) + ReadyForQuery, recording every query it actually receives.
const typed = (type: string, payload: Buffer) => { const h = Buffer.alloc(5); h.write(type, 0, "latin1"); h.writeInt32BE(payload.length + 4, 1); return Buffer.concat([h, payload]); };
const cstr = (s: string) => Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]);
const ready = () => typed("Z", Buffer.from("T"));
function fakeServer(): Promise<{ server: Server; port: number; received: string[] }> {
  const received: string[] = [];
  const server = createServer(socket => {
    const parser = new FrameParser("client");
    socket.on("data", chunk => {
      for (const f of parser.push(chunk)) {
        if (f.kind === "startup") { socket.write(Buffer.concat([typed("R", Buffer.from([0, 0, 0, 0])), ready()])); continue; }
        const sql = queryText(f);
        if (sql !== null) { received.push(sql); socket.write(Buffer.concat([typed("C", cstr(sql.trim().split(/\s+/)[0]!.toUpperCase())), ready()])); }
      }
    });
    socket.on("error", () => {});
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, received })));
}

/** A raw protocol client: sends frames, collects CommandComplete tags, notices when its socket closes. */
function rawClient(port: number) {
  const socket: Socket = connect(port, "127.0.0.1"), parser = new FrameParser("server"), tags: string[] = [];
  let closed = false;
  socket.on("data", chunk => { for (const f of parser.push(chunk)) { const t = commandTag(f); if (t) tags.push(t); } });
  socket.on("close", () => { closed = true; });
  socket.on("error", () => {});
  const startupBody = Buffer.concat([Buffer.from([0, 3, 0, 0]), cstr("user"), cstr("x"), Buffer.from([0])]);
  const len = Buffer.alloc(4); len.writeInt32BE(startupBody.length + 4, 0);
  socket.write(Buffer.concat([len, startupBody]));
  return { tags, isClosed: () => closed, send: (sql: string) => socket.write(typed("Q", cstr(sql))), end: () => socket.destroy() };
}
const until = async (check: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise(r => setTimeout(r, 10)); } };
const tx = (boundary: string) => ["BEGIN", `SET LOCAL application_name = 'ot:${boundary}'`, "COMMIT"];

let proxy: FaultProxy | undefined, fake: Awaited<ReturnType<typeof fakeServer>> | undefined;
afterEach(async () => { await proxy?.close(); await new Promise(r => fake?.server.close(() => r(null)) ?? r(null)); proxy = undefined; fake = undefined; });
const setup = async () => { fake = await fakeServer(); proxy = await startFaultProxy({ listenPort: 0, controlPort: 0, target: { host: "127.0.0.1", port: fake.port } }); return { fake, proxy }; };

describe("fault proxy (socket level, fake server)", () => {
  it("applies an armed OPERATION drop-commit-ack only to an OPERATION COMMIT, after the server received it", async () => {
    const { fake, proxy } = await setup();
    proxy.arm({ boundary: "OPERATION", mode: "drop-commit-ack" });
    const issuance = rawClient(proxy.port);
    for (const q of tx("ISSUANCE")) issuance.send(q);
    await until(() => issuance.tags.includes("COMMIT"));            // untouched: ISSUANCE isn't the armed boundary
    const operation = rawClient(proxy.port);
    for (const q of tx("OPERATION")) operation.send(q);
    await until(() => operation.isClosed());
    expect(operation.tags).not.toContain("COMMIT");                 // the acknowledgement never reached the client
    expect(fake.received.filter(q => q === "COMMIT")).toHaveLength(2); // but the server did receive both COMMITs
    const actions = proxy.events().map(e => `${e.boundary}:${e.action}`);
    expect(actions).toEqual(expect.arrayContaining(["OPERATION:armed:drop-commit-ack", "OPERATION:commit-forwarded", "OPERATION:commit-complete", "OPERATION:commit-ack-dropped"]));
    issuance.end();
  });
  it("drop-before-commit closes the connection without the server ever receiving COMMIT", async () => {
    const { fake, proxy } = await setup();
    proxy.arm({ boundary: "OPERATION", mode: "drop-before-commit" });
    const c = rawClient(proxy.port);
    for (const q of tx("OPERATION")) c.send(q);
    await until(() => c.isClosed());
    expect(fake.received).not.toContain("COMMIT");
    expect(proxy.events().some(e => e.action === "commit-dropped-before-server")).toBe(true);
  });
  it("hold-commit withholds COMMIT from the server until release", async () => {
    const { fake, proxy } = await setup();
    proxy.arm({ boundary: "ISSUANCE", mode: "hold-commit" });
    const c = rawClient(proxy.port);
    for (const q of tx("ISSUANCE")) c.send(q);
    await until(() => proxy.events().some(e => e.action === "commit-held"));
    await new Promise(r => setTimeout(r, 150));
    expect(fake.received).not.toContain("COMMIT");
    proxy.release();
    await until(() => c.tags.includes("COMMIT"));
    expect(fake.received).toContain("COMMIT");
    expect(proxy.events().map(e => e.action)).toEqual(expect.arrayContaining(["commit-held", "commit-released", "commit-complete"]));
    c.end();
  });
  it("serves the control API over HTTP", async () => {
    const { proxy } = await setup();
    const base = `http://127.0.0.1:${proxy.controlPort}`;
    expect((await fetch(`${base}/arm`, { method: "POST", body: JSON.stringify({ boundary: "OPERATION", mode: "hold-commit" }) })).status).toBe(200);
    expect((await fetch(`${base}/arm`, { method: "POST", body: JSON.stringify({ boundary: "NOPE", mode: "hold-commit" }) })).status).toBe(400);
    const events = await (await fetch(`${base}/events`)).json() as Array<{ action: string }>;
    expect(events.some(e => e.action === "armed:hold-commit")).toBe(true);
  });
});
