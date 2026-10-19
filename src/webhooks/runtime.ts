import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.ts";
import { ConfigError } from "../config.ts";
import type { CheckoutService, Logger } from "../checkout-service.ts";
import type { Store } from "../db/store.ts";
import type { PayPalClient } from "../paypal/client.ts";
import { buildWebhookApp } from "./app.ts";
import { WebhookInbox } from "./inbox.ts";
import { WebhookIntake } from "./intake.ts";
import { WebhookProcessor } from "./processor.ts";
import { PayPalPostbackVerifier, type WebhookVerifier } from "./verifier.ts";

export type WebhookService = { app: FastifyInstance; inbox: WebhookInbox; intake: WebhookIntake; processor: WebhookProcessor; config: AppConfig; log: Logger };

/** Loopback addresses the listener may bind. Anything else is refused: exposure is only via an explicit tunnel. */
const LOOPBACK = new Set(["127.0.0.1", "::1"]);

/** Wire the webhook pipeline. Shared by the real listener and the tests (which inject a verifier/clock). */
export async function assembleWebhookService(o: {
  config: AppConfig;
  store: Store;
  paypal: PayPalClient;
  checkout: CheckoutService;
  log: Logger;
  verifier?: WebhookVerifier;
  now?: () => number;
  afterVerify?: () => void;
  processor?: { leaseMs?: number; maxAttempts?: number; baseBackoffMs?: number };
}): Promise<WebhookService> {
  const webhookId = o.config.paypal.webhookId;
  if (!webhookId) throw new ConfigError("PAYPAL_WEBHOOK_ID is required to run the webhook listener", ["PAYPAL_WEBHOOK_ID"]);
  const w = o.config.webhook;
  const inbox = new WebhookInbox(o.store);
  const processor = new WebhookProcessor(inbox, o.checkout, { log: o.log, ...(o.now ? { now: o.now } : {}), ...(o.processor ?? {}) });
  const intake = new WebhookIntake(inbox, o.verifier ?? new PayPalPostbackVerifier(o.paypal, w.verifyTimeoutMs), {
    webhookId,
    maxTransmissionAgeMs: w.maxTransmissionAgeMs,
    maxFutureSkewMs: w.maxFutureSkewMs,
    maxStoredUnverified: o.config.webhookIngress.maxStoredUnverified,
    log: o.log,
    onAccepted: () => processor.kick(),
    ...(o.now ? { now: o.now } : {}),
    ...(o.afterVerify ? { afterVerify: o.afterVerify } : {}),
  });
  const app = await buildWebhookApp({
    intake,
    maxBodyBytes: w.maxBodyBytes,
    log: o.log,
    rateLimit: { perMinute: o.config.webhookIngress.ratePerMinute, burst: o.config.webhookIngress.rateBurst, ...(o.now ? { now: o.now } : {}) },
  });
  return { app, inbox, intake, processor, config: o.config, log: o.log };
}

/**
 * Recovery, then listen on loopback, then a periodic sweep. Recovery closes deliveries a crash left
 * open (they never got a 2xx, so PayPal redelivers) and processes any committed-but-unprocessed
 * events, including expired leases.
 */
export async function startWebhookListener(svc: WebhookService, o: { port?: number; intervalMs?: number; staleGraceMs?: number } = {}): Promise<{ port: number; abandoned: number; stop: () => void }> {
  const w = svc.config.webhook;
  if (!LOOPBACK.has(w.host)) throw new ConfigError("webhook listener must bind a loopback address", ["WEBHOOK_PORT"]);
  const port = o.port ?? w.port;
  if (port !== 0 && port === svc.config.port) throw new ConfigError("WEBHOOK_PORT must differ from PORT", ["WEBHOOK_PORT"]);
  // An open delivery younger than this may still be in flight in a previous process that is shutting down.
  const grace = o.staleGraceMs ?? w.verifyTimeoutMs + 10_000;
  const abandoned = svc.inbox.abandonStale(Date.now() - grace);
  svc.log.info({ evt: "webhook_startup_recovery", abandoned });
  await svc.processor.drain();
  await svc.app.listen({ host: w.host, port });
  const addr = svc.app.server.address();
  const bound = typeof addr === "object" && addr ? addr.port : port;
  const intervalMs = o.intervalMs ?? 30_000;
  let timer: NodeJS.Timeout | null = null;
  if (intervalMs > 0) {
    timer = setInterval(() => {
      try {
        svc.inbox.abandonStale(Date.now() - grace);
      } catch {
        /* retried next tick */
      }
      svc.processor.kick();
    }, intervalMs);
    timer.unref();
  }
  return { port: bound, abandoned, stop: () => timer && clearInterval(timer) };
}
