import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { Logger } from "../checkout-service.ts";
import type { WebhookIntake } from "./intake.ts";
import { TokenBucket, type RateLimitOptions } from "./rate-limit.ts";

export const WEBHOOK_PATH = "/webhooks/paypal";
/** 404/429 lines are not written one per request (a log flood); at most NOISE_LOG_BURST per window, then a count. */
const NOISE_LOG_WINDOW_MS = 10_000;
const NOISE_LOG_BURST = 20;

export type WebhookAppDeps = { intake: WebhookIntake; maxBodyBytes: number; log: Logger; rateLimit: RateLimitOptions };

/**
 * The webhook ingress listener. It is a separate Fastify instance (separate process and port from
 * the checkout app) with exactly one route, `POST /webhooks/paypal`. No checkout or capture API,
 * no static files, no health/debug/admin endpoints, no proxying. Anything else is 404.
 */
export async function buildWebhookApp(deps: WebhookAppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // our own logger; request bodies, signatures and headers are never logged
    // Correlation ids are always generated here: an inbound x-correlation-id is attacker-controlled.
    genReqId: () => `wh_${randomUUID()}`,
    bodyLimit: deps.maxBodyBytes,
    exposeHeadRoutes: false,
    routerOptions: { caseSensitive: true, ignoreTrailingSlash: false, ignoreDuplicateSlashes: false },
    return503OnClosing: true,
  });

  const safeLog = (level: keyof Logger, obj: object) => {
    try {
      deps.log[level]({ evt: "webhook_http", ...obj });
    } catch {
      /* ignore */
    }
  };

  // Bounded logging for unauthenticated noise: past NOISE_LOG_BURST lines per window, lines are counted, not written.
  const clock = deps.rateLimit.now ?? Date.now;
  const windows = new Map<string, { start: number; n: number }>();
  const noisyLog = (key: string, obj: object) => {
    const at = clock();
    let w = windows.get(key);
    if (!w || at - w.start >= NOISE_LOG_WINDOW_MS) {
      if (w && w.n > NOISE_LOG_BURST) safeLog("warn", { reason: key, suppressedLines: w.n - NOISE_LOG_BURST, windowMs: NOISE_LOG_WINDOW_MS });
      w = { start: at, n: 0 };
      windows.set(key, w);
    }
    if (++w.n <= NOISE_LOG_BURST) safeLog("info", obj);
  };

  // Exact request-target match before routing: no query strings, absolute-form targets, encodings,
  // case or slash variants. Only the raw target the tunnel will forward is accepted.
  app.addHook("onRequest", async (req, reply) => {
    if (req.raw.method !== "POST" || req.raw.url !== WEBHOOK_PATH) {
      noisyLog("not_found", { corr: req.id, status: 404, method: String(req.raw.method).slice(0, 10) });
      return reply.status(404).send({ ok: false, error: "not_found" });
    }
  });

  // Then, before body parsing and before any SQLite write, every request to the route spends a token.
  const bucket = new TokenBucket(deps.rateLimit);
  app.addHook("onRequest", async (req, reply) => {
    const t = bucket.take();
    if (t.ok) return;
    noisyLog("rate_limited", { corr: req.id, status: 429, reason: "rate_limited" });
    reply.header("retry-after", String(Math.max(1, Math.ceil(t.retryAfterMs / 1000))));
    return reply.status(429).send({ ok: false, error: "rate_limited" });
  });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("cache-control", "no-store");
    reply.header("referrer-policy", "no-referrer");
  });

  // Raw bytes only: the exact body is what PayPal signed and what the postback must embed.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ ok: false, error: "not_found" }));

  app.setErrorHandler((err, req, reply) => {
    const code = (err as { statusCode?: number }).statusCode;
    if (code === 413 || code === 415) {
      safeLog("info", { corr: req.id, status: code, reason: code === 413 ? "body_too_large" : "unsupported_media_type" });
      return reply.status(code).send({ ok: false, error: code === 413 ? "body_too_large" : "unsupported_media_type" });
    }
    if (code && code >= 400 && code < 500) {
      safeLog("info", { corr: req.id, status: 400, reason: "bad_request" });
      return reply.status(400).send({ ok: false, error: "bad_request" });
    }
    // Unknown failure: never claim success; PayPal retries a 5xx.
    safeLog("error", { corr: req.id, status: 503, errName: (err as Error)?.name });
    return reply.status(503).send({ ok: false, error: "unavailable" });
  });

  app.post(WEBHOOK_PATH, async (req, reply) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const r = await deps.intake.receive(raw, req.headers, req.id);
    return reply.status(r.status).send(r.body);
  });

  return app;
}
