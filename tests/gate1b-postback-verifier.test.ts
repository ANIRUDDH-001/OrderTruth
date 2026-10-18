/**
 * Gate 1B: PayPal postback verifier and header/body validation, unit level (MOCKED PayPal).
 */
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";
import { PayPalClient } from "../src/paypal/client.ts";
import { claimedIdentity, EventSchema, isAllowedCertUrl, parseTransmissionHeaders, summarizeEvent } from "../src/webhooks/event.ts";
import { PayPalPostbackVerifier } from "../src/webhooks/verifier.ts";
import { FakePayPal, testPaypalConfig } from "./fake-paypal.ts";
import { captureEvent, CERT_URL, orderEvent, signedHeaders, TEST_WEBHOOK_ID, webhookEnv } from "./helpers/webhook-fixtures.ts";

function verifierWith(fake: FakePayPal, timeoutMs = 1000) {
  fake.registeredWebhookId = TEST_WEBHOOK_ID;
  return new PayPalPostbackVerifier(new PayPalClient({ ...testPaypalConfig, webhookId: TEST_WEBHOOK_ID }, fake.fetch), timeoutMs);
}
function input(raw: string, h = signedHeaders(raw)) {
  const headers = parseTransmissionHeaders(h);
  if ("reason" in headers) throw new Error(headers.reason);
  return { rawBody: raw, headers, webhookId: TEST_WEBHOOK_ID, correlationId: "corr_test_1234" };
}

describe("postback request", () => {
  it("B1 body = documented fields + webhook_event embedded verbatim; sent to the Sandbox verify endpoint with OAuth", async () => {
    const fake = new FakePayPal();
    const raw = '{ "id":"WH-ABCDEF123456",  "event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"C1","note":"\\u00e9 \\/"} }';
    const h = signedHeaders(raw);
    const r = await verifierWith(fake).verify(input(raw, h));
    expect(r.status).toBe("SUCCESS");
    const call = fake.calls.find((c) => c.path === "/v1/notifications/verify-webhook-signature")!;
    expect(call.origin).toBe("https://api-m.sandbox.paypal.com");
    expect(call.method).toBe("POST");
    expect(call.headers.Authorization).toMatch(/^Bearer /);
    expect(call.body).toBe(
      `{"auth_algo":"SHA256withRSA","cert_url":${JSON.stringify(CERT_URL)},"transmission_id":"${h["paypal-transmission-id"]}","transmission_sig":${JSON.stringify(h["paypal-transmission-sig"])},"transmission_time":"${h["paypal-transmission-time"]}","webhook_id":"${TEST_WEBHOOK_ID}","webhook_event":${raw}}`,
    );
    expect(JSON.parse(call.body!).webhook_event.resource.note).toBe("é /");
  });

  it.each([
    ["FAILURE", "FAILURE"],
    ["malformed", "UNAVAILABLE"],
    ["500", "UNAVAILABLE"],
    ["400", "UNAVAILABLE"],
    ["network", "UNAVAILABLE"],
  ] as const)("B2 PayPal %s -> %s", async (mode, status) => {
    const fake = new FakePayPal();
    fake.webhookVerify = mode;
    const raw = JSON.stringify(captureEvent({ orderId: "O", captureId: "C" }));
    expect((await verifierWith(fake).verify(input(raw))).status).toBe(status);
  });

  it("B3 deadline covers token fetch + postback even if the transport ignores abort", async () => {
    const fake = new FakePayPal();
    fake.webhookVerify = "hang_ignoring_abort";
    const raw = JSON.stringify(captureEvent({ orderId: "O", captureId: "C" }));
    const t0 = Date.now();
    const r = await verifierWith(fake, 600).verify(input(raw));
    expect(r).toMatchObject({ status: "UNAVAILABLE", kind: "timeout" });
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("B4 a SUCCESS is never synthesised from an HTTP 2xx without verification_status", async () => {
    const fake = new FakePayPal();
    const raw = JSON.stringify(captureEvent({ orderId: "O", captureId: "C" }));
    const orig = fake.fetch;
    (fake as { fetch: typeof orig }).fetch = async (url, init) =>
      new URL(url).pathname.endsWith("verify-webhook-signature") ? new Response("{}", { status: 200, headers: { "content-type": "application/json" } }) : orig(url, init);
    const v2 = new PayPalPostbackVerifier(new PayPalClient({ ...testPaypalConfig, webhookId: TEST_WEBHOOK_ID }, fake.fetch), 1000);
    expect((await v2.verify(input(raw))).status).toBe("UNAVAILABLE");
  });
});

describe("header validation", () => {
  const base = signedHeaders("{}");
  it.each([
    ["https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1", true],
    ["https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1", true],
    ["https://api-m.paypal.com/v1/notifications/certs/CERT-1", false],
    ["https://api-m.sandbox.paypal.com:8443/v1/notifications/certs/CERT-1", false],
    ["https://user:pw@api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1", false],
    ["https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1?u=http://evil", false],
    ["https://api-m.sandbox.paypal.com/v1/other/CERT-1", false],
    ["https://api-m.sandbox.paypal.com.evil.example/v1/notifications/certs/C", false],
    ["file:///etc/passwd", false],
    ["http://169.254.169.254/latest/meta-data", false],
    ["not a url", false],
  ])("H1 cert url %s -> %s", (u, ok) => expect(isAllowedCertUrl(u)).toBe(ok));

  it("H2 repeated (array) headers are rejected", () => {
    expect(parseTransmissionHeaders({ ...base, "paypal-transmission-sig": [base["paypal-transmission-sig"]!, "x"] })).toEqual({ reason: "missing_headers:paypal-transmission-sig" });
  });

  it.each([
    ["paypal-transmission-sig", "has spaces in it which is not base64", "invalid_transmission_sig"],
    ["paypal-transmission-sig", "short", "invalid_transmission_sig"],
    ["paypal-transmission-id", "x".repeat(51), "invalid_transmission_id"],
    ["paypal-transmission-id", "abc def", "invalid_transmission_id"],
    ["paypal-transmission-time", "2026-13-45T99:99:99Z", "invalid_transmission_time"],
    ["paypal-auth-algo", "sha256withrsa", "unsupported_auth_algo"],
  ])("H3 %s=%s -> %s", (k, v, reason) => {
    expect(parseTransmissionHeaders({ ...base, [k]: v })).toEqual({ reason });
  });
});

describe("event structure and minimisation", () => {
  it("E1 summary is an allowlist: no payer, payee, address, links or free text", () => {
    const sum = summarizeEvent(EventSchema.parse(orderEvent({ orderId: "ORDABCDEFGH1", customId: "ci_1" })));
    const text = JSON.stringify(sum);
    for (const pii of ["buyer-pii", "PAYERPII", "Pii Street", "99999", "summary", "links", "payer", "payee", "shipping"]) expect(text).not.toContain(pii);
    expect(sum.resource).toEqual({ id: "ORDABCDEFGH1", status: "APPROVED", amount: { currency_code: "USD", value: "1.00" }, custom_id: "ci_1", order_id: "ORDABCDEFGH1" });
    const cap = summarizeEvent(EventSchema.parse(captureEvent({ orderId: "ORDABCDEFGH1", captureId: "CAP1", customId: "ci_1" })));
    expect(cap.resource).toEqual({ id: "CAP1", status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" }, custom_id: "ci_1", order_id: "ORDABCDEFGH1" });
    expect(JSON.stringify(cap)).not.toContain("seller-pii");
  });

  it("E2 oversized or odd field values in the summary are dropped, not stored", () => {
    const e = captureEvent({ orderId: "x".repeat(500), captureId: "C".repeat(500), customId: "y".repeat(500) });
    const sum = summarizeEvent(EventSchema.parse(e));
    expect(sum.resource.order_id).toBeNull();
    expect(sum.resource.id).toBeNull();
    expect(sum.resource.custom_id).toBeNull();
  });

  it("E3 claimed identity hints from unverified bodies are charset/length bounded", () => {
    expect(claimedIdentity({ id: "WH-OK-1", event_type: "A.B" })).toEqual({ id: "WH-OK-1", type: "A.B" });
    expect(claimedIdentity({ id: "a'b", event_type: "a b" })).toEqual({ id: null, type: null });
    expect(claimedIdentity([1])).toEqual({ id: null, type: null });
  });
});

describe("config", () => {
  it("C1 defaults: 127.0.0.1:3002, 5 s verify timeout, 64 KiB, 1 h window, 5 min skew", () => {
    const c = loadConfig(webhookEnv());
    expect(c.webhook).toEqual({ host: "127.0.0.1", port: 3002, verifyTimeoutMs: 5000, maxBodyBytes: 65536, maxTransmissionAgeMs: 3600000, maxFutureSkewMs: 300000 });
    expect(c.port).toBe(3001);
    expect(c.secrets).toContain(TEST_WEBHOOK_ID);
  });

  it.each([
    [{ WEBHOOK_VERIFY_TIMEOUT_MS: "100" }, "WEBHOOK_VERIFY_TIMEOUT_MS"],
    [{ WEBHOOK_VERIFY_TIMEOUT_MS: "60000" }, "WEBHOOK_VERIFY_TIMEOUT_MS"],
    [{ WEBHOOK_MAX_BODY_BYTES: "10" }, "WEBHOOK_MAX_BODY_BYTES"],
    [{ WEBHOOK_MAX_BODY_BYTES: "10000000" }, "WEBHOOK_MAX_BODY_BYTES"],
    [{ WEBHOOK_MAX_TRANSMISSION_AGE_MS: "1000" }, "WEBHOOK_MAX_TRANSMISSION_AGE_MS"],
    [{ PAYPAL_WEBHOOK_ID: "has-dash" }, "PAYPAL_WEBHOOK_ID"],
    [{ PAYPAL_WEBHOOK_ID: "x".repeat(51) }, "PAYPAL_WEBHOOK_ID"],
    [{ WEBHOOK_PORT: "3001" }, "WEBHOOK_PORT"],
    [{ PAYPAL_WEBHOOK_ID: "WEBHOOK_ID" }, "PAYPAL_WEBHOOK_ID"],
  ])("C2 %o rejected (key %s)", (extra, key) => {
    try {
      loadConfig(webhookEnv(extra as Record<string, string>));
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).keys).toContain(key);
      expect((e as ConfigError).message).not.toContain(TEST_WEBHOOK_ID);
    }
  });

  it("C3 webhook id stays optional for the checkout app", () => {
    expect(loadConfig(webhookEnv({ PAYPAL_WEBHOOK_ID: "" })).paypal.webhookId).toBeUndefined();
  });
});
