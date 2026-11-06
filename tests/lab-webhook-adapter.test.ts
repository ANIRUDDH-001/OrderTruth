/** OFFLINE ONLY: recorded-shaped proof fixtures, mocked GET and SQL; no Sandbox claim. */
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { createLabWebhookAdapter, type LabWebhookDependencies, type LabWebhookResult } from "../src/merchant/lab-webhook-adapter.ts";
import { handleCaptureWebhook } from "../packages/lab-merchant/src/nc/nc3-key-on-path.ts";
import type { CaptureCapability } from "../packages/guard/src/capability.ts";
import type { DeliveryRow, EventRow } from "../src/webhooks/inbox.ts";
import type { OrderReadback } from "../src/domain/checkout.ts";
import { captureEvent, capturedAtPayPalUnknownLocally, deliver, setupWebhook } from "./helpers/webhook-fixtures.ts";

function setup() {
  const scope = { paypalEnv: "sandbox", apiBase: "https://api-m.sandbox.paypal.com", provenance: "MOCK_READBACK", merchantId: "SYN-MERCHANT", payeeMerchantId: "SYN-PAYEE", orderId: "SYN-ORDER", captureId: "SYN-CAPTURE", intentId: "SYN-INTENT", observationId: "SYN-OBSERVATION", amount: { currency: "USD", minor: 100 } } as const;
  const summary = { id: "WH-OFFLINE-000001", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: scope.captureId, order_id: scope.orderId, custom_id: scope.intentId, status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } } };
  const event: EventRow = { event_id: summary.id, event_type: summary.event_type, resource_type: "capture", event_create_time: null, first_delivery_seq: 1, deliveries: 1, state: "processed", order_id: scope.orderId, attempt_id: "SYN-ATTEMPT", process_attempts: 1, next_attempt_at_ms: 0, lease_until_ms: null, outcome: "readback applied", summary_json: JSON.stringify(summary) };
  const delivery: DeliveryRow = { seq: 1, state: "verified", claimed_event_id: summary.id, claimed_event_type: summary.event_type, transmission_id: "SYN-TRANSMISSION", transmission_time: "2026-11-05T00:00:00Z", body_sha256: "0".repeat(64), body_bytes: 1, reason: "paypal_postback SUCCESS", correlation_id: "SYN-CORRELATION", verify_ms: 1, verify_debug_id: null, received_at_ms: 1 };
  const raw = { id: scope.orderId, status: "COMPLETED", intent: "CAPTURE", purchase_units: [{ custom_id: scope.intentId, amount: { currency_code: "USD", value: "1.00" }, payee: { merchant_id: scope.payeeMerchantId }, payments: { captures: [{ id: scope.captureId, status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } }] } }] };
  const capability: CaptureCapability = { authority: "TEST", provenance: "SYNTHETIC_FIXTURE", merchantId: scope.merchantId, paypalEnv: "sandbox", payeeMerchantId: scope.payeeMerchantId, paypalOrderId: scope.orderId, captureId: scope.captureId, status: "COMPLETED", currency: "USD", amountMinor: "100", intentId: scope.intentId, verificationMethod: "FIXTURE", observedAt: "2026-11-05T00:00:00Z", responseHash: "0".repeat(64), evidenceId: scope.observationId, mac: "fixture-not-a-valid-guard-capability" };
  const sql: string[] = [];
  const pool = { query: vi.fn(async (query: string) => { sql.push(query); return { rows: query.startsWith("SELECT") ? [] : [{ id: "SYN-MERCHANT-ORDER" }] }; }) } as unknown as pg.Pool;
  // Contract double only. Durable cross-process journal qualification remains untested.
  const seen = new Map<string, Promise<LabWebhookResult>>();
  const deps: LabWebhookDependencies = {
    loadProcessed: vi.fn(async () => ({ event, delivery })),
    readback: vi.fn(async () => raw), merchantDeps: vi.fn(async () => ({ pool, afterCheck: async () => {}, capability })),
    handler: vi.fn(handleCaptureWebhook),
    once: async (id, write) => {
      const previous = seen.get(id);
      if (previous) { await previous; return { outcome: "replay", eventId: id }; }
      const pending = write(); seen.set(id, pending);
      try { return await pending; } catch (error) { seen.delete(id); throw error; }
    },
  };
  return { scope, summary, event, delivery, raw, capability, sql, deps, invoke: createLabWebhookAdapter(scope, deps), id: summary.id };
}

describe("isolated Lab webhook adapter (offline proof fixtures)", () => {
  it("bridges the real intake/processor with mocked signature postback and GET, without financial POSTs", async () => {
    const s = await setupWebhook();
    try {
      const purchase = await capturedAtPayPalUnknownLocally(s);
      const event = captureEvent({ orderId: purchase.orderId, captureId: purchase.captureId, customId: purchase.intentId });
      expect((await deliver(s, event)).status).toBe(200);
      await s.svc.processor.drain();
      const f = setup();
      const before = s.fake.calls.filter((c) => c.method === "POST" && c.path.startsWith("/v2/")).length;
      const capability = { ...f.capability, paypalOrderId: purchase.orderId, captureId: purchase.captureId, intentId: purchase.intentId, payeeMerchantId: "MERCHANTFAKE123" };
      const invoke = createLabWebhookAdapter({ ...f.scope, orderId: purchase.orderId, captureId: purchase.captureId, intentId: purchase.intentId, payeeMerchantId: "MERCHANTFAKE123" }, {
        ...f.deps,
        loadProcessed: async (id) => {
          const stored = s.svc.inbox.getEvent(id);
          const delivery = stored && s.svc.inbox.getDelivery(stored.first_delivery_seq);
          return stored && delivery ? { event: stored, delivery } : null;
        },
        readback: async (id) => (await s.paypal.getOrder(id, { correlationId: "offline-lab-bridge" })).body as OrderReadback,
        merchantDeps: async () => ({ ...(await f.deps.merchantDeps({})), capability }),
      });
      expect(await invoke(event.id)).toMatchObject({ outcome: "written", provenance: "MOCK_READBACK" });
      expect(f.sql[1]).toMatch(/INSERT INTO shop.orders/);
      expect(s.fake.calls.filter((c) => c.method === "POST" && c.path.startsWith("/v2/"))).toHaveLength(before);
    } finally { await s.svc.app.close(); s.store.close(); }
  });
  it("calls the actual NC3 webhook writer after proof/readback checks, preserving mock provenance", async () => {
    const f = setup();
    expect(await f.invoke(f.id)).toMatchObject({ outcome: "written", provenance: "MOCK_READBACK", result: { ok: true, created: true } });
    expect(f.sql).toHaveLength(2);
    expect(f.sql[1]).toMatch(/INSERT INTO shop.orders/);
    expect(f.deps.handler).toHaveBeenCalledOnce();
  });
  it("delegates concurrent and repeated event IDs to the mandatory journal", async () => {
    const f = setup();
    const result = await Promise.all([f.invoke(f.id), f.invoke(f.id), f.invoke(f.id)]);
    expect(result.map((r) => r.outcome)).toEqual(["written", "replay", "replay"]);
    expect(f.deps.handler).toHaveBeenCalledOnce();
  });
  it.each(["rejected", "duplicate", "received_unverified"] as const)("rejects %s delivery before GET or merchant SQL", async (state) => {
    const f = setup(); f.delivery.state = state;
    await expect(f.invoke(f.id)).rejects.toThrow(/verified processing proof/);
    expect(f.deps.readback).not.toHaveBeenCalled(); expect(f.sql).toEqual([]);
  });
  it("rejects foreign events before GET", async () => {
    const f = setup(); f.summary.resource.order_id = "FOREIGN" as typeof f.summary.resource.order_id; f.event.summary_json = JSON.stringify(f.summary);
    await expect(f.invoke(f.id)).rejects.toThrow(/foreign/); expect(f.sql).toEqual([]);
  });
  it.each(["PENDING", "DENIED"])("rejects %s capture readback", async (status) => {
    const f = setup(); f.raw.purchase_units[0]!.payments.captures[0]!.status = status;
    await expect(f.invoke(f.id)).rejects.toThrow(/readback/); expect(f.sql).toEqual([]);
  });
  it("rejects a different payee", async () => {
    const f = setup(); f.raw.purchase_units[0]!.payee.merchant_id = "FOREIGN" as typeof f.scope.payeeMerchantId;
    await expect(f.invoke(f.id)).rejects.toThrow(/readback/); expect(f.sql).toEqual([]);
  });
  it("rejects mismatched capability before actual writer", async () => {
    const f = setup(); f.capability.captureId = "FOREIGN";
    await expect(f.invoke(f.id)).rejects.toThrow(/capability/); expect(f.sql).toEqual([]);
  });
  it("does not label fixture authority as PayPal evidence", async () => {
    const f = setup(); const invoke = createLabWebhookAdapter({ ...f.scope, provenance: "PAYPAL_READBACK" }, f.deps);
    await expect(invoke(f.id)).rejects.toThrow(/capability/); expect(f.sql).toEqual([]);
  });
  it("allows retry after read-only failure without writing", async () => {
    const f = setup(); vi.mocked(f.deps.readback).mockRejectedValueOnce(new Error("offline timeout"));
    await expect(f.invoke(f.id)).rejects.toThrow("offline timeout"); expect(f.sql).toEqual([]);
    expect(await f.invoke(f.id)).toMatchObject({ outcome: "written" });
  });
  it("fails closed for production host even when runtime input bypasses types", () => {
    const f = setup(); expect(() => createLabWebhookAdapter({ ...f.scope, apiBase: "https://api-m.paypal.com" as typeof f.scope.apiBase }, f.deps)).toThrow(/sandbox/);
  });
});
