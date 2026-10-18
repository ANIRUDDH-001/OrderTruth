/**
 * Gate 1B processing of VERIFIED events (MOCKED PayPal). A verified event may change payment state
 * only for an order this merchant created, only via an authoritative GET readback, and only when
 * the event's identity/money claims agree with that readback. Webhooks never cause a capture.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { eventAgreesWithReadback } from "../src/webhooks/processor.ts";
import { summarizeEvent, EventSchema } from "../src/webhooks/event.ts";
import { startWebhookListener } from "../src/webhooks/runtime.ts";
import { capturePosts } from "./fake-paypal.ts";
import { captureEvent, capturedAtPayPalUnknownLocally, deliver, orderEvent, ourOrder, setupWebhook, type Setup } from "./helpers/webhook-fixtures.ts";

const dir = mkdtempSync(join(tmpdir(), "ordertruth-g1b-proc-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const dbFile = (name: string) => join(dir, `${name}-${++n}.sqlite`);

const ev = (s: Setup, id: string) => s.svc.inbox.getEvent(id)!;
const attempt = (s: Setup, orderId: string) => s.store.getAttemptByOrderId(orderId)!;
const getsFor = (s: Setup, orderId: string) => s.fake.calls.filter((c) => c.method === "GET" && c.path.endsWith(orderId));
const webhookReadbacks = (s: Setup) => s.store.db.prepare("SELECT * FROM evidence WHERE operation = 'webhook_readback'").all();

async function accept(s: Setup, e: { id: string }) {
  const r = await deliver(s, e);
  expect(r.status).toBe(200);
  await s.svc.processor.drain();
  return ev(s, e.id);
}

describe("ownership and agreement", () => {
  it("W1 verified event for an order we never created -> foreign, no readback, nothing changes", async () => {
    const s = await setupWebhook();
    const e = captureEvent({ orderId: "FOREIGNORDER0000002", captureId: "FOREIGNCAP00002" });
    const row = await accept(s, e);
    expect(row.state).toBe("foreign");
    expect(getsFor(s, "FOREIGNORDER0000002")).toHaveLength(0);
    expect(s.store.listUnsettled()).toHaveLength(0);
    s.store.close();
  });

  it("W2 verified capture event without a related order id -> foreign", async () => {
    const s = await setupWebhook();
    const e = captureEvent({ orderId: "X", captureId: "CAPNOORDER01" });
    delete (e.resource as { supplementary_data?: unknown }).supplementary_data;
    expect((await accept(s, e)).state).toBe("foreign");
    s.store.close();
  });

  it("W3 verified event for our order but a forged custom_id -> disagreed, no readback, attempt unchanged", async () => {
    const s = await setupWebhook();
    const o = await capturedAtPayPalUnknownLocally(s);
    const before = attempt(s, o.orderId).state;
    const gets = getsFor(s, o.orderId).length;
    const row = await accept(s, captureEvent({ orderId: o.orderId, captureId: o.captureId, customId: "ci_someone-else" }));
    expect(row.state).toBe("disagreed");
    expect(getsFor(s, o.orderId)).toHaveLength(gets);
    expect(attempt(s, o.orderId).state).toBe(before);
    s.store.close();
  });

  it.each([
    ["capture id not in readback", { captureId: "CAPWRONG00001" }],
    ["capture amount differs", { value: "0.01" }],
    ["capture currency differs", { currency: "EUR" }],
  ])("W4 %s -> disagreed after readback; attempt stays uncertain", async (_n, over) => {
    const s = await setupWebhook();
    const o = await capturedAtPayPalUnknownLocally(s);
    expect(attempt(s, o.orderId).state).toBe("uncertain");
    const row = await accept(s, captureEvent({ orderId: o.orderId, captureId: o.captureId, customId: o.intentId, ...over }));
    expect(row.state).toBe("disagreed");
    expect(row.outcome).toMatch(/^readback disagrees/);
    expect(attempt(s, o.orderId).state).toBe("uncertain");
    expect(webhookReadbacks(s)).toHaveLength(1); // the readback itself is evidence
    s.store.close();
  });

  it("W5 agreeing PAYMENT.CAPTURE.COMPLETED settles an uncertain attempt to captured by readback, with zero capture POSTs", async () => {
    const s = await setupWebhook();
    const o = await capturedAtPayPalUnknownLocally(s);
    const posts = capturePosts(s.fake).length;
    const row = await accept(s, captureEvent({ orderId: o.orderId, captureId: o.captureId, customId: o.intentId }));
    expect(row.state).toBe("processed");
    expect(row.attempt_id).toBe(attempt(s, o.orderId).id);
    expect(attempt(s, o.orderId).state).toBe("captured");
    expect(capturePosts(s.fake)).toHaveLength(posts);
    expect(webhookReadbacks(s)).toHaveLength(1);
    s.store.close();
  });

  it("W6 CHECKOUT.ORDER.APPROVED: readback moves awaiting -> approved; never captures", async () => {
    const s = await setupWebhook();
    const o = await ourOrder(s);
    s.fake.approve(o.orderId);
    const row = await accept(s, orderEvent({ orderId: o.orderId, customId: o.intentId }));
    expect(row.state).toBe("processed");
    expect(attempt(s, o.orderId).state).toBe("approved");
    expect(capturePosts(s.fake)).toHaveLength(0);
    s.store.close();
  });

  it("W7 APPROVED event while PayPal still says CREATED -> processed, but state follows readback (no approval)", async () => {
    const s = await setupWebhook();
    const o = await ourOrder(s);
    const row = await accept(s, orderEvent({ orderId: o.orderId, customId: o.intentId }));
    expect(row.state).toBe("processed");
    expect(attempt(s, o.orderId).state).toBe("awaiting_buyer_approval");
    s.store.close();
  });

  it("W8 unhandled event types are stored and ignored without a readback", async () => {
    const s = await setupWebhook();
    const o = await ourOrder(s);
    const e = { ...orderEvent({ orderId: o.orderId }), event_type: "CUSTOMER.DISPUTE.CREATED" };
    expect((await accept(s, e)).state).toBe("ignored");
    expect(getsFor(s, o.orderId)).toHaveLength(0);
    s.store.close();
  });

  it("W9 readback agreement function: unit cases", () => {
    const sum = (e: unknown) => summarizeEvent(EventSchema.parse(e));
    const raw = { id: "ORD1ABCDEFGH", status: "COMPLETED", purchase_units: [{ custom_id: "ci_1", amount: { currency_code: "USD", value: "1.00" }, payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } }] } }] };
    expect(eventAgreesWithReadback(sum(captureEvent({ orderId: "ORD1ABCDEFGH", captureId: "CAP1", customId: "ci_1", status: "PENDING" })), raw)).toBeNull(); // status may differ
    expect(eventAgreesWithReadback(sum(captureEvent({ orderId: "ORD2ABCDEFGH", captureId: "CAP1" })), raw)).toMatch(/order id/);
    expect(eventAgreesWithReadback(sum(captureEvent({ orderId: "ORD1ABCDEFGH", captureId: "CAP1", customId: "ci_2" })), raw)).toMatch(/custom_id/);
    expect(eventAgreesWithReadback(sum(captureEvent({ orderId: "ORD1ABCDEFGH", captureId: "CAP1" })), { ...raw, purchase_units: [...raw.purchase_units, ...raw.purchase_units] })).toMatch(/purchase units/);
    expect(eventAgreesWithReadback(sum(orderEvent({ orderId: "ORD1ABCDEFGH", value: "2.00" })), raw)).toMatch(/order amount/);
  });
});

describe("ordering, duplicates and retries", () => {
  it("O1 out of order: COMPLETED first, then a late PENDING and a late APPROVED -> captured stays captured", async () => {
    const s = await setupWebhook();
    const o = await capturedAtPayPalUnknownLocally(s);
    await accept(s, captureEvent({ orderId: o.orderId, captureId: o.captureId, customId: o.intentId }));
    expect(attempt(s, o.orderId).state).toBe("captured");
    const late1 = await accept(s, captureEvent({ orderId: o.orderId, captureId: o.captureId, customId: o.intentId, status: "PENDING" }));
    const late2 = await accept(s, orderEvent({ orderId: o.orderId, customId: o.intentId }));
    expect(late1.state).toBe("processed");
    expect(late2.state).toBe("processed");
    expect(attempt(s, o.orderId).state).toBe("captured");
    expect(capturePosts(s.fake)).toHaveLength(1); // only the original checkout capture
    s.store.close();
  });

  it("O2 a DENIED event cannot override a readback that shows COMPLETED", async () => {
    const s = await setupWebhook();
    const o = await capturedAtPayPalUnknownLocally(s);
    const row = await accept(s, captureEvent({ orderId: o.orderId, captureId: o.captureId, customId: o.intentId, status: "DENIED" }));
    expect(row.state).toBe("processed");
    expect(attempt(s, o.orderId).state).toBe("captured");
    s.store.close();
  });

  it("O3 readback failure -> retryable_failure with backoff; later attempt processes it", async () => {
    let now = Date.now();
    const s = await setupWebhook({ now: () => now });
    const o = await capturedAtPayPalUnknownLocally(s);
    s.fake.faults = { get: "500" };
    const e = captureEvent({ orderId: o.orderId, captureId: o.captureId, customId: o.intentId });
    const row = await accept(s, e);
    expect(row.state).toBe("retryable_failure");
    expect(row.next_attempt_at_ms).toBe(now + 5_000);
    s.fake.faults = {};
    await s.svc.processor.drain();
    expect(ev(s, e.id).state).toBe("retryable_failure"); // not due yet
    now += 5_001;
    await s.svc.processor.drain();
    expect(ev(s, e.id).state).toBe("processed");
    expect(ev(s, e.id).process_attempts).toBe(2);
    expect(attempt(s, o.orderId).state).toBe("captured");
    s.store.close();
  });

  it("O4 persistent readback failure -> failed after maxAttempts, with exponential backoff", async () => {
    let now = Date.now();
    const s = await setupWebhook({ now: () => now, processor: { maxAttempts: 3 } });
    const o = await capturedAtPayPalUnknownLocally(s);
    s.fake.faults = { get: "500" };
    const e = captureEvent({ orderId: o.orderId, captureId: o.captureId, customId: o.intentId });
    await accept(s, e);
    const gaps: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = ev(s, e.id);
      if (r.state !== "retryable_failure") break;
      gaps.push(r.next_attempt_at_ms - now);
      now = r.next_attempt_at_ms;
      await s.svc.processor.drain();
    }
    expect(gaps).toEqual([5_000, 10_000, 20_000]);
    expect(ev(s, e.id).state).toBe("failed");
    expect(attempt(s, o.orderId).state).toBe("uncertain"); // nothing invented locally
    s.store.close();
  });

  it("O5 a stale lease holder cannot overwrite the result of the newer lease", async () => {
    let now = Date.now();
    const s = await setupWebhook({ now: () => now, processor: { leaseMs: 1_000 } });
    const e = captureEvent({ orderId: "FOREIGNORDER0000003", captureId: "FOREIGNCAP00003" });
    // Deliver without letting the kicked processor run: take the lease ourselves first.
    s.svc.processor.drain = async () => 0;
    await deliver(s, e);
    const lease1 = s.svc.inbox.claimNext(now, 1_000)!;
    now += 1_001;
    const lease2 = s.svc.inbox.claimNext(now, 1_000)!;
    expect(lease2.event_id).toBe(lease1.event_id);
    expect(lease2.process_attempts).toBe(2);
    expect(s.svc.inbox.finishEvent(e.id, lease1.process_attempts, "processed", { outcome: "stale" })).toBe(false);
    expect(s.svc.inbox.finishEvent(e.id, lease2.process_attempts, "foreign", { outcome: "current" })).toBe(true);
    expect(ev(s, e.id).state).toBe("foreign");
    expect(() => s.store.db.prepare("UPDATE webhook_events SET state = 'processed' WHERE event_id = ?").run(e.id)).toThrow(); // terminal
    s.store.close();
  });
});

describe("restart recovery", () => {
  it("X1 committed-but-unprocessed and lease-expired events are processed at startup; open deliveries are abandoned", async () => {
    const path = dbFile("restart");
    const a = await setupWebhook({ path });
    const o = await capturedAtPayPalUnknownLocally(a);
    a.svc.processor.drain = async () => 0; // "crash" before any processing
    const e1 = captureEvent({ orderId: o.orderId, captureId: o.captureId, customId: o.intentId });
    const e2 = captureEvent({ orderId: "FOREIGNORDER0000004", captureId: "FOREIGNCAP00004" });
    await deliver(a, e1);
    await deliver(a, e2);
    a.svc.inbox.claimNext(Date.now() - 120_000, 60_000); // e1 leased by a process that died; lease already expired
    a.svc.inbox.recordDelivery({ claimedEventId: "WH-OPENATCRASH1", claimedEventType: "A.B", bodySha256: "0".repeat(64), bodyBytes: 1, correlationId: "c", nowMs: Date.now() - 60_000 });
    a.store.close();

    const b = await setupWebhook({ path, fake: a.fake });
    const started = await startWebhookListener(b.svc, { port: 0, intervalMs: 0 });
    try {
      expect(started.abandoned).toBe(1);
      expect(b.svc.inbox.getEvent(e1.id)!.state).toBe("processed");
      expect(b.svc.inbox.getEvent(e1.id)!.process_attempts).toBe(2);
      expect(b.svc.inbox.getEvent(e2.id)!.state).toBe("foreign");
      expect(b.store.getAttemptByOrderId(o.orderId)!.state).toBe("captured");
      expect(capturePosts(b.fake)).toHaveLength(1);
    } finally {
      started.stop();
      await b.svc.app.close();
      b.store.close();
    }
  });
});
