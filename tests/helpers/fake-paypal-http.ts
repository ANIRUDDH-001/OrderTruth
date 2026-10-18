/**
 * TEST HARNESS ONLY. Serves the in-memory FakePayPal over local HTTP so that independent OS
 * processes share one fake provider (and one call log). MOCKED: never the Sandbox.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FakePayPal } from "../fake-paypal.ts";

// PayPalClient sends these with exact casing; Node lowercases incoming header names.
const CANONICAL: Record<string, string> = { authorization: "Authorization", "paypal-request-id": "PayPal-Request-Id", "content-type": "Content-Type", prefer: "Prefer", accept: "Accept" };

export async function serveFakePayPal(fake: FakePayPal): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[CANONICAL[k] ?? k] = v;
    const r = await fake.fetch(`https://api-m.sandbox.paypal.com${req.url ?? "/"}`, { method: req.method ?? "GET", headers, ...(body !== undefined ? { body } : {}) });
    res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
    res.end(await r.text());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
