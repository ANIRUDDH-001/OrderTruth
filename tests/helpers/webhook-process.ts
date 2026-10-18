/**
 * TEST HARNESS ONLY (never imported by src/). Runs the real webhook listener (assembly, startup
 * recovery, loopback listen) in its own OS process against a shared SQLite file and the
 * HTTP-served FakePayPal. MOCKED provider.
 *
 * env: OT_DB_PATH, OT_FAKE_PAYPAL_URL, OT_LEASE_MS,
 *      OT_CRASH_AT = "" | "webhook_after_verify" | "webhook_before_readback"  (hard process kill)
 */
import { CheckoutService } from "../../src/checkout-service.ts";
import { loadConfig } from "../../src/config.ts";
import { Store } from "../../src/db/store.ts";
import { PayPalClient, type FetchLike } from "../../src/paypal/client.ts";
import { assembleWebhookService, startWebhookListener } from "../../src/webhooks/runtime.ts";
import { silentLogger, testPaypalConfig } from "../fake-paypal.ts";
import { TEST_WEBHOOK_ID, webhookEnv } from "./webhook-fixtures.ts";

const env = process.env;
const fakeBase = env.OT_FAKE_PAYPAL_URL!;
const crashAt = env.OT_CRASH_AT ?? "";

const hardKill = (): never => {
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable");
};

const forward: FetchLike = async (url, init) => {
  const u = new URL(url);
  if (crashAt === "webhook_before_readback" && init.method === "GET" && u.pathname.startsWith("/v2/checkout/orders/")) hardKill();
  const { signal: _signal, ...rest } = init;
  return fetch(fakeBase + u.pathname + u.search, rest);
};

const config = loadConfig(webhookEnv());
const store = new Store(env.OT_DB_PATH!);
const log = silentLogger();
const paypal = new PayPalClient({ ...testPaypalConfig, webhookId: TEST_WEBHOOK_ID }, forward);
const checkout = new CheckoutService(paypal, store, log, { secrets: config.secrets });
const svc = await assembleWebhookService({
  config,
  store,
  paypal,
  checkout,
  log,
  processor: { leaseMs: Number(env.OT_LEASE_MS ?? 60_000) },
  ...(crashAt === "webhook_after_verify" ? { afterVerify: hardKill } : {}),
});
const started = await startWebhookListener(svc, { port: 0, intervalMs: 0, staleGraceMs: 0 });
console.log(JSON.stringify({ ready: true, pid: process.pid, port: started.port, abandoned: started.abandoned }));
