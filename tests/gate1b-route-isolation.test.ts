/**
 * Gate 1B route isolation. The webhook listener (future tunnel target) exposes exactly
 * POST /webhooks/paypal on loopback and cannot reach the checkout app (port 3001 role).
 */
import { readdirSync, readFileSync } from "node:fs";
import { connect, type AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ConfigError, loadConfig } from "../src/config.ts";
import { buildApp } from "../src/server/app.ts";
import { startWebhookListener } from "../src/webhooks/runtime.ts";
import { captureEvent, setupWebhook, signedHeaders, webhookEnv, type Setup } from "./helpers/webhook-fixtures.ts";

/** One raw HTTP/1.1 exchange over a real TCP socket (so request targets are not normalised by a client). */
function rawHttp(port: number, request: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1");
    let buf = "";
    sock.setTimeout(5000, () => sock.destroy(new Error("socket timeout")));
    sock.on("data", (d) => (buf += String(d)));
    sock.on("error", reject);
    sock.on("close", () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0), text: buf }));
    sock.write(request);
  });
}
const req = (method: string, target: string, headers: Record<string, string> = {}, body = "") =>
  `${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n${Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join("")}${body || method === "POST" ? `Content-Length: ${Buffer.byteLength(body)}\r\n` : ""}\r\n${body}`;

let s: Setup;
let wPort: number;
let stopW: () => void;
let main: FastifyInstance;
let mainPort: number;
let mainRequests = 0;

beforeAll(async () => {
  s = await setupWebhook();
  const started = await startWebhookListener(s.svc, { port: 0, intervalMs: 0 });
  wPort = started.port;
  stopW = started.stop;
  // The checkout app (the role of port 3001), with a counter on every request it ever sees.
  main = await buildApp({ config: loadConfig(webhookEnv()), checkout: s.checkout, logger: false, webRoot: join(tmpdir(), "ordertruth-no-web") });
  main.addHook("onRequest", async () => void mainRequests++);
  await main.listen({ host: "127.0.0.1", port: 0 });
  mainPort = (main.server.address() as AddressInfo).port;
});
afterAll(async () => {
  stopW();
  await s.svc.app.close();
  await main.close();
  s.store.close();
});

describe("listener surface", () => {
  it("I1 binds loopback IPv4 only, on its own port", () => {
    const a = s.svc.app.server.address() as AddressInfo;
    expect(a.address).toBe("127.0.0.1");
    expect(a.port).not.toBe(mainPort);
  });

  it("I2 exactly one route is registered", () => {
    const routes = s.svc.app.printRoutes({ commonPrefix: false });
    expect(routes).toContain("/webhooks/paypal (POST)");
    expect(routes.match(/\(/g)).toHaveLength(1);
  });

  it("I3 a signed, valid POST /webhooks/paypal over a real socket -> 200", async () => {
    const raw = JSON.stringify(captureEvent({ orderId: "FOREIGNORDER0000009", captureId: "FOREIGNCAP00009" }));
    const r = await rawHttp(wPort, req("POST", "/webhooks/paypal", signedHeaders(raw), raw));
    expect(r.status).toBe(200);
    expect(r.text.toLowerCase()).toContain("cache-control: no-store");
    expect(r.text.toLowerCase()).toContain("x-content-type-options: nosniff");
  });

  it.each(["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"])("I4 %s /webhooks/paypal -> 404", async (m) => {
    const before = s.svc.inbox.listDeliveries().length;
    const target = m === "CONNECT" ? "127.0.0.1:3001" : "/webhooks/paypal";
    const r = await rawHttp(wPort, req(m, target));
    // CONNECT: Node has no 'connect' handler registered, so the socket is closed without any response (0).
    expect(m === "CONNECT" ? [0] : [404]).toContain(r.status);
    expect(s.svc.inbox.listDeliveries()).toHaveLength(before);
  });

  it.each([
    "/",
    "/api/health",
    "/api/paypal/browser-config",
    "/api/orders",
    "/api/orders/FAKE0000000000001/capture",
    "/api/orders/FAKE0000000000001/readback",
    "/api/orders/FAKE0000000000001",
    "/return?token=X",
    "/cancel",
    "/index.html",
    "/assets/index.js",
    "/admin",
    "/debug",
    "/metrics",
    "/documentation",
    "/webhooks",
    "/webhooks/paypal/",
    "/WEBHOOKS/PAYPAL",
    "/webhooks/PayPal",
    "/webhooks//paypal",
    "//webhooks/paypal",
    "/./webhooks/paypal",
    "/webhooks/./paypal",
    "/webhooks/paypal/../../api/orders",
    "/webhooks/%70aypal",
    "/webhooks%2Fpaypal",
    "/webhooks/paypal?x=1",
    "/webhooks/paypal#frag",
    "/webhooks/paypal;jsessionid=1",
    "/webhooks/paypal%00",
    "http://127.0.0.1:3001/api/orders/FAKE0000000000001/capture",
    "http://127.0.0.1:3002/webhooks/paypal",
    "*",
  ])("I5 POST %s -> 404, nothing recorded", async (target) => {
    const before = s.svc.inbox.listDeliveries().length;
    const r = await rawHttp(wPort, req("POST", target, { "content-type": "application/json", "x-checkout-key": "ck_aaaaaaaaaaaaaaaaaaaa" }, "{}"));
    expect(r.status).toBe(404);
    expect(s.svc.inbox.listDeliveries()).toHaveLength(before);
  });

  it.each([
    { "x-http-method-override": "POST" },
    { "x-http-method": "POST" },
    { "x-original-url": "/webhooks/paypal" },
    { "x-rewrite-url": "/webhooks/paypal" },
  ])("I6 GET with override header %o -> 404", async (h) => {
    const r = await rawHttp(wPort, req("GET", "/webhooks/paypal", h));
    expect(r.status).toBe(404);
  });

  it("I7 the tunnel path can never reach the checkout app: Host/forwarding headers are ignored and nothing is proxied", async () => {
    const before = mainRequests;
    const spoof = { host: `127.0.0.1:${mainPort}`, "x-forwarded-host": `127.0.0.1:${mainPort}`, "x-forwarded-port": String(mainPort), forwarded: `host=127.0.0.1:${mainPort}` };
    for (const target of ["/api/orders", `/api/orders/FAKE0000000000001/capture`, "/api/health", `http://127.0.0.1:${mainPort}/api/orders`]) {
      const r = await rawHttp(wPort, `POST ${target} HTTP/1.1\r\nHost: ${spoof.host}\r\nX-Forwarded-Host: ${spoof["x-forwarded-host"]}\r\nForwarded: ${spoof.forwarded}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
      expect(r.status).toBe(404);
    }
    const raw = JSON.stringify(captureEvent({ orderId: "FOREIGNORDER0000010", captureId: "FOREIGNCAP00010" }));
    expect((await rawHttp(wPort, req("POST", "/webhooks/paypal", { ...signedHeaders(raw), "x-forwarded-host": `127.0.0.1:${mainPort}` }, raw))).status).toBe(200);
    expect(mainRequests).toBe(before); // the checkout app never saw a single request
  });

  it("I8 the checkout app has no webhook route", async () => {
    const r = await main.inject({ method: "POST", url: "/webhooks/paypal", payload: "{}", headers: { "content-type": "application/json" } });
    expect(r.statusCode).toBe(404);
  });

  it("I9 outbound traffic from the listener goes only to the Sandbox API host (via the injected client)", () => {
    expect(new Set(s.fake.calls.map((c) => c.origin))).toEqual(new Set(["https://api-m.sandbox.paypal.com"]));
  });
});

describe("static isolation guarantees", () => {
  it("S1 webhook source imports no checkout HTTP app, static server, proxy or raw HTTP client", () => {
    const d = join(import.meta.dirname, "..", "src", "webhooks");
    for (const f of readdirSync(d)) {
      const src = readFileSync(join(d, f), "utf8");
      for (const banned of ["../server/", "@fastify/static", "@fastify/http-proxy", "@fastify/reply-from", "node:http", "node:https", "fetch(", "child_process"]) {
        expect(src.includes(banned), `${f} contains ${banned}`).toBe(false);
      }
    }
  });

  it("S2 config refuses WEBHOOK_PORT == PORT and the simulator webhook id; the listener refuses a non-loopback host", async () => {
    expect(() => loadConfig(webhookEnv({ PORT: "3001", WEBHOOK_PORT: "3001" }))).toThrow(ConfigError);
    expect(() => loadConfig(webhookEnv({ PAYPAL_WEBHOOK_ID: "WEBHOOK_ID" }))).toThrow(ConfigError);
    const t = await setupWebhook();
    (t.config.webhook as { host: string }).host = "0.0.0.0";
    await expect(startWebhookListener(t.svc, { port: 0, intervalMs: 0 })).rejects.toThrow(ConfigError);
    (t.config.webhook as { host: string }).host = "127.0.0.1";
    await expect(startWebhookListener(t.svc, { port: t.config.port, intervalMs: 0 })).rejects.toThrow(ConfigError);
    t.store.close();
  });

  it("S3 the listener refuses to assemble without a configured webhook id", async () => {
    await expect(setupWebhook({ env: { PAYPAL_WEBHOOK_ID: "" } })).rejects.toThrow(ConfigError);
  });
});
