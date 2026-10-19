/**
 * Gate 1B hardening before any live tunnel (MOCKED PayPal throughout):
 *   R  pre-persistence rate limit + stored-unverified ceiling (unauthenticated growth is bounded)
 *   T  the 1 h transmission-time window vs a genuinely signed but delayed redelivery
 *   S  read-only webhook status report
 *   W  read-only webhook registration check
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";
import { PayPalClient } from "../src/paypal/client.ts";
import { TokenBucket } from "../src/webhooks/rate-limit.ts";
import { checkWebhookRegistration } from "../src/webhooks/registration.ts";
import { webhookStatus } from "../src/webhooks/status.ts";
import { FakePayPal, testPaypalConfig } from "./fake-paypal.ts";
import { captureEvent, deliver, ourOrder, post, setupWebhook, signedHeaders, TEST_WEBHOOK_ID, webhookEnv, type Setup } from "./helpers/webhook-fixtures.ts";

const dir = mkdtempSync(join(tmpdir(), "ordertruth-g1b-hard-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const dbFile = () => join(dir, `h-${++n}.sqlite`);

const clock = (start = Date.parse("2026-10-19T00:00:00.000Z")) => {
  const c = { t: start, now: () => c.t, advance: (ms: number) => void (c.t += ms) };
  return c;
};
const rows = (s: Setup) => s.svc.inbox.listDeliveries();
const foreign = () => captureEvent({ orderId: "FOREIGNORDER0000001", captureId: "FOREIGNCAP00001" });
/** Structurally valid, well-formed headers, but a signature PayPal (the fake) rejects. */
const forged = (s: Setup, t: number) => {
  const raw = JSON.stringify(foreign());
  return post(s, raw, signedHeaders(raw, { time: new Date(t).toISOString(), sig: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }));
};
const iso = (t: number) => new Date(t).toISOString();

describe("R token bucket", () => {
  it("R1 allows a burst, then refuses with a Retry-After hint, then refills at the configured rate", () => {
    const c = clock();
    const b = new TokenBucket({ perMinute: 60, burst: 3, now: c.now });
    expect([b.take(), b.take(), b.take()].every((r) => r.ok)).toBe(true);
    const r = b.take();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.retryAfterMs).toBe(1000);
    c.advance(999);
    expect(b.take().ok).toBe(false);
    c.advance(1);
    expect(b.take().ok).toBe(true);
    c.advance(3_600_000);
    expect([b.take(), b.take(), b.take(), b.take()].map((x) => x.ok)).toEqual([true, true, true, false]); // never above burst
  });

  it("R2 rejects a zero rate", () => {
    expect(() => new TokenBucket({ perMinute: 0, burst: 1 })).toThrow();
  });
});

describe("R ingress bounds", () => {
  it("R3 a 200-request unauthenticated flood stores at most `burst` rows and makes at most `burst` postbacks; the rest get 429 + Retry-After, unrecorded", async () => {
    const c = clock();
    const s = await setupWebhook({ now: c.now, env: { WEBHOOK_RATE_BURST: "10", WEBHOOK_RATE_PER_MIN: "60" } });
    const raw = JSON.stringify(foreign());
    const h = signedHeaders(raw, { time: iso(c.t), sig: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
    const rs = await Promise.all(Array.from({ length: 200 }, () => s.svc.app.inject({ method: "POST", url: "/webhooks/paypal", payload: raw, headers: h })));
    const by = (code: number) => rs.filter((r) => r.statusCode === code);
    expect(by(400)).toHaveLength(10);
    expect(by(429)).toHaveLength(190);
    expect(by(429).every((r) => r.headers["retry-after"] === "1" && JSON.parse(r.body).error === "rate_limited")).toBe(true);
    expect(rows(s)).toHaveLength(10);
    expect(s.fake.verifyCalls).toHaveLength(10);
    expect(s.svc.inbox.listEvents()).toHaveLength(0);
    s.store.close();
  });

  it("R4 garbage bodies and oversized bodies are throttled before parsing too", async () => {
    const c = clock();
    const s = await setupWebhook({ now: c.now, env: { WEBHOOK_RATE_BURST: "2" } });
    const big = "x".repeat(200_000);
    const rs = [];
    for (let i = 0; i < 6; i++) rs.push((await post(s, i % 2 ? big : "not json", { "content-type": "application/json" })).status);
    expect(rs.slice(0, 2)).toEqual([400, 413]);
    expect(rs.slice(2)).toEqual([429, 429, 429, 429]);
    expect(rows(s).length).toBeLessThanOrEqual(1); // the 413 never reaches intake; the 400 is the only row
    s.store.close();
  });

  it("R5 off-route noise (404) does not spend the route's tokens and is not stored", async () => {
    const c = clock();
    const s = await setupWebhook({ now: c.now, env: { WEBHOOK_RATE_BURST: "2" } });
    for (let i = 0; i < 100; i++) expect((await s.svc.app.inject({ method: i % 2 ? "GET" : "POST", url: "/api/orders" })).statusCode).toBe(404);
    expect((await deliver(s, foreign(), { time: iso(c.t) })).status).toBe(200);
    expect(rows(s).map((d) => d.state)).toEqual(["verified"]);
    s.store.close();
  });

  it("R6 a genuine delivery caught in a flood gets a retryable non-2xx and nothing is stored; PayPal's later retry is accepted", async () => {
    const c = clock();
    const s = await setupWebhook({ now: c.now, env: { WEBHOOK_RATE_BURST: "5", WEBHOOK_RATE_PER_MIN: "60" } });
    for (let i = 0; i < 5; i++) await forged(s, c.t);
    const ev = foreign();
    const raw = JSON.stringify(ev);
    const first = await post(s, raw, signedHeaders(raw, { time: iso(c.t) }));
    expect(first.status).toBe(429);
    expect(s.svc.inbox.listEvents()).toHaveLength(0);
    expect(rows(s)).toHaveLength(5);
    c.advance(5_000); // PayPal retries a non-2xx later, with a new transmission
    const retry = await post(s, raw, signedHeaders(raw, { time: iso(c.t) }));
    expect(retry.status).toBe(200);
    expect(s.svc.inbox.getEvent(ev.id)?.event_id).toBe(ev.id);
    s.store.close();
  });

  it("R7 the stored-unverified ceiling bounds the inbox absolutely, across restarts; at the ceiling every request is a 503 with no row", async () => {
    const path = dbFile();
    const c = clock();
    const env = { WEBHOOK_RATE_BURST: "1000", WEBHOOK_RATE_PER_MIN: "6000", WEBHOOK_MAX_STORED_UNVERIFIED: "10" };
    const a = await setupWebhook({ path, now: c.now, env });
    const ra = [];
    for (let i = 0; i < 40; i++) ra.push((await forged(a, c.t)).status);
    expect(ra.filter((x) => x === 400)).toHaveLength(10);
    expect(ra.slice(10).every((x) => x === 503)).toBe(true);
    const ev = foreign();
    const genuine = await deliver(a, ev, { time: iso(c.t) });
    expect(genuine).toMatchObject({ status: 503, body: { error: "inbox_ceiling" } }); // retryable, not lost: PayPal redelivers
    a.store.close();

    const b = await setupWebhook({ path, now: c.now, env }); // restart: the ceiling is durable, not in memory
    for (let i = 0; i < 20; i++) expect((await forged(b, c.t)).status).toBe(503);
    expect(rows(b)).toHaveLength(10);
    expect(b.svc.inbox.countStoredUnverified()).toBe(10);
    b.store.close();
  });

  it("R8 verified first deliveries do not count against the ceiling; verified duplicates do", async () => {
    const c = clock();
    const s = await setupWebhook({ now: c.now, env: { WEBHOOK_MAX_STORED_UNVERIFIED: "10", WEBHOOK_RATE_BURST: "1000" } });
    for (let i = 0; i < 12; i++) expect((await deliver(s, foreign(), { time: iso(c.t) })).status).toBe(200);
    expect(s.svc.inbox.countStoredUnverified()).toBe(0);
    const ev = foreign();
    await deliver(s, ev, { time: iso(c.t) });
    for (let i = 0; i < 3; i++) expect((await deliver(s, ev, { time: iso(c.t) })).body.result).toBe("duplicate");
    expect(s.svc.inbox.countStoredUnverified()).toBe(3);
    s.store.close();
  });

  it("R9 log output under a flood is bounded (no line per throttled or 404 request)", async () => {
    const c = clock();
    const s = await setupWebhook({ now: c.now, env: { WEBHOOK_RATE_BURST: "1", WEBHOOK_RATE_PER_MIN: "1" } });
    const lines = (s.log as unknown as { lines: string[] }).lines;
    const before = lines.length;
    for (let i = 0; i < 300; i++) await s.svc.app.inject({ method: "POST", url: "/webhooks/paypal", payload: "{}", headers: { "content-type": "application/json" } });
    for (let i = 0; i < 300; i++) await s.svc.app.inject({ method: "GET", url: "/x" });
    c.advance(10_000); // the suppressed count is written with the first noisy line of the next window
    await s.svc.app.inject({ method: "GET", url: "/x" });
    await s.svc.app.inject({ method: "POST", url: "/webhooks/paypal", payload: "{}", headers: { "content-type": "application/json" } });
    const added = lines.slice(before);
    expect(added.length).toBeLessThan(60);
    expect(added.some((l) => l.includes('"suppressedLines":279') && l.includes("rate_limited"))).toBe(true);
    expect(added.some((l) => l.includes('"suppressedLines":280') && l.includes("not_found"))).toBe(true);
    s.store.close();
  });

  it("R10 ingress config: defaults 60/min, burst 30, ceiling 5000; zero or absurd values fail closed", () => {
    expect(loadConfig(webhookEnv()).webhookIngress).toEqual({ ratePerMinute: 60, rateBurst: 30, maxStoredUnverified: 5000 });
    for (const [k, v] of [
      ["WEBHOOK_RATE_PER_MIN", "0"],
      ["WEBHOOK_RATE_BURST", "0"],
      ["WEBHOOK_MAX_STORED_UNVERIFIED", "5"],
      ["WEBHOOK_RATE_PER_MIN", "100000"],
    ]) {
      expect(() => loadConfig(webhookEnv({ [k!]: v! }))).toThrow(ConfigError);
    }
  });
});

describe("T transmission-time window (1 h, diagnostic default) vs delayed genuine redelivery", () => {
  const HOUR = 3_600_000;

  it("T1 a genuinely signed delivery whose transmission time is 1 h + 1 s old is rejected 400 transmission_expired, with no postback and no event", async () => {
    const c = clock();
    const s = await setupWebhook({ now: c.now });
    const ev = foreign();
    const r = await deliver(s, ev, { time: iso(c.t - HOUR - 1000) }); // signature is valid for these headers
    expect(r).toMatchObject({ status: 400, body: { error: "transmission_expired" } });
    expect(s.fake.verifyCalls).toHaveLength(0);
    expect(rows(s).map((d) => [d.state, d.reason])).toEqual([["rejected", "transmission_expired"]]);
    expect(s.svc.inbox.listEvents()).toHaveLength(0);
    s.store.close();
  });

  it("T2 boundary: exactly 1 h old is still accepted", async () => {
    const c = clock();
    const s = await setupWebhook({ now: c.now });
    expect((await deliver(s, foreign(), { time: iso(c.t - HOUR) })).status).toBe(200);
    s.store.close();
  });

  it("T3 FAILURE MODE: if PayPal's retries reused the original transmission time (undocumented; HYPOTHESIS), every retry after 1 h is rejected and the event is never stored", async () => {
    const c = clock();
    const s = await setupWebhook({ now: c.now });
    const o = await ourOrder(s);
    const ev = captureEvent({ orderId: o.orderId, captureId: o.captureId, customId: o.intentId });
    const raw = JSON.stringify(ev);
    const original = signedHeaders(raw, { time: iso(c.t) });
    c.advance(30_000);
    expect((await post(s, raw, { ...original, "paypal-transmission-sig": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" })).status).toBe(400); // first attempt lost/garbled
    for (const delay of [2 * HOUR, 6 * HOUR, 24 * HOUR, 72 * HOUR]) {
      c.t = Date.parse(original["paypal-transmission-time"]!) + delay;
      expect((await post(s, raw, original)).body.error).toBe("transmission_expired");
    }
    expect(s.svc.inbox.getEvent(ev.id)).toBeUndefined();
    expect(s.fake.verifyCalls).toHaveLength(1); // only the in-window attempt reached PayPal
    s.store.close();
  });

  it("T4 if retries carry a fresh transmission time (also undocumented), a delayed redelivery is accepted and a late stale copy cannot disturb it", async () => {
    const c = clock();
    const s = await setupWebhook({ now: c.now });
    const ev = foreign();
    const raw = JSON.stringify(ev);
    const stale = signedHeaders(raw, { time: iso(c.t) });
    c.advance(5 * HOUR);
    expect((await post(s, raw, signedHeaders(raw, { time: iso(c.t) }))).status).toBe(200);
    expect((await post(s, raw, stale)).body.error).toBe("transmission_expired");
    expect(s.svc.inbox.getEvent(ev.id)!.deliveries).toBe(1);
    s.store.close();
  });

  it("T5 the window is configurable only explicitly; the default is not widened (1 h), the hard maximum is 4 days", () => {
    expect(loadConfig(webhookEnv()).webhook.maxTransmissionAgeMs).toBe(HOUR);
    expect(loadConfig(webhookEnv({ WEBHOOK_MAX_TRANSMISSION_AGE_MS: String(4 * 24 * HOUR) })).webhook.maxTransmissionAgeMs).toBe(4 * 24 * HOUR);
    expect(() => loadConfig(webhookEnv({ WEBHOOK_MAX_TRANSMISSION_AGE_MS: String(4 * 24 * HOUR + 1) }))).toThrow(ConfigError);
  });
});

describe("S read-only status report", () => {
  async function populated() {
    const path = dbFile();
    const c = clock(Date.now());
    const s = await setupWebhook({ path, now: c.now });
    const o = await ourOrder(s);
    s.fake.approve(o.orderId);
    await s.checkout.capture(o.orderId, "corr-cap");
    const mine = captureEvent({ orderId: o.orderId, captureId: o.captureId, customId: o.intentId });
    await deliver(s, mine, { time: iso(c.t) });
    await deliver(s, mine, { time: iso(c.t) }); // duplicate
    await deliver(s, foreign(), { time: iso(c.t) }); // foreign
    await forged(s, c.t); // rejected
    await post(s, "nope", { "content-type": "application/json" }); // malformed
    await s.svc.processor.drain();
    return { s, path, mine };
  }

  it("S1 counts pending / verified / processed / rejected / retried / failed from the real tables", async () => {
    const { s, path } = await populated();
    const st = webhookStatus(path, { ceiling: 5000 });
    expect(st.schemaVersion).toBeGreaterThanOrEqual(3);
    expect(st.summary).toEqual({ pending: 0, verified: 3, processed: 1, rejected: 2, retried: 0, failed: 0 });
    expect(st.deliveries.byState).toEqual({ verified: 2, duplicate: 1, rejected: 2 });
    expect(st.deliveries.rejectedByReason).toEqual({ signature_invalid: 1, malformed_json: 1 });
    expect(st.events.byState).toEqual({ processed: 1, foreign: 1 });
    expect(st.events.redelivered).toBe(1);
    expect(st.ingress).toEqual({ storedUnverified: 3, ceiling: 5000 });
    expect(st.retention.eligibleUnderProposedPolicy).toBe(0); // nothing older than 30 days
    expect(st.retention.protected).toBe(5);
    s.store.close();
  });

  it("S2 output carries no credentials, webhook id, PII, signatures, correlation ids or bodies", async () => {
    const { s, path } = await populated();
    const text = JSON.stringify(webhookStatus(path));
    for (const banned of [testPaypalConfig.clientSecret, testPaypalConfig.clientId, TEST_WEBHOOK_ID, "seller-pii@example.com", "MERCHANTFAKE123", "SHA256withRSA", "wh_", "corr-", "AAAAAAAAAAAAAAAA", "certs/CERT"]) {
      expect(text).not.toContain(banned);
    }
    s.store.close();
  });

  it("S3 opens the database read-only: the file is byte-identical afterwards and a write through the same mode fails", async () => {
    const { s, path } = await populated();
    s.store.close();
    const before = createHash("sha256").update(readFileSync(path)).digest("hex");
    webhookStatus(path);
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(before);
    const ro = new DatabaseSync(path, { readOnly: true });
    expect(() => ro.exec("UPDATE webhook_events SET outcome = 'x'")).toThrow();
    ro.close();
  });

  it("S4 retention eligibility: only old noise rows; first deliveries of events, and every event, stay protected", async () => {
    const { s, path } = await populated();
    const st = webhookStatus(path, { nowMs: Date.now() + 31 * 86_400_000 });
    expect(st.retention.eligibleUnderProposedPolicy).toBe(3); // 1 duplicate + 2 rejected
    expect(st.retention.protected).toBe(2); // the two verified first deliveries
    s.store.close();
  });

  it("S5 an un-migrated database is reported, not migrated", () => {
    const path = dbFile();
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (2, 'x')");
    db.close();
    expect(() => webhookStatus(path)).toThrow(/schema version 2/);
  });
});

describe("W read-only webhook registration check", () => {
  const TUNNEL = "https://quiet-river-1234.trycloudflare.com";
  const client = (fake: FakePayPal) => new PayPalClient({ ...testPaypalConfig, webhookId: TEST_WEBHOOK_ID }, fake.fetch);

  it("W1 correct id, exact URL, required events -> ok; only a GET is made", async () => {
    const fake = new FakePayPal();
    fake.webhookRegistrations.set(TEST_WEBHOOK_ID, { url: `${TUNNEL}/webhooks/paypal`, event_types: [{ name: "PAYMENT.CAPTURE.COMPLETED" }, { name: "CHECKOUT.ORDER.APPROVED" }] });
    const r = await checkWebhookRegistration(client(fake), TEST_WEBHOOK_ID, TUNNEL, "corr-w1");
    expect(r).toMatchObject({ ok: true, httpStatus: 200, urlMatches: true, missingRequired: [], registeredOrigin: TUNNEL });
    expect(r.missingRecommended).toEqual(["PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.DENIED"]);
    expect(fake.calls.filter((c) => c.path !== "/v1/oauth2/token").map((c) => `${c.method} ${c.path}`)).toEqual([`GET /v1/notifications/webhooks/${TEST_WEBHOOK_ID}`]);
    expect(JSON.stringify(r)).not.toContain(TEST_WEBHOOK_ID);
  });

  it.each([
    ["id unknown to this REST app", (f: FakePayPal) => void f, TUNNEL, /not found for this Sandbox REST app/],
    ["URL points elsewhere", (f: FakePayPal) => void f.webhookRegistrations.set(TEST_WEBHOOK_ID, { url: "https://old-tunnel.trycloudflare.com/webhooks/paypal", event_types: [{ name: "*" }] }), TUNNEL, /differs/],
    ["URL lacks the route", (f: FakePayPal) => void f.webhookRegistrations.set(TEST_WEBHOOK_ID, { url: TUNNEL, event_types: [{ name: "*" }] }), TUNNEL, /differs/],
    ["capture event not subscribed", (f: FakePayPal) => void f.webhookRegistrations.set(TEST_WEBHOOK_ID, { url: `${TUNNEL}/webhooks/paypal`, event_types: [{ name: "CHECKOUT.ORDER.APPROVED" }] }), TUNNEL, /PAYMENT.CAPTURE.COMPLETED/],
    ["plain http tunnel URL", (f: FakePayPal) => void f, "http://quiet-river-1234.trycloudflare.com", /https/],
  ])("W2 %s -> not ok", async (_n, arrange, base, problem) => {
    const fake = new FakePayPal();
    arrange(fake);
    const r = await checkWebhookRegistration(client(fake), TEST_WEBHOOK_ID, base, "corr-w2");
    expect(r.ok).toBe(false);
    expect(r.problems.join(" | ")).toMatch(problem);
  });
});
