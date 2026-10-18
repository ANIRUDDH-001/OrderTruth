/**
 * Gate 1B webhook intake, adversarial. Every PayPal response here comes from the in-memory
 * FakePayPal (MOCKED). The fake's "signed" mode returns SUCCESS only when an HMAC over
 * transmission_id|time|webhook_id|crc32(embedded raw event) matches, which proves the postback
 * carries the configured webhook id and the request body byte-for-byte.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it, vi } from "vitest";
import { WebhookInbox } from "../src/webhooks/inbox.ts";
import { WebhookIntake } from "../src/webhooks/intake.ts";
import type { VerifyResult, WebhookVerifier } from "../src/webhooks/verifier.ts";
import { silentLogger } from "./fake-paypal.ts";
import { captureEvent, deliver, newEventId, orderEvent, ourOrder, post, setupWebhook, signedHeaders, TEST_WEBHOOK_ID, type Setup } from "./helpers/webhook-fixtures.ts";

const dir = mkdtempSync(join(tmpdir(), "ordertruth-g1b-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const dbFile = (name: string) => join(dir, `${name}-${++n}.sqlite`);

const deliveries = (s: Setup) => s.svc.inbox.listDeliveries();
const events = (s: Setup) => s.svc.inbox.listEvents();
const verifiedEvidence = (s: Setup) => s.store.db.prepare("SELECT * FROM evidence WHERE evidence_class = 'PAYPAL_VERIFIED_WEBHOOK'").all();
const dumpDb = (s: Setup) =>
  (s.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map((t) => JSON.stringify(s.store.db.prepare(`SELECT * FROM "${t.name}"`).all()))
    .join("\n");

async function foreignEvent() {
  return captureEvent({ orderId: "FOREIGNORDER0000001", captureId: "FOREIGNCAP00001" });
}

describe("verification and acceptance", () => {
  it("V1 valid delivery: postback carries configured webhook id + exact raw bytes; 200 only after the event row and evidence commit", async () => {
    const s = await setupWebhook();
    const ev = await foreignEvent();
    // Unusual but valid formatting: any re-serialization would change the bytes and fail the fake signature.
    const raw = JSON.stringify(ev, null, 3).replace('"summary": "', '"summary": "caf\\u00e9 ');
    const r = await post(s, raw, signedHeaders(raw));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, result: "accepted" });
    expect(s.fake.verifyCalls).toHaveLength(1);
    expect(s.fake.verifyCalls[0]!.rawEvent).toBe(raw);
    expect(s.fake.verifyCalls[0]!.webhookId).toBe(TEST_WEBHOOK_ID);
    expect(deliveries(s).map((d) => d.state)).toEqual(["verified"]);
    expect(events(s)).toHaveLength(1);
    expect(events(s)[0]!.event_id).toBe(ev.id);
    expect(verifiedEvidence(s)).toHaveLength(1);
    s.store.close();
  });

  it("V2 webhook id comes from config, never from the request", async () => {
    const s = await setupWebhook();
    const ev = await foreignEvent();
    const raw = JSON.stringify({ ...ev, webhook_id: "ATTACKERWEBHOOK" });
    const r = await post(s, raw, { ...signedHeaders(raw, { webhookId: "ATTACKERWEBHOOK" }), "paypal-webhook-id": "ATTACKERWEBHOOK" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("signature_invalid");
    expect(s.fake.verifyCalls[0]!.webhookId).toBe(TEST_WEBHOOK_ID);
    expect(events(s)).toHaveLength(0);
    s.store.close();
  });

  it.each([
    ["wrong signature", (raw: string) => ({ raw, h: signedHeaders(raw, { sig: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }) })],
    ["body tampered after signing", (raw: string) => ({ raw: raw.replace('"1.00"', '"9.00"'), h: signedHeaders(raw) })],
    ["signed for another transmission id", (raw: string) => ({ raw, h: { ...signedHeaders(raw), "paypal-transmission-id": "a1b2c3d4-0000-0000-0000-000000000000" } })],
  ])("V3 %s -> 400 signature_invalid; delivery rejected; no event, no evidence, no dedup key", async (_name, mk) => {
    const s = await setupWebhook();
    const { raw, h } = mk(JSON.stringify(await foreignEvent()));
    const r = await post(s, raw, h);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("signature_invalid");
    expect(deliveries(s).map((d) => [d.state, d.reason])).toEqual([["rejected", "signature_invalid"]]);
    expect(events(s)).toHaveLength(0);
    expect(verifiedEvidence(s)).toHaveLength(0);
    s.store.close();
  });

  it.each(["paypal-transmission-id", "paypal-transmission-time", "paypal-transmission-sig", "paypal-cert-url", "paypal-auth-algo"])(
    "V4 missing %s -> 400 before any postback",
    async (header) => {
      const s = await setupWebhook();
      const raw = JSON.stringify(await foreignEvent());
      const r = await post(s, raw, signedHeaders(raw, { omit: [header] }));
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("missing_headers");
      expect(s.fake.verifyCalls).toHaveLength(0);
      expect(deliveries(s)[0]!.state).toBe("rejected");
      s.store.close();
    },
  );

  it.each([
    ["attacker cert host", { certUrl: "https://evil.example/v1/notifications/certs/CERT-1" }, "cert_url_not_allowed"],
    ["look-alike cert host", { certUrl: "https://api-m.sandbox.paypal.com.evil.example/v1/notifications/certs/C" }, "cert_url_not_allowed"],
    ["production cert host", { certUrl: "https://api.paypal.com/v1/notifications/certs/CERT-1" }, "cert_url_not_allowed"],
    ["http cert url", { certUrl: "http://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1" }, "cert_url_not_allowed"],
    ["unsupported algorithm", { authAlgo: "SHA1withRSA" }, "unsupported_auth_algo"],
    ["numeric-only transmission id", { tid: "123456789" }, "invalid_transmission_id"],
    ["non-ISO transmission time", { time: "Mon, 19 Oct 2026 10:00:00 GMT" }, "invalid_transmission_time"],
  ])("V5 %s -> 400 %s, no postback and no certificate download", async (_n, h, reason) => {
    const s = await setupWebhook();
    const spy = vi.spyOn(globalThis, "fetch");
    const raw = JSON.stringify(await foreignEvent());
    const r = await post(s, raw, signedHeaders(raw, h));
    expect(r.status).toBe(400);
    expect(deliveries(s)[0]!.reason).toBe(reason);
    expect(s.fake.verifyCalls).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    s.store.close();
  });

  it("V6 an allowlisted cert URL is forwarded to PayPal but never fetched by OrderTruth", async () => {
    const s = await setupWebhook();
    const spy = vi.spyOn(globalThis, "fetch");
    const r = await deliver(s, await foreignEvent());
    expect(r.status).toBe(200);
    expect(spy).not.toHaveBeenCalled(); // all provider traffic goes through the injected fake
    expect(new Set(s.fake.calls.map((c) => c.origin))).toEqual(new Set(["https://api-m.sandbox.paypal.com"]));
    expect(s.fake.calls.some((c) => c.path.includes("/certs/"))).toBe(false);
    spy.mockRestore();
    s.store.close();
  });
});

describe("transmission window and replay", () => {
  it("R1 expired transmission (2 h old) -> 400 transmission_expired, no postback", async () => {
    const s = await setupWebhook();
    const r = await deliver(s, await foreignEvent(), { time: new Date(Date.now() - 2 * 3600_000).toISOString() });
    expect(r.status).toBe(400);
    expect(deliveries(s)[0]!.reason).toBe("transmission_expired");
    expect(s.fake.verifyCalls).toHaveLength(0);
    s.store.close();
  });

  it("R2 transmission time 10 min in the future -> 400 transmission_in_future", async () => {
    const s = await setupWebhook();
    const r = await deliver(s, await foreignEvent(), { time: new Date(Date.now() + 600_000).toISOString() });
    expect(r.status).toBe(400);
    expect(deliveries(s)[0]!.reason).toBe("transmission_in_future");
    s.store.close();
  });

  it("R3 exact replay inside the window: PayPal says SUCCESS again, stored as duplicate, never processed twice", async () => {
    const s = await setupWebhook();
    const raw = JSON.stringify(await foreignEvent());
    const h = signedHeaders(raw);
    expect((await post(s, raw, h)).body.result).toBe("accepted");
    await s.svc.processor.drain();
    expect((await post(s, raw, h)).body.result).toBe("duplicate");
    await s.svc.processor.drain();
    expect(deliveries(s).map((d) => d.state)).toEqual(["verified", "duplicate"]);
    expect(events(s)).toHaveLength(1);
    expect(events(s)[0]!.deliveries).toBe(2);
    expect(events(s)[0]!.process_attempts).toBe(1);
    s.store.close();
  });

  it("R4 the same replay after the window -> 400 transmission_expired", async () => {
    let now = Date.now();
    const s = await setupWebhook({ now: () => now });
    const raw = JSON.stringify(await foreignEvent());
    const h = signedHeaders(raw, { time: new Date(now).toISOString() });
    expect((await post(s, raw, h)).status).toBe(200);
    now += 3600_001;
    const r = await post(s, raw, h);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("transmission_expired");
    s.store.close();
  });
});

describe("malformed and oversized input", () => {
  it.each([
    ["not JSON", "{not json", "malformed_json"],
    ["JSON array", "[1,2]", "invalid_event_structure"],
    ["missing id", JSON.stringify({ event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} }), "invalid_event_structure"],
    ["bad id format", JSON.stringify({ id: "WH-'; DROP TABLE x;--", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} }), "invalid_event_structure"],
    ["resource not an object", JSON.stringify({ id: "WH-ABCDEF123", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: "x" }), "invalid_event_structure"],
    ["empty body", "", "malformed_json"],
  ])("M1 %s -> 400 %s, no postback", async (_n, raw, error) => {
    const s = await setupWebhook();
    const r = await post(s, raw, signedHeaders(raw));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(error);
    expect(s.fake.verifyCalls).toHaveLength(0);
    expect(events(s)).toHaveLength(0);
    s.store.close();
  });

  it("M2 invalid UTF-8 bytes -> 400 malformed_json", async () => {
    const s = await setupWebhook();
    const raw = Buffer.concat([Buffer.from('{"id":"WH-ABCDEF1234","event_type":"A.B","resource":{},"x":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
    const r = await post(s, raw, signedHeaders(raw.toString("latin1")));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("malformed_json");
    s.store.close();
  });

  it("M3 oversized body -> 413 before any parsing, storage or postback", async () => {
    const s = await setupWebhook({ env: { WEBHOOK_MAX_BODY_BYTES: "2048" } });
    const ev = { ...(await foreignEvent()), pad: "x".repeat(4000) };
    const raw = JSON.stringify(ev);
    const r = await post(s, raw, signedHeaders(raw));
    expect(r.status).toBe(413);
    expect(deliveries(s)).toHaveLength(0);
    expect(s.fake.verifyCalls).toHaveLength(0);
    s.store.close();
  });

  it("M4 default limit is 64 KiB", async () => {
    const s = await setupWebhook();
    expect(s.config.webhook.maxBodyBytes).toBe(65536);
    const raw = JSON.stringify({ ...(await foreignEvent()), pad: "x".repeat(70_000) });
    expect((await post(s, raw, signedHeaders(raw))).status).toBe(413);
    s.store.close();
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"])("M5 content-type %s -> 415", async (ct) => {
    const s = await setupWebhook();
    const raw = JSON.stringify(await foreignEvent());
    const r = await post(s, raw, { ...signedHeaders(raw), "content-type": ct });
    expect(r.status).toBe(415);
    expect(deliveries(s)).toHaveLength(0);
    s.store.close();
  });
});

describe("verification unavailable -> retryable 503, never success", () => {
  it.each(["hang", "hang_ignoring_abort"] as const)("T1 postback %s -> 503 within the configured timeout", async (mode) => {
    const s = await setupWebhook({ env: { WEBHOOK_VERIFY_TIMEOUT_MS: "500" } });
    s.fake.webhookVerify = mode;
    const t0 = Date.now();
    const r = await deliver(s, await foreignEvent());
    const took = Date.now() - t0;
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("verification_unavailable");
    expect(took).toBeLessThan(2500);
    expect(deliveries(s)[0]!.state).toBe("retryable_failure");
    expect(events(s)).toHaveLength(0);
    s.store.close();
  });

  it.each(["500", "400", "malformed", "network"] as const)("T2 postback %s -> 503 retryable, no event", async (mode) => {
    const s = await setupWebhook();
    s.fake.webhookVerify = mode;
    const r = await deliver(s, await foreignEvent());
    expect(r.status).toBe(503);
    expect(deliveries(s)[0]!.state).toBe("retryable_failure");
    expect(events(s)).toHaveLength(0);
    s.store.close();
  });

  it("T3 OAuth token failure during verification -> 503", async () => {
    const s = await setupWebhook();
    s.fake.faults = { token: "500" };
    expect((await deliver(s, await foreignEvent())).status).toBe(503);
    s.store.close();
  });

  it("T4 a retry after an unavailable verification is accepted (the failure did not poison the event id)", async () => {
    const s = await setupWebhook();
    const ev = await foreignEvent();
    s.fake.webhookVerify = "500";
    expect((await deliver(s, ev)).status).toBe(503);
    s.fake.webhookVerify = "signed";
    expect((await deliver(s, ev)).body.result).toBe("accepted");
    expect(deliveries(s).map((d) => d.state)).toEqual(["retryable_failure", "verified"]);
    s.store.close();
  });

  it("T5 verifier concurrency cap -> 503 verifier_busy instead of unbounded postbacks", async () => {
    const s = await setupWebhook();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: WebhookVerifier = { verify: async (): Promise<VerifyResult> => (await gate, { status: "SUCCESS", durationMs: 1, debugId: null }) };
    const intake = new WebhookIntake(s.svc.inbox, slow, { webhookId: TEST_WEBHOOK_ID, maxTransmissionAgeMs: 3600_000, maxFutureSkewMs: 300_000, maxConcurrentVerifications: 2, log: silentLogger() });
    const send = async () => {
      const raw = JSON.stringify(await foreignEvent());
      return intake.receive(Buffer.from(raw), signedHeaders(raw), `corr_${Math.random()}`);
    };
    const p1 = send();
    const p2 = send();
    const third = await send();
    expect(third.status).toBe(503);
    expect(third.body.error).toBe("verifier_busy");
    release();
    expect((await p1).status).toBe(200);
    expect((await p2).status).toBe(200);
    s.store.close();
  });
});

describe("dedup and poisoning", () => {
  it("D1 the same event id in different transmissions -> one event, one processing, deliveries counted", async () => {
    const s = await setupWebhook();
    const ev = await foreignEvent();
    for (let i = 0; i < 3; i++) await deliver(s, ev);
    await s.svc.processor.drain();
    expect(deliveries(s).map((d) => d.state)).toEqual(["verified", "duplicate", "duplicate"]);
    expect(events(s)).toHaveLength(1);
    expect(events(s)[0]!.deliveries).toBe(3);
    expect(events(s)[0]!.process_attempts).toBe(1);
    expect(verifiedEvidence(s)).toHaveLength(1);
    s.store.close();
  });

  it("D2 20 concurrent deliveries of one event (one process) -> exactly one accepted", async () => {
    const s = await setupWebhook();
    const ev = await foreignEvent();
    const rs = await Promise.all(Array.from({ length: 20 }, () => deliver(s, ev)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.filter((r) => r.body.result === "accepted")).toHaveLength(1);
    expect(events(s)).toHaveLength(1);
    expect(events(s)[0]!.deliveries).toBe(20);
    s.store.close();
  });

  it("D3 concurrent deliveries through two independent SQLite connections -> one event row", async () => {
    const path = dbFile("two-conn");
    const a = await setupWebhook({ path });
    const b = await setupWebhook({ path, fake: a.fake });
    const ev = await foreignEvent();
    const rs = await Promise.all([...Array.from({ length: 8 }, () => deliver(a, ev)), ...Array.from({ length: 8 }, () => deliver(b, ev))]);
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.filter((r) => r.body.result === "accepted")).toHaveLength(1);
    expect(events(a)).toHaveLength(1);
    expect(events(a)[0]!.deliveries).toBe(16);
    a.store.close();
    b.store.close();
  });

  it("D4 an unverified delivery claiming event id X cannot poison X: the genuine event is accepted later", async () => {
    const s = await setupWebhook();
    const ev = await foreignEvent();
    const forged = JSON.stringify(ev);
    await post(s, forged, signedHeaders(forged, { sig: "Zm9yZ2VkLXNpZ25hdHVyZS12YWx1ZQ==" }));
    await post(s, "{broken", { ...signedHeaders("{broken") }); // no claimed id at all
    s.fake.webhookVerify = "500";
    await deliver(s, ev);
    s.fake.webhookVerify = "signed";
    const r = await deliver(s, ev);
    expect(r.body.result).toBe("accepted");
    const evRow = events(s)[0]!;
    expect(evRow.first_delivery_seq).toBe(deliveries(s).at(-1)!.seq);
    expect(deliveries(s).map((d) => d.state)).toEqual(["rejected", "rejected", "retryable_failure", "verified"]);
    s.store.close();
  });

  it("D5 the DB itself refuses an event row that is not backed by a verified delivery of the same id", async () => {
    const s = await setupWebhook();
    const ev = await foreignEvent();
    const raw = JSON.stringify(ev);
    await post(s, raw, signedHeaders(raw, { sig: "Zm9yZ2VkLXNpZ25hdHVyZS12YWx1ZQ==" }));
    const seq = deliveries(s)[0]!.seq;
    const ins = (state: string, s2: number) => () =>
      s.store.db
        .prepare("INSERT INTO webhook_events (event_id, event_type, first_delivery_seq, state, summary_json, created_at, updated_at) VALUES (?, 'A.B', ?, ?, '{}', 'x', 'x')")
        .run(ev.id, s2, state);
    expect(ins("verified_pending", seq)).toThrow(); // delivery was rejected
    expect(ins("processed", seq)).toThrow(); // must start verified_pending
    expect(() => s.store.db.prepare("UPDATE webhook_deliveries SET state = 'verified' WHERE seq = ?").run(seq)).toThrow(); // rejected is terminal
    expect(() => s.store.db.prepare("DELETE FROM webhook_deliveries").run()).toThrow();
    expect(() => s.store.db.prepare("INSERT INTO webhook_deliveries (state, body_sha256, body_bytes, correlation_id, received_at_ms, created_at, updated_at) VALUES ('verified', 'x', 1, 'c', 1, 'x', 'x')").run()).toThrow();
    expect(events(s)).toHaveLength(0);
    s.store.close();
  });

  it("D6 an unverified event about our order never touches payment state or calls PayPal", async () => {
    const s = await setupWebhook();
    const o = await ourOrder(s);
    s.fake.approve(o.orderId);
    const before = JSON.stringify(s.store.getAttemptByOrderId(o.orderId));
    const callsBefore = s.fake.calls.length;
    const raw = JSON.stringify(captureEvent({ orderId: o.orderId, captureId: o.captureId, customId: o.intentId }));
    expect((await post(s, raw, signedHeaders(raw, { sig: "Zm9yZ2VkLXNpZ25hdHVyZS12YWx1ZQ==" }))).status).toBe(400);
    await s.svc.processor.drain();
    expect(JSON.stringify(s.store.getAttemptByOrderId(o.orderId))).toBe(before);
    expect(s.fake.calls.slice(callsBefore).some((c) => c.path.startsWith("/v2/"))).toBe(false);
    s.store.close();
  });
});

describe("durability: never 2xx unless durably safe", () => {
  it("P1 real SQLITE_BUSY when recording the delivery -> 503, nothing claimed; redelivery after the lock -> accepted", async () => {
    const path = dbFile("busy-record");
    const s = await setupWebhook({ path, busyTimeoutMs: 50 });
    const ev = await foreignEvent();
    const locker = new DatabaseSync(path);
    locker.exec("BEGIN IMMEDIATE");
    const r = await deliver(s, ev);
    locker.exec("ROLLBACK");
    locker.close();
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("inbox_unavailable");
    expect(s.fake.verifyCalls).toHaveLength(0);
    expect(deliveries(s)).toHaveLength(0);
    expect((await deliver(s, ev)).body.result).toBe("accepted");
    s.store.close();
  });

  it("P2 real SQLITE_BUSY after PayPal SUCCESS, before the commit -> 503 persist_failed (no false ack); redelivery accepted", async () => {
    const path = dbFile("busy-accept");
    let locker: DatabaseSync | null = null;
    const s = await setupWebhook({
      path,
      busyTimeoutMs: 50,
      afterVerify: () => {
        if (!locker) return;
        locker.exec("BEGIN IMMEDIATE");
      },
    });
    const ev = await foreignEvent();
    locker = new DatabaseSync(path);
    const r = await deliver(s, ev);
    locker.exec("ROLLBACK");
    locker.close();
    locker = null;
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("persist_failed");
    expect(events(s)).toHaveLength(0);
    expect(deliveries(s)[0]!.state).toBe("received_unverified"); // close also failed under the lock; swept as abandoned at restart
    expect(s.svc.inbox.abandonStale(Date.now())).toBe(1);
    const again = await deliver(s, ev);
    expect(again.body.result).toBe("accepted");
    expect(deliveries(s).map((d) => d.state)).toEqual(["abandoned", "verified"]);
    s.store.close();
  });

  it("P3 injected failure inside the accept transaction rolls back completely", async () => {
    const s = await setupWebhook();
    const ev = await foreignEvent();
    const orig = s.store.appendEvidence.bind(s.store);
    s.store.appendEvidence = () => {
      throw new Error("injected evidence write failure");
    };
    const r = await deliver(s, ev);
    s.store.appendEvidence = orig;
    expect(r.status).toBe(503);
    expect(events(s)).toHaveLength(0);
    expect(deliveries(s)[0]!.state).toBe("retryable_failure");
    expect((await deliver(s, ev)).body.result).toBe("accepted");
    s.store.close();
  });

  it("P4 an unexpected exception in the handler -> 503, never 200", async () => {
    const s = await setupWebhook();
    s.svc.intake.receive = async () => {
      throw new Error("boom");
    };
    const r = await deliver(s, await foreignEvent());
    expect(r.status).toBe(503);
    s.store.close();
  });
});

describe("minimisation and redaction", () => {
  it("S1 no payer/payee PII, signature, or raw body is stored or logged", async () => {
    const s = await setupWebhook();
    const o = await ourOrder(s);
    const ev = orderEvent({ orderId: o.orderId, customId: o.intentId });
    const raw = JSON.stringify(ev);
    const h = signedHeaders(raw);
    await post(s, raw, h);
    await deliver(s, captureEvent({ orderId: o.orderId, captureId: o.captureId, customId: o.intentId }));
    await s.svc.processor.drain();
    const db = dumpDb(s);
    const logs = s.log.lines.join("\n");
    for (const needle of ["buyer-pii@example.com", "Pii Street", "PAYERPII0001", "seller-pii@example.com", "buyer@example.com", "seller@example.com", h["paypal-transmission-sig"]!, "test-client-secret-SHOULD-NOT-LEAK", TEST_WEBHOOK_ID, "A21AAfake"]) {
      expect(db.includes(needle), `db contains ${needle}`).toBe(false);
      expect(logs.includes(needle), `logs contain ${needle}`).toBe(false);
    }
    expect(db.includes(raw)).toBe(false);
    s.store.close();
  });

  it("S2 inbound x-correlation-id is ignored (ids are server-generated)", async () => {
    const s = await setupWebhook();
    const raw = JSON.stringify(await foreignEvent());
    await post(s, raw, { ...signedHeaders(raw), "x-correlation-id": "attacker-controlled-correlation" });
    expect(deliveries(s)[0]!.correlation_id).toMatch(/^wh_[0-9a-f-]{36}$/);
    s.store.close();
  });

  it("S3 every trust transition is audited by the database", async () => {
    const s = await setupWebhook();
    const ev = await foreignEvent();
    const raw = JSON.stringify(ev);
    await post(s, raw, signedHeaders(raw, { sig: "Zm9yZ2VkLXNpZ25hdHVyZS12YWx1ZQ==" }));
    await deliver(s, ev);
    await deliver(s, ev);
    await s.svc.processor.drain();
    const audit = s.svc.inbox.listAudit().map((a) => `${a.subject}:${a.from_state ?? "-"}>${a.to_state}`);
    // Processing is kicked right after the first commit, so only the multiset is fixed; per-subject order is checked below.
    expect([...audit].sort()).toEqual([
      "delivery:->received_unverified",
      "delivery:received_unverified>rejected",
      "delivery:->received_unverified",
      "delivery:received_unverified>verified",
      "event:->verified_pending",
      "delivery:->received_unverified",
      "delivery:received_unverified>duplicate",
      "event:verified_pending>processing",
      "event:processing>foreign",
    ].sort());
    expect(audit.filter((a) => a.startsWith("event:"))).toEqual(["event:->verified_pending", "event:verified_pending>processing", "event:processing>foreign"]);
    s.store.close();
  });
});

it("an id that only looks like an event id in an unverified body is bounded before storage", async () => {
  const s = await setupWebhook();
  const raw = JSON.stringify({ id: "x".repeat(5000), event_type: "<script>", resource: {} });
  await post(s, raw, signedHeaders(raw));
  const d = deliveries(s)[0]!;
  expect(d.claimed_event_id).toBeNull();
  expect(d.claimed_event_type).toBeNull();
  expect(newEventId()).toMatch(/^WH-/);
  s.store.close();
});
