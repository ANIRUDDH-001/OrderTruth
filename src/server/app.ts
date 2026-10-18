import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { SANDBOX_SDK_URL, type AppConfig } from "../config.ts";
import { CheckoutError, type CheckoutService } from "../checkout-service.ts";

const CORRELATION = /^[A-Za-z0-9._-]{8,64}$/;

export type AppDeps = { config: AppConfig; checkout: CheckoutService; webRoot?: string | undefined; logger?: boolean };

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger === false ? false : { level: deps.config.logLevel, redact: ["req.headers.authorization", "req.headers.cookie"] },
    genReqId: (req) => {
      const h = req.headers["x-correlation-id"];
      return typeof h === "string" && CORRELATION.test(h) ? h : `corr_${randomUUID()}`;
    },
    bodyLimit: 16 * 1024,
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-correlation-id", req.id);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    // Required by the PayPal v6 popup flow (mirrors the official sample's middleware).
    if (String(reply.getHeader("content-type") ?? "").startsWith("text/html")) reply.header("cross-origin-opener-policy", "same-origin-allow-popups");
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof CheckoutError) return reply.status(err.httpStatus).send({ error: err.code, message: err.message, correlationId: req.id });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: "bad_request", correlationId: req.id });
    req.log.error({ errName: (err as Error).name, errMsg: (err as Error).message }, "unhandled error");
    return reply.status(500).send({ error: "internal_error", correlationId: req.id });
  });

  app.get("/api/health", async () => ({ ok: true, paypalEnv: deps.config.paypal.env }));

  // Browser-safe values only: the client ID is public by PayPal's design; the secret never leaves the server.
  app.get("/api/paypal/browser-config", async () => ({ clientId: deps.config.paypal.clientId, environment: "sandbox", sdkUrl: SANDBOX_SDK_URL }));

  // The request body is deliberately ignored: amount, currency and items are server-owned.
  app.post("/api/orders", async (req) => {
    const o = await deps.checkout.createOrder(req.id);
    return { id: o.orderId, orderId: o.orderId, status: o.status, amount: o.amount };
  });

  app.post<{ Params: { orderId: string } }>("/api/orders/:orderId/capture", async (req) => deps.checkout.capture(req.params.orderId, req.id));
  app.post<{ Params: { orderId: string } }>("/api/orders/:orderId/readback", async (req) => deps.checkout.readback(req.params.orderId, req.id));
  app.get<{ Params: { orderId: string } }>("/api/orders/:orderId", async (req) => deps.checkout.status(req.params.orderId));

  // Redirect-approval fallback landing pages (used only when created with return/cancel URLs).
  app.get<{ Querystring: { token?: string } }>("/return", async (req, reply) => {
    const token = String(req.query.token ?? "").replace(/[^A-Z0-9]/g, "");
    reply.type("text/html").send(
      `<!doctype html><meta charset="utf-8"><title>OrderTruth Gate 0 - returned</title><body style="font-family:system-ui;max-width:40rem;margin:3rem auto">` +
        `<h1>Buyer returned from PayPal Sandbox</h1><p>Order <code>${token}</code>. Nothing has been captured yet.</p>` +
        `<p>Return to Claude Code and say <b>approved</b>, or run <code>pnpm cli capture ${token}</code>.</p></body>`,
    );
  });
  app.get("/cancel", async (_req, reply) => {
    reply.type("text/html").send(`<!doctype html><meta charset="utf-8"><title>Cancelled</title><body style="font-family:system-ui"><h1>Buyer cancelled. No capture will occur.</h1></body>`);
  });

  const webRoot = deps.webRoot ?? resolve("dist/web");
  if (existsSync(webRoot)) await app.register(fastifyStatic, { root: webRoot, prefix: "/" });

  return app;
}
