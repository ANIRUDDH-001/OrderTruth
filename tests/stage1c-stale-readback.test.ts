/**
 * Stage 1C item 8 — offline regression for the webhook stale-readback race (MOCKED PayPal; no
 * Sandbox call, no new payment). A verified PAYMENT.CAPTURE.COMPLETED whose authoritative GET
 * succeeds but does not show the capture yet must be retried, not turned into a terminal
 * disagreement. Genuine contradictions (different capture, amount, currency) stay terminal.
 */
import { describe, expect, it } from "vitest";
import { CAPTURE_NOT_YET_VISIBLE, eventAgreesWithReadback } from "../src/webhooks/processor.ts";
import { EventSchema, summarizeEvent } from "../src/webhooks/event.ts";
import { capturePosts } from "./fake-paypal.ts";
import { captureEvent, capturedAtPayPalUnknownLocally, deliver, orderEvent, setupWebhook, type Setup } from "./helpers/webhook-fixtures.ts";

function clock() {
  let t = Date.now();
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

async function stageEvent(s: Setup, e: { id: string }) {
  const r = await deliver(s, e);
  expect(r.status).toBe(200);
  await s.svc.processor.drain();
  return s.svc.inbox.getEvent(e.id)!;
}

describe("stale readback after a verified capture event", () => {
  it("R1 GET without the capture -> retryable_failure (not disagreed); later consistent GET -> processed + captured; zero extra capture POSTs", async () => {
    const c = clock();
    const s = await setupWebhook({ now: c.now, processor: { baseBackoffMs: 50, maxAttempts: 5 } });
    const o = await capturedAtPayPalUnknownLocally(s);
    const posts = capturePosts(s.fake).length;
    s.fake.staleCaptureGets = 1;
    const e = captureEvent({ orderId: o.orderId, captureId: o.captureId, customId: o.intentId });
    let row = await stageEvent(s, e);
    expect(row.state).toBe("retryable_failure");
    expect(row.outcome).toContain(CAPTURE_NOT_YET_VISIBLE);
    expect(s.store.getAttemptByOrderId(o.orderId)!.state).toBe("uncertain"); // stale read changed nothing

    c.advance(1_000);
    await s.svc.processor.drain();
    row = s.svc.inbox.getEvent(e.id)!;
    expect(row.state).toBe("processed");
    expect(s.store.getAttemptByOrderId(o.orderId)!.state).toBe("captured");
    expect(capturePosts(s.fake)).toHaveLength(posts);
    s.store.close();
  });

  it("R2 capture never becomes visible -> bounded retries end in failed (not disagreed); attempt never marked captured", async () => {
    const c = clock();
    const s = await setupWebhook({ now: c.now, processor: { baseBackoffMs: 10, maxAttempts: 2 } });
    const o = await capturedAtPayPalUnknownLocally(s);
    s.fake.staleCaptureGets = 1_000;
    const e = captureEvent({ orderId: o.orderId, captureId: o.captureId, customId: o.intentId });
    await stageEvent(s, e);
    for (let i = 0; i < 5; i++) {
      c.advance(10_000);
      await s.svc.processor.drain();
    }
    const row = s.svc.inbox.getEvent(e.id)!;
    expect(row.state).toBe("failed");
    expect(row.outcome).toMatch(/gave up/);
    expect(s.store.getAttemptByOrderId(o.orderId)!.state).toBe("uncertain");
    s.store.close();
  });

  it.each([
    ["different capture id", { captureId: "CAPWRONG00009" }],
    ["different amount", { value: "0.02" }],
    ["different currency", { currency: "EUR" }],
  ])("R3 genuine contradiction (%s) with the capture visible -> still terminal disagreed", async (_n, over) => {
    const s = await setupWebhook();
    const o = await capturedAtPayPalUnknownLocally(s);
    const row = await stageEvent(s, captureEvent({ orderId: o.orderId, captureId: o.captureId, customId: o.intentId, ...over }));
    expect(row.state).toBe("disagreed");
    expect(row.outcome).not.toContain(CAPTURE_NOT_YET_VISIBLE);
    expect(s.store.getAttemptByOrderId(o.orderId)!.state).toBe("uncertain");
    s.store.close();
  });

  it("R4 a forged custom_id is rejected before any readback, stale or not", async () => {
    const s = await setupWebhook();
    const o = await capturedAtPayPalUnknownLocally(s);
    s.fake.staleCaptureGets = 5;
    const row = await stageEvent(s, captureEvent({ orderId: o.orderId, captureId: o.captureId, customId: "ci_not-ours" }));
    expect(row.state).toBe("disagreed");
    s.store.close();
  });

  it("R5 pure rule: only a capture event against a capture-less readback is 'not yet visible'", () => {
    const sum = (e: unknown) => summarizeEvent(EventSchema.parse(e));
    const base = { id: "ORDER0000000001", status: "APPROVED", purchase_units: [{ custom_id: "ci_x", amount: { currency_code: "USD", value: "1.00" } }] };
    expect(eventAgreesWithReadback(sum(captureEvent({ orderId: "ORDER0000000001", captureId: "CAP1", customId: "ci_x" })), base)).toBe(CAPTURE_NOT_YET_VISIBLE);
    expect(eventAgreesWithReadback(sum(orderEvent({ orderId: "ORDER0000000001", customId: "ci_x" })), base)).toBeNull();
    const withOther = { ...base, purchase_units: [{ ...base.purchase_units[0]!, payments: { captures: [{ id: "CAP2", amount: { currency_code: "USD", value: "1.00" } }] } }] };
    const r = eventAgreesWithReadback(sum(captureEvent({ orderId: "ORDER0000000001", captureId: "CAP1", customId: "ci_x" })), withOther);
    expect(r).not.toBeNull();
    expect(r).not.toBe(CAPTURE_NOT_YET_VISIBLE);
  });
});
