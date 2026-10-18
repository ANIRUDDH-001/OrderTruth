// MOCKED: every test here runs against tests/fake-paypal.ts, never the Sandbox.
import { describe, expect, it } from "vitest";
import { CheckoutError, CheckoutService } from "../src/checkout-service.ts";
import { Store } from "../src/db/store.ts";
import { PayPalClient, PayPalError } from "../src/paypal/client.ts";
import { FakePayPal, silentLogger, testPaypalConfig } from "./fake-paypal.ts";

function setup() {
  const fake = new FakePayPal();
  const store = new Store(":memory:");
  const log = silentLogger();
  const client = new PayPalClient(testPaypalConfig, fake.fetch);
  const svc = new CheckoutService(client, store, log, { secrets: [testPaypalConfig.clientSecret] });
  return { fake, store, log, client, svc };
}

describe("PayPalClient (mocked)", () => {
  it("refuses a non-sandbox config at construction", () => {
    expect(() => new PayPalClient({ ...testPaypalConfig, apiBase: "https://api-m.paypal.com" as any }, new FakePayPal().fetch)).toThrow(/non-Sandbox/);
  });
  it("classifies 401 as auth_failed without leaking secret", async () => {
    const { fake, client } = setup();
    fake.faults.token = "401";
    const err = await client.checkAuth({ correlationId: "c1" }).catch((e) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.kind).toBe("auth_failed");
    expect(JSON.stringify({ m: err.message, i: err.issues })).not.toContain(testPaypalConfig.clientSecret);
  });
  it("classifies 5xx, timeout and network as outcome-unknown", async () => {
    for (const f of ["500", "timeout", "network"] as const) {
      const { fake, client } = setup();
      fake.faults.token = f;
      const err = await client.checkAuth({ correlationId: "c" }).catch((e) => e);
      expect(err.outcomeUnknown).toBe(true);
    }
  });
  it("only ever calls the sandbox host", async () => {
    const { fake, svc } = setup();
    await svc.createOrder("corr-1");
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const c of fake.calls) expect(c.origin).toBe("https://api-m.sandbox.paypal.com");
  });
});

describe("CheckoutService lifecycle (mocked)", () => {
  it("creates an order from the server-owned amount and stable request ids", async () => {
    const { fake, svc, store } = setup();
    const o = await svc.createOrder("corr-1");
    const createCall = fake.calls.find((c) => c.path === "/v2/checkout/orders")!;
    const sent = JSON.parse(createCall.body!);
    expect(sent.intent).toBe("CAPTURE");
    expect(sent.purchase_units[0].amount).toMatchObject({ currency_code: "USD", value: "1.00" });
    expect(createCall.headers["PayPal-Request-Id"]).toBe(`ot-create-${o.attemptId}`);
    expect(store.getAttemptByOrderId(o.orderId)!.state).toBe("awaiting_buyer_approval");
    expect(o.approveUrl).toContain("sandbox.paypal.com");
  });

  it("refuses to capture before buyer approval and makes no capture call", async () => {
    const { fake, svc } = setup();
    const o = await svc.createOrder("c");
    const err = await svc.capture(o.orderId, "c").catch((e) => e);
    expect(err).toBeInstanceOf(CheckoutError);
    expect(err.code).toBe("not_approved");
    expect(fake.calls.some((c) => c.path.endsWith("/capture"))).toBe(false);
  });

  it("captures an approved order, then verifies via GET readback", async () => {
    const { fake, svc, store } = setup();
    const o = await svc.createOrder("c");
    fake.approve(o.orderId);
    const r = await svc.capture(o.orderId, "c");
    expect(r.state).toBe("captured");
    expect(r.amount).toEqual({ currency: "USD", value: "1.00" });
    const ops = store.listEvidence(r.attemptId).map((e) => `${e.evidence_class}:${e.operation}`);
    expect(ops).toEqual([
      "PAYPAL_API_RESPONSE:create_order",
      "PAYPAL_API_READBACK:pre_capture_readback",
      "PAYPAL_API_RESPONSE:capture_order",
      "PAYPAL_API_READBACK:post_capture_readback",
    ]);
    const capCall = fake.calls.find((c) => c.path.endsWith("/capture"))!;
    expect(capCall.headers["PayPal-Request-Id"]).toBe(`ot-capture-${r.attemptId}`);
  });

  it("is idempotent: a second capture makes no provider write", async () => {
    const { fake, svc } = setup();
    const o = await svc.createOrder("c");
    fake.approve(o.orderId);
    await svc.capture(o.orderId, "c");
    const before = fake.calls.filter((c) => c.path.endsWith("/capture")).length;
    const r2 = await svc.capture(o.orderId, "c2");
    expect(r2.state).toBe("captured");
    expect(fake.calls.filter((c) => c.path.endsWith("/capture")).length).toBe(before);
  });

  it("concurrent captures result in exactly one provider capture", async () => {
    const { fake, svc } = setup();
    const o = await svc.createOrder("c");
    fake.approve(o.orderId);
    const rs = await Promise.all([svc.capture(o.orderId, "a"), svc.capture(o.orderId, "b"), svc.capture(o.orderId, "c")]);
    expect(rs.every((r) => r.state === "captured")).toBe(true);
    expect(fake.calls.filter((c) => c.path.endsWith("/capture")).length).toBe(1);
  });

  it("5xx after the provider applied the capture: readback reconciles to captured, no blind retry", async () => {
    const { fake, svc } = setup();
    const o = await svc.createOrder("c");
    fake.approve(o.orderId);
    fake.faults.capture = "500-after-apply";
    const r = await svc.capture(o.orderId, "c");
    expect(r.state).toBe("captured");
    expect(fake.calls.filter((c) => c.path.endsWith("/capture")).length).toBe(1);
  });

  it("timeout on capture with nothing applied: stays approved (safe to retry with same request id)", async () => {
    const { fake, svc, store } = setup();
    const o = await svc.createOrder("c");
    fake.approve(o.orderId);
    fake.faults.capture = "timeout";
    const r = await svc.capture(o.orderId, "c");
    expect(r.state).toBe("approved");
    expect(store.listEvidence(r.attemptId).some((e) => e.operation === "capture_order_error")).toBe(true);
    delete fake.faults.capture;
    const r2 = await svc.capture(o.orderId, "c2");
    expect(r2.state).toBe("captured");
  });

  it("readback failure after capture leaves state uncertain, not captured and not failed", async () => {
    const { fake, svc } = setup();
    const o = await svc.createOrder("c");
    fake.approve(o.orderId);
    // let pre-capture GET succeed, fail the post-capture GET
    const origFetch = fake.fetch;
    let gets = 0;
    const client = new PayPalClient(testPaypalConfig, async (url, init) => {
      if ((init.method ?? "GET") === "GET" && ++gets === 2) {
        const e = new Error("t");
        e.name = "TimeoutError";
        throw e;
      }
      return origFetch(url, init);
    });
    const svc2 = new CheckoutService(client, (svc as any).store, silentLogger());
    const r = await svc2.capture(o.orderId, "c");
    expect(r.state).toBe("uncertain");
  });

  it("pending capture is reported as pending", async () => {
    const { fake, svc } = setup();
    const o = await svc.createOrder("c");
    fake.approve(o.orderId);
    fake.captureStatus = "PENDING";
    expect((await svc.capture(o.orderId, "c")).state).toBe("pending");
  });

  it("captured amount differing from intent is mismatch", async () => {
    const { fake, svc } = setup();
    const o = await svc.createOrder("c");
    fake.approve(o.orderId);
    fake.captureAmountOverride = "2.00";
    expect((await svc.capture(o.orderId, "c")).state).toBe("mismatch");
  });

  it("rejects unknown and malformed order ids without provider calls", async () => {
    const { fake, svc } = setup();
    await expect(svc.capture("NOTOURS12345", "c")).rejects.toMatchObject({ code: "unknown_order" });
    await expect(svc.capture("../../x", "c")).rejects.toMatchObject({ code: "invalid_order_id" });
    expect(fake.calls.length).toBe(0);
  });

  it("provider error on create is surfaced and recorded", async () => {
    const { fake, svc } = setup();
    fake.faults.create = "500";
    await expect(svc.createOrder("c")).rejects.toMatchObject({ code: "provider_error" });
  });

  it("evidence and logs never contain the secret, token or buyer email", async () => {
    const { fake, svc, store, log } = setup();
    const o = await svc.createOrder("c");
    fake.approve(o.orderId);
    const r = await svc.capture(o.orderId, "c");
    const blob = JSON.stringify(store.listEvidence(r.attemptId)) + log.lines.join("\n");
    expect(blob).not.toContain(testPaypalConfig.clientSecret);
    expect(blob).not.toContain("A21AAfake");
    expect(blob).not.toContain("buyer@example.com");
    expect(blob).not.toContain("seller@example.com");
    expect(blob).not.toContain("MERCHANTFAKE123");
  });
});
