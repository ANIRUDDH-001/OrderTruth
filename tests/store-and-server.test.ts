import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Store } from "../src/db/store.ts";
import { CheckoutService } from "../src/checkout-service.ts";
import { PayPalClient } from "../src/paypal/client.ts";
import { buildApp } from "../src/server/app.ts";
import { loadConfig } from "../src/config.ts";
import { FakePayPal, silentLogger, testPaypalConfig } from "./fake-paypal.ts";

const dir = mkdtempSync(join(tmpdir(), "ordertruth-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Store (real SQLite file)", () => {
  it("persists intent/attempt/evidence across a separate OS process (restart proof, mocked provider)", async () => {
    const path = join(dir, "restart.sqlite");
    const fake = new FakePayPal();
    const store = new Store(path);
    const svc = new CheckoutService(new PayPalClient(testPaypalConfig, fake.fetch), store, silentLogger());
    const o = await svc.createOrder("corr-restart");
    fake.approve(o.orderId);
    await svc.capture(o.orderId, "corr-restart");
    store.close();

    // A brand-new Node process opens the same file: no shared memory with this test process.
    const script = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      const a = db.prepare('SELECT state, capture_status, captured_minor, paypal_order_id FROM payment_attempts').all();
      const ev = db.prepare('SELECT COUNT(*) n FROM evidence').get().n;
      console.log(JSON.stringify({ pid: process.pid, a, ev }));`;
    const out = JSON.parse(execFileSync(process.execPath, ["--no-warnings", "-e", script, path]).toString());
    expect(out.pid).not.toBe(process.pid);
    expect(out.a).toEqual([{ state: "captured", capture_status: "COMPLETED", captured_minor: 100, paypal_order_id: o.orderId }]);
    expect(out.ev).toBe(4);

    // Reopen via Store: migrations are idempotent and state is intact.
    const s2 = new Store(path);
    expect(s2.getAttemptByOrderId(o.orderId)!.state).toBe("captured");
    s2.close();
  });

  it("evidence is append-only", () => {
    const s = new Store(":memory:");
    s.appendEvidence({ attemptId: null, evidenceClass: "MERCHANT_DB_OBSERVED", operation: "x", httpStatus: null, debugId: null, requestId: null, correlationId: "c", durationMs: null, summary: {} });
    expect(() => s.db.exec("UPDATE evidence SET operation='y'")).toThrow(/append-only/);
    expect(() => s.db.exec("DELETE FROM evidence")).toThrow(/append-only/);
  });

  it("enforces unique PayPal order id and capture request id", () => {
    const s = new Store(":memory:");
    s.createIntentWithAttempt({ id: "i1", sku: "s", currency: "USD", amount_minor: 100, correlation_id: "c" }, { id: "a1", createRequestId: "r1", captureRequestId: "k1" });
    s.createIntentWithAttempt({ id: "i2", sku: "s", currency: "USD", amount_minor: 100, correlation_id: "c" }, { id: "a2", createRequestId: "r2", captureRequestId: "k2" });
    s.updateAttempt("a1", { paypal_order_id: "ORDERX" });
    expect(() => s.updateAttempt("a2", { paypal_order_id: "ORDERX" })).toThrow();
    expect(() =>
      s.createIntentWithAttempt({ id: "i3", sku: "s", currency: "USD", amount_minor: 100, correlation_id: "c" }, { id: "a3", createRequestId: "r3", captureRequestId: "k1" }),
    ).toThrow();
    // the failed transaction rolled back the intent too
    expect(s.getIntent("i3")).toBeUndefined();
  });

  it("claimCapture is compare-and-set", () => {
    const s = new Store(":memory:");
    s.createIntentWithAttempt({ id: "i1", sku: "s", currency: "USD", amount_minor: 100, correlation_id: "c" }, { id: "a1", createRequestId: "r1", captureRequestId: "k1" });
    s.updateAttempt("a1", { state: "approved" });
    expect(s.claimCapture("a1", ["approved"])).toBe(true);
    expect(s.claimCapture("a1", ["approved"])).toBe(false);
  });
});

describe("HTTP API (mocked provider)", () => {
  const config = loadConfig({
    PAYPAL_ENV: "sandbox",
    PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com",
    PAYPAL_CLIENT_ID: testPaypalConfig.clientId,
    PAYPAL_CLIENT_SECRET: testPaypalConfig.clientSecret,
  });
  async function app() {
    const fake = new FakePayPal();
    const store = new Store(":memory:");
    const checkout = new CheckoutService(new PayPalClient(testPaypalConfig, fake.fetch), store, silentLogger());
    return { fake, a: await buildApp({ config, checkout, logger: false, webRoot: join(dir, "none") }) };
  }

  it("browser config exposes client id only, never the secret", async () => {
    const { a } = await app();
    const r = await a.inject({ method: "GET", url: "/api/paypal/browser-config" });
    expect(r.json()).toEqual({ clientId: "test-client-id", environment: "sandbox", sdkUrl: "https://www.sandbox.paypal.com/web-sdk/v6/core" });
    expect(r.body).not.toContain(testPaypalConfig.clientSecret);
  });

  it("ignores browser-submitted amounts", async () => {
    const { a, fake } = await app();
    const r = await a.inject({ method: "POST", url: "/api/orders", payload: { amount: "0.01", currency: "EUR", value: "99999" } });
    expect(r.statusCode).toBe(200);
    const sent = JSON.parse(fake.calls.find((c) => c.path === "/v2/checkout/orders")!.body!);
    expect(sent.purchase_units[0].amount.value).toBe("1.00");
    expect(sent.purchase_units[0].amount.currency_code).toBe("USD");
  });

  it("propagates a valid correlation id and rejects capture of unapproved order with 409", async () => {
    const { a } = await app();
    const c = await a.inject({ method: "POST", url: "/api/orders", headers: { "x-correlation-id": "test-corr-123" } });
    expect(c.headers["x-correlation-id"]).toBe("test-corr-123");
    const r = await a.inject({ method: "POST", url: `/api/orders/${c.json().orderId}/capture` });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("not_approved");
  });

  it("unknown order -> 404; provider 500 on create -> 502 without internals", async () => {
    const { a, fake } = await app();
    expect((await a.inject({ method: "POST", url: "/api/orders/ABCDEFGH12345/capture" })).statusCode).toBe(404);
    fake.faults.create = "500";
    const r = await a.inject({ method: "POST", url: "/api/orders" });
    expect(r.statusCode).toBe(502);
    expect(r.body).not.toContain(testPaypalConfig.clientSecret);
  });
});
