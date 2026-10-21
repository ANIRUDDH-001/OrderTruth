import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { loadPostgresConfig,SANDBOX_SDK_URL } from "../config.ts";
import { createPostgresPool } from "../db/postgres.ts";
import { migratePostgres } from "../db/postgres-migrate.ts";
import { PostgresCheckoutStore } from "../db/postgres-checkout.ts";
import { PostgresCheckoutService } from "../postgres-checkout-service.ts";
import { PayPalClient } from "../paypal/client.ts";
import { CheckoutError } from "../checkout-service.ts";
import type { AttemptRow } from "../db/store.ts";
import { toProviderValue } from "../domain/money.ts";
import { createSessionAuth } from "./auth.ts";
import { registerSessionApi,sessionIdentity } from "./session-api.ts";
import { registerJudgeApi } from "./judge-api.ts";
import { PostgresInvestigationService } from "../ai/postgres-investigation-service.ts";
import { callInvestigator } from "../ai/investigation.ts";
import { PostgresWebhookInbox } from "../webhooks/postgres-inbox.ts";
import { WebhookIntake } from "../webhooks/intake.ts";
import { PayPalPostbackVerifier } from "../webhooks/verifier.ts";
import { WebhookProcessor } from "../webhooks/processor.ts";
import { EVENT_TERMINAL } from "../webhooks/inbox.ts";
import { TokenBucket } from "../webhooks/rate-limit.ts";

export async function buildHostedApp(config: ReturnType<typeof loadPostgresConfig>,options: { staticFiles?: boolean; schema?: string } = {}) {
  const schema = options.schema ?? "ordertruth";
  if (schema !== "ordertruth" && (process.env.NODE_ENV !== "test" || !/^qual_[a-f0-9]{20}$/.test(schema))) throw new Error("Invalid application database schema");
  const pool = createPostgresPool(config.databaseUrl);
  pool.options.options += ` -c search_path=${schema},pg_catalog`;
  try { await migratePostgres(pool,schema); } catch (error) { await pool.end(); throw error; }
  const auth = createSessionAuth(pool,config.origin,config.authSecret);
  const checkoutStore = new PostgresCheckoutStore(pool,schema);
  const paypal = new PayPalClient(config.paypal);
  const checkout = new PostgresCheckoutService(paypal,checkoutStore);
  const app = Fastify({ logger: false,bodyLimit: 16_384,genReqId: () => randomUUID(),trustProxy: false });
  app.addHook("onClose",async () => { await pool.end(); });
  app.addHook("onSend",async (request,reply) => {
    reply.header("x-request-id",request.id); reply.header("x-content-type-options","nosniff"); reply.header("referrer-policy","no-referrer");
    reply.header("content-security-policy","frame-ancestors 'none'");
    if (String(reply.getHeader("content-type") ?? "").startsWith("text/html")) reply.header("cross-origin-opener-policy","same-origin-allow-popups");
  });
  app.setErrorHandler((error,request,reply) => {
    if (error instanceof CheckoutError) return reply.code(error.httpStatus).send({ error: error.code,message: error.message,requestId: request.id });
    const status = (error as { statusCode?: number }).statusCode;
    return reply.code(status && status >= 400 && status < 500 ? status : 503).send({ error: "Request unavailable; committed evidence is preserved",requestId: request.id });
  });
  registerSessionApi(app,auth,config.origin,config.ownerIds);
  const investigator = config.ai.provider === "gemini" && config.ai.apiKey ? new PostgresInvestigationService(pool,schema,{
    model: config.ai.model ?? "gemini-3.5-flash-lite",dailyLimit: config.aiDailyLimit,userDailyLimit: config.aiUserDailyLimit,minIntervalMs: 15_000,
    infer: evidence => callInvestigator({ apiKey: config.ai.apiKey!,model: config.ai.model ?? "gemini-3.5-flash-lite",evidence }),
  }) : undefined;
  registerJudgeApi(app,{ pool,schema,auth,origin: config.origin,sourceAttemptId: config.sourceAttemptId,...(investigator ? { investigator } : {}) });
  app.get("/api/health",async () => ({ ok: true,environment: "sandbox",persistence: "postgresql",schemaVersion: 8 }));
  const browserAttempt = (a: AttemptRow) => ({ attemptId: a.id,orderId: a.paypal_order_id,state: a.state,captureId: a.capture_id,captureStatus: a.capture_status,
    amount: a.captured_minor !== null && a.captured_currency === "USD" ? { currency: a.captured_currency,value: toProviderValue({ currency: a.captured_currency,minor: a.captured_minor }) } : null,
    reasons: a.verdict_reasons ? JSON.parse(a.verdict_reasons) as string[] : [] });
  app.register(async owner => {
    owner.addHook("onRequest",async (request,reply) => {
      reply.header("cache-control","no-store");
      if (request.method === "POST" && request.headers.origin !== config.origin) return reply.code(403).send({ error: "Same-origin request required" });
      const identity = await sessionIdentity(auth,request,config.ownerIds);
      if (!identity?.owner) return reply.code(403).send({ error: "Owner sign-in required; judges cannot perform payment actions" });
      if (request.method === "POST" && (request.routeOptions.url === "/api/orders" || request.routeOptions.url?.endsWith("/capture"))
        && (Date.now()-identity.authenticatedAtMs > 900_000 || identity.authenticatedAtMs > Date.now())) return reply.code(403).send({ error: "Owner reauthentication required before payment actions" });
    });
    owner.get("/api/paypal/browser-config",async () => ({ environment: "sandbox",clientId: config.paypal.clientId,sdkUrl: SANDBOX_SDK_URL }));
    owner.post("/api/orders",async (request,reply) => {
      const key = request.headers["x-checkout-key"];
      if (typeof key !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) return reply.code(400).send({ error: "invalid_checkout_key" });
      const order = await checkout.create(key);
      if (order.state === "captured") throw new CheckoutError("checkout_already_paid","This checkout is already paid. Do not pay again.",409);
      return { ...order,status: order.state };
    });
    owner.post<{ Params: { orderId: string } }>("/api/orders/:orderId/capture",async request => browserAttempt(await checkout.capture(request.params.orderId)));
    owner.post<{ Params: { orderId: string } }>("/api/orders/:orderId/readback",async request => browserAttempt(await checkout.readback(request.params.orderId)));
    owner.get<{ Params: { orderId: string } }>("/api/orders/:orderId",async request => browserAttempt((await checkoutStore.byOrder(request.params.orderId)).attempt));
  });
  if (config.paypal.webhookId) app.register(async webhooks => {
    const ingress = new TokenBucket({ perMinute: config.webhookIngress.ratePerMinute,burst: config.webhookIngress.rateBurst });
    webhooks.addHook("onRequest",async (request,reply) => {
      if (request.routeOptions.url !== "/api/paypal/webhook") return;
      const allowed = ingress.take();
      if (!allowed.ok) return reply.header("retry-after",String(Math.max(1,Math.ceil(allowed.retryAfterMs/1000)))).code(429).send({ error: "Webhook ingress limited; retry delivery" });
    });
    const inbox = new PostgresWebhookInbox(pool,schema);
    const quiet = { info: () => {},warn: () => {},error: () => {} };
    const processor = new WebhookProcessor(inbox,checkout,{ log: quiet });
    const intake = new WebhookIntake(inbox,new PayPalPostbackVerifier(paypal,config.webhook.verifyTimeoutMs),{
      webhookId: config.paypal.webhookId!,maxTransmissionAgeMs: config.webhook.maxTransmissionAgeMs,maxFutureSkewMs: config.webhook.maxFutureSkewMs,
      maxStoredUnverified: config.webhookIngress.maxStoredUnverified,log: quiet,
    });
    webhooks.removeContentTypeParser("application/json");
    webhooks.addContentTypeParser("application/json",{ parseAs: "buffer",bodyLimit: config.webhook.maxBodyBytes },(_request,body,done) => done(null,body));
    webhooks.post("/api/paypal/webhook",{ bodyLimit: config.webhook.maxBodyBytes },async (request,reply) => {
      if (!Buffer.isBuffer(request.body)) return reply.code(415).send({ error: "JSON event bytes required" });
      const accepted = await intake.receive(request.body,request.headers,request.id);
      if (accepted.status !== 200) return reply.code(accepted.status).send(accepted.body);
      await processor.drain(10);
      const delivery = await inbox.getDelivery(accepted.body.delivery!);
      const event = delivery?.claimed_event_id ? await inbox.getEvent(delivery.claimed_event_id) : null;
      if (!event || !EVENT_TERMINAL.includes(event.state)) return reply.code(503).send({ error: "Event persisted; required processing is pending, retry delivery" });
      return { ...accepted.body,processingState: event.state };
    });
    // Explicit owner resume replaces process timers as the recovery mechanism.
    webhooks.post("/api/owner/webhooks/resume",async (request,reply) => {
      if (request.headers.origin !== config.origin || !(await sessionIdentity(auth,request,config.ownerIds))?.owner) return reply.code(403).send({ error: "Owner session required" });
      return { attempted: await processor.drain(20) };
    });
  });
  if (options.staticFiles !== false) {
    await app.register(fastifyStatic,{ root: resolve("dist/judge"),prefix: "/" });
    await app.register(fastifyStatic,{ root: resolve("dist/owner"),prefix: "/owner/",decorateReply: false });
  }
  return app;
}
