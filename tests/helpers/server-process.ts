/**
 * TEST HARNESS ONLY (never imported by src/). Runs the real OrderTruth HTTP app and startup path
 * in its own OS process against a shared SQLite file and the HTTP-served FakePayPal.
 *
 * env: OT_DB_PATH, OT_FAKE_PAYPAL_URL, OT_SETTLE_MS, OT_STALE_MS,
 *      OT_CRASH_AT = "" | "before_capture_post" | "after_capture_response"  (hard process kill)
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CheckoutService } from "../../src/checkout-service.ts";
import { loadConfig } from "../../src/config.ts";
import { Store } from "../../src/db/store.ts";
import { PayPalClient, type FetchLike } from "../../src/paypal/client.ts";
import { buildApp } from "../../src/server/app.ts";
import { startServer } from "../../src/server/start.ts";
import { silentLogger, testPaypalConfig } from "../fake-paypal.ts";

const env = process.env;
const fakeBase = env.OT_FAKE_PAYPAL_URL!;
const crashAt = env.OT_CRASH_AT ?? "";

// Forced termination, no cleanup handlers: the closest in-process equivalent of a power cut.
const hardKill = (): never => {
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable");
};

const forward: FetchLike = async (url, init) => {
  const u = new URL(url);
  const isCapture = init.method === "POST" && u.pathname.endsWith("/capture");
  if (isCapture && crashAt === "before_capture_post") hardKill();
  const { signal: _signal, ...rest } = init;
  const res = await fetch(fakeBase + u.pathname + u.search, rest);
  if (isCapture && crashAt === "after_capture_response") {
    await res.arrayBuffer(); // PayPal has applied the capture and answered; we die before any local write
    hardKill();
  }
  return res;
};

const config = loadConfig({
  PAYPAL_ENV: "sandbox",
  PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com",
  PAYPAL_CLIENT_ID: testPaypalConfig.clientId,
  PAYPAL_CLIENT_SECRET: testPaypalConfig.clientSecret,
});
const store = new Store(env.OT_DB_PATH!);
const log = silentLogger();
const checkout = new CheckoutService(new PayPalClient(testPaypalConfig, forward), store, log, {
  captureSettleMs: Number(env.OT_SETTLE_MS ?? 120_000),
  reconcileStaleMs: Number(env.OT_STALE_MS ?? 60_000),
});
const app = await buildApp({ config, checkout, logger: false, webRoot: join(tmpdir(), "ordertruth-no-web") });
const started = await startServer({ app, checkout, log, host: "127.0.0.1", port: 0, reconcileIntervalMs: 0 });
console.log(JSON.stringify({ ready: true, pid: process.pid, port: started.port, startupReconcile: started.startupReconcile }));
