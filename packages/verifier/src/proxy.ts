/**
 * Gate A fault proxy (plan Task 5; spec §5.3e test, rung L21). A byte-level PostgreSQL v3 forwarder that can lose a
 * COMMIT acknowledgement, drop a COMMIT before the server sees it, or hold a COMMIT — once, on the next COMMIT of a
 * connection whose latest simple query set `application_name = 'ot:<BOUNDARY>'`. Trusted verifier code; never shipped
 * in the guard. Control API: POST /arm {boundary, mode}, POST /release, GET /events, POST /reset.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";

export class FrameError extends Error {
  constructor(message: string) { super(message); this.name = "FrameError"; }
}
export type Frame = { kind: "startup" | "ssl-request" | "typed"; type: string | null; raw: Buffer; payload: Buffer };

const MAX_FRAME = 64 * 1024 * 1024;
const SSL_REQUEST = 80877103, GSSENC_REQUEST = 80877104;

/** Splits a PostgreSQL v3 byte stream into frames. The client side starts with untyped startup-phase messages. */
export class FrameParser {
  private buffer = Buffer.alloc(0);
  private startupPhase: boolean;
  constructor(side: "client" | "server") { this.startupPhase = side === "client"; }

  push(chunk: Buffer): Frame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      if (this.startupPhase) {
        if (this.buffer.length < 4) break;
        const length = this.buffer.readInt32BE(0);
        if (length < 8 || length > MAX_FRAME) throw new FrameError(`invalid startup message length ${length}`);
        if (this.buffer.length < length) break;
        const raw = this.buffer.subarray(0, length), code = raw.readInt32BE(4);
        this.buffer = this.buffer.subarray(length);
        if (code === SSL_REQUEST || code === GSSENC_REQUEST) frames.push({ kind: "ssl-request", type: null, raw, payload: raw.subarray(4) });
        else { frames.push({ kind: "startup", type: null, raw, payload: raw.subarray(4) }); this.startupPhase = false; }
        continue;
      }
      if (this.buffer.length < 5) break;
      const length = this.buffer.readInt32BE(1);
      if (length < 4 || length > MAX_FRAME) throw new FrameError(`invalid frame length ${length}`);
      if (this.buffer.length < length + 1) break;
      const raw = this.buffer.subarray(0, length + 1);
      this.buffer = this.buffer.subarray(length + 1);
      frames.push({ kind: "typed", type: String.fromCharCode(raw[0]!), raw, payload: raw.subarray(5) });
    }
    return frames;
  }
}

const cString = (b: Buffer) => { const end = b.indexOf(0); return b.subarray(0, end < 0 ? b.length : end).toString("utf8"); };
/** The SQL text of a simple-protocol Query ('Q') frame. */
export function queryText(f: Frame): string | null { return f.kind === "typed" && f.type === "Q" ? cString(f.payload) : null; }
/** The tag of a CommandComplete ('C') frame. */
export function commandTag(f: Frame): string | null { return f.kind === "typed" && f.type === "C" ? cString(f.payload) : null; }

export type Boundary = "ISSUANCE" | "OPERATION" | "REJECTION_AUDIT";
const BOUNDARY_TAG = /^\s*SET\s+LOCAL\s+application_name\s*=\s*'ot:(ISSUANCE|OPERATION|REJECTION_AUDIT)'\s*;?\s*$/i;
export function boundaryTag(sql: string): Boundary | null { return (BOUNDARY_TAG.exec(sql)?.[1]?.toUpperCase() as Boundary | undefined) ?? null; }
export function isCommit(sql: string): boolean { return /^\s*COMMIT\s*;?\s*$/i.test(sql); }

export type ProxyMode = "drop-commit-ack" | "drop-before-commit" | "hold-commit";
export type ProxyRule = { boundary: Boundary; mode: ProxyMode };
export type ProxyEvent = { at: string; connection: number; boundary: Boundary | null; action: string };
export type FaultProxy = { port: number; controlPort: number; arm(rule: ProxyRule): void; release(): void; events(): ProxyEvent[]; reset(): void; close(): Promise<void> };

/** Starts the proxy. Port 0 picks a free port; `host` defaults to 127.0.0.1 (use 0.0.0.0 only on an internal network). */
export async function startFaultProxy(o: { listenPort: number; target: { host: string; port: number }; controlPort: number; host?: string }): Promise<FaultProxy> {
  const host = o.host ?? "127.0.0.1";
  let armed: ProxyRule | null = null, nextId = 0;
  const events: ProxyEvent[] = [], held: Array<() => void> = [], sockets = new Set<Socket>();
  const log = (connection: number, boundary: Boundary | null, action: string) => events.push({ at: new Date().toISOString(), connection, boundary, action });

  const server = createServer(client => {
    const id = ++nextId, upstream = connect(o.target.port, o.target.host);
    sockets.add(client); sockets.add(upstream);
    const fromClient = new FrameParser("client"), fromServer = new FrameParser("server");
    let boundary: Boundary | null = null, dropAck = false, holding: Buffer[] | null = null;
    const kill = () => { client.destroy(); upstream.destroy(); };
    client.on("close", () => { sockets.delete(client); upstream.destroy(); });
    upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
    client.on("error", kill); upstream.on("error", kill);
    log(id, null, "connect");

    client.on("data", chunk => {
      let frames: Frame[];
      try { frames = fromClient.push(chunk); } catch { log(id, boundary, "malformed-client-frame"); kill(); return; }
      for (const f of frames) {
        if (f.kind === "ssl-request") { client.write("N"); continue; }      // refuse encryption; the server never sees the request
        if (holding) { holding.push(f.raw); continue; }
        const text = queryText(f);
        if (text !== null) {
          const tag = boundaryTag(text);
          if (tag) { boundary = tag; log(id, boundary, "boundary"); }
          if (isCommit(text)) {
            const rule = armed && armed.boundary === boundary ? armed : null;
            if (rule) armed = null;
            if (rule?.mode === "drop-before-commit") { log(id, boundary, "commit-dropped-before-server"); kill(); return; }
            if (rule?.mode === "hold-commit") {
              holding = [f.raw]; log(id, boundary, "commit-held");
              held.push(() => { const bytes = holding ?? []; holding = null; log(id, boundary, "commit-released"); for (const b of bytes) upstream.write(b); });
              continue;
            }
            if (rule?.mode === "drop-commit-ack") dropAck = true;
            log(id, boundary, "commit-forwarded");
          }
        }
        upstream.write(f.raw);
      }
    });

    upstream.on("data", chunk => {
      let frames: Frame[];
      try { frames = fromServer.push(chunk); } catch { log(id, boundary, "malformed-server-frame"); kill(); return; }
      for (const f of frames) {
        if (commandTag(f) === "COMMIT") {
          log(id, boundary, "commit-complete");
          if (dropAck) { log(id, boundary, "commit-ack-dropped"); kill(); return; }
        }
        client.write(f.raw);
      }
    });
  });

  const readBody = (req: IncomingMessage) => new Promise<string>((resolve, reject) => {
    let body = ""; req.on("data", c => { body += c; if (body.length > 4096) reject(new Error("body too large")); }); req.on("end", () => resolve(body)); req.on("error", reject); });
  const api = {
    arm(rule: ProxyRule) {
      if (!["ISSUANCE", "OPERATION", "REJECTION_AUDIT"].includes(rule.boundary) || !["drop-commit-ack", "drop-before-commit", "hold-commit"].includes(rule.mode))
        throw new Error("invalid proxy rule");
      armed = { boundary: rule.boundary, mode: rule.mode }; log(0, rule.boundary, `armed:${rule.mode}`);
    },
    release() { for (const r of held.splice(0)) r(); },
    events: () => events.map(e => ({ ...e })),
    reset() { armed = null; events.length = 0; },
  };
  const control = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    void (async () => {
      try {
        if (req.method === "POST" && req.url === "/arm") { api.arm(JSON.parse(await readBody(req)) as ProxyRule); return reply(200, { ok: true }); }
        if (req.method === "POST" && req.url === "/release") { api.release(); return reply(200, { ok: true }); }
        if (req.method === "POST" && req.url === "/reset") { api.reset(); return reply(200, { ok: true }); }
        if (req.method === "GET" && req.url === "/events") return reply(200, api.events());
        reply(404, { error: "not found" });
      } catch (error) { reply(400, { error: error instanceof Error ? error.message : String(error) }); }
    })();
  });

  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(o.listenPort, host, resolve); });
  await new Promise<void>((resolve, reject) => { control.once("error", reject); control.listen(o.controlPort, host, resolve); });
  return {
    port: (server.address() as AddressInfo).port, controlPort: (control.address() as AddressInfo).port, ...api,
    async close() {
      api.release();
      for (const s of sockets) s.destroy();
      await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => control.close(() => r()))]);
    },
  };
}
