/**
 * TEST HELPERS ONLY. Builders for MOCKED PayPal webhook deliveries and an assembled webhook
 * pipeline on the in-memory FakePayPal. Nothing here is a Sandbox execution.
 */
import { randomUUID } from "node:crypto";
import { CheckoutService } from "../../src/checkout-service.ts";
import { loadConfig } from "../../src/config.ts";
import { Store } from "../../src/db/store.ts";
import { PayPalClient } from "../../src/paypal/client.ts";
import { assembleWebhookService } from "../../src/webhooks/runtime.ts";
import type { WebhookVerifier } from "../../src/webhooks/verifier.ts";
import { fakeWebhookSignature, FakePayPal, newCheckoutKey, silentLogger, testPaypalConfig } from "../fake-paypal.ts";

export const TEST_WEBHOOK_ID = "TESTWEBHOOK0SANDBOX0001";
export const CERT_URL = "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77";

export const webhookEnv = (extra: Record<string, string> = {}) => ({
  PAYPAL_ENV: "sandbox",
  PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com",
  PAYPAL_CLIENT_ID: testPaypalConfig.clientId,
  PAYPAL_CLIENT_SECRET: testPaypalConfig.clientSecret,
  PAYPAL_WEBHOOK_ID: TEST_WEBHOOK_ID,
  ...extra,
});

export type SetupOpts = {
  path?: string;
  busyTimeoutMs?: number;
  fake?: FakePayPal;
  verifier?: WebhookVerifier;
  now?: () => number;
  afterVerify?: () => void;
  env?: Record<string, string>;
  processor?: { leaseMs?: number; maxAttempts?: number; baseBackoffMs?: number };
};

export async function setupWebhook(o: SetupOpts = {}) {
  const fake = o.fake ?? new FakePayPal();
  fake.registeredWebhookId ??= TEST_WEBHOOK_ID;
  const store = new Store(o.path ?? ":memory:", o.busyTimeoutMs !== undefined ? { busyTimeoutMs: o.busyTimeoutMs } : {});
  const log = silentLogger();
  const config = loadConfig(webhookEnv(o.env));
  const paypal = new PayPalClient({ ...testPaypalConfig, webhookId: TEST_WEBHOOK_ID }, fake.fetch);
  const checkout = new CheckoutService(paypal, store, log, { secrets: config.secrets });
  const svc = await assembleWebhookService({
    config,
    store,
    paypal,
    checkout,
    log,
    ...(o.verifier ? { verifier: o.verifier } : {}),
    ...(o.now ? { now: o.now } : {}),
    ...(o.afterVerify ? { afterVerify: o.afterVerify } : {}),
    ...(o.processor ? { processor: o.processor } : {}),
  });
  return { fake, store, log, config, paypal, checkout, svc };
}
export type Setup = Awaited<ReturnType<typeof setupWebhook>>;

let n = 0;
export const newEventId = () => `WH-${String(++n).padStart(4, "0")}TEST${randomUUID().slice(0, 8).toUpperCase()}`;

/** A realistic capture event, including payee/PII-ish fields that must never be stored. */
export function captureEvent(o: { orderId: string; captureId: string; customId?: string | undefined; value?: string; currency?: string; status?: string; type?: string; id?: string }) {
  const status = o.status ?? "COMPLETED";
  return {
    id: o.id ?? newEventId(),
    event_version: "1.0",
    create_time: new Date().toISOString(),
    resource_type: "capture",
    resource_version: "2.0",
    event_type: o.type ?? `PAYMENT.CAPTURE.${status}`,
    summary: `Payment ${status.toLowerCase()} for $ ${o.value ?? "1.00"} USD`,
    resource: {
      id: o.captureId,
      status,
      amount: { currency_code: o.currency ?? "USD", value: o.value ?? "1.00" },
      final_capture: true,
      ...(o.customId !== undefined ? { custom_id: o.customId } : {}),
      seller_protection: { status: "ELIGIBLE" },
      payee: { email_address: "seller-pii@example.com", merchant_id: "MERCHANTFAKE123" },
      supplementary_data: { related_ids: { order_id: o.orderId } },
      links: [{ href: `https://api.sandbox.paypal.com/v2/payments/captures/${o.captureId}`, rel: "self", method: "GET" }],
    },
    links: [{ href: "https://api.sandbox.paypal.com/v1/notifications/webhooks-events/x", rel: "self", method: "GET" }],
  };
}

export function orderEvent(o: { orderId: string; customId?: string | undefined; value?: string; currency?: string; status?: string; type?: string; id?: string }) {
  return {
    id: o.id ?? newEventId(),
    event_version: "1.0",
    create_time: new Date().toISOString(),
    resource_type: "checkout-order",
    resource_version: "2.0",
    event_type: o.type ?? "CHECKOUT.ORDER.APPROVED",
    summary: "An order has been approved by buyer",
    resource: {
      id: o.orderId,
      status: o.status ?? "APPROVED",
      intent: "CAPTURE",
      payer: { email_address: "buyer-pii@example.com", payer_id: "PAYERPII0001", name: { given_name: "Pii", surname: "Buyer" } },
      purchase_units: [
        {
          reference_id: "OT-GATE0-SANDBOX-TEST",
          ...(o.customId !== undefined ? { custom_id: o.customId } : {}),
          amount: { currency_code: o.currency ?? "USD", value: o.value ?? "1.00" },
          shipping: { address: { address_line_1: "1 Pii Street", postal_code: "99999" } },
        },
      ],
    },
  };
}

export type HeaderOpts = { webhookId?: string; time?: string; tid?: string; sig?: string; certUrl?: string; authAlgo?: string; omit?: string[] };

/** Transmission headers signed by the FAKE signer over the exact raw body. */
export function signedHeaders(raw: string, o: HeaderOpts = {}): Record<string, string> {
  const tid = o.tid ?? randomUUID();
  const time = o.time ?? new Date().toISOString();
  const h: Record<string, string> = {
    "content-type": "application/json",
    "paypal-transmission-id": tid,
    "paypal-transmission-time": time,
    "paypal-transmission-sig": o.sig ?? fakeWebhookSignature(tid, time, o.webhookId ?? TEST_WEBHOOK_ID, raw),
    "paypal-cert-url": o.certUrl ?? CERT_URL,
    "paypal-auth-algo": o.authAlgo ?? "SHA256withRSA",
  };
  for (const k of o.omit ?? []) delete h[k];
  return h;
}

export async function post(s: Setup, raw: string | Buffer, headers: Record<string, string>, url = "/webhooks/paypal") {
  const r = await s.svc.app.inject({ method: "POST", url, payload: raw, headers });
  return { status: r.statusCode, body: r.body ? (JSON.parse(r.body) as Record<string, unknown>) : {} };
}

/** Deliver an event object as PayPal would: JSON text, signed. */
export async function deliver(s: Setup, event: unknown, h: HeaderOpts = {}) {
  const raw = JSON.stringify(event);
  return post(s, raw, signedHeaders(raw, h));
}

/** A checkout created through our CheckoutService (so the order is ours). */
export async function ourOrder(s: Setup) {
  const o = await s.checkout.createOrder("corr-wh-setup", { checkoutKey: newCheckoutKey() });
  return { ...o, captureId: FakePayPal.captureIdFor(o.orderId) };
}

/** An order whose capture PayPal applied but whose outcome this host never learned (uncertain locally). */
export async function capturedAtPayPalUnknownLocally(s: Setup) {
  const o = await ourOrder(s);
  s.fake.approve(o.orderId);
  s.fake.faults = { capture: "500-after-apply" };
  s.fake.afterCaptureApply = () => void (s.fake.faults.get = "500"); // the post-capture readback fails too
  await s.checkout.capture(o.orderId, "corr-unknown").catch(() => undefined);
  s.fake.afterCaptureApply = undefined;
  s.fake.faults = {};
  if (s.store.getAttemptByOrderId(o.orderId)!.state !== "uncertain") throw new Error("fixture did not produce an uncertain attempt");
  return o;
}

export const paymentWrites = (fake: FakePayPal) => fake.calls.filter((c) => c.method === "POST" && c.path.startsWith("/v2/"));
