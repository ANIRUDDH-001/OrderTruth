// MOCKED: Gate 1A capture-recovery tests. Every provider call goes to tests/fake-paypal.ts, never the Sandbox.
// SQLite is real (files under the OS temp dir), so lock and constraint behaviour is genuine.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { CheckoutError, CheckoutService } from "../src/checkout-service.ts";
import { Store } from "../src/db/store.ts";
import { ATTEMPT_STATES, TRANSITIONS, verifyCaptureReadback } from "../src/domain/checkout.ts";
import { PayPalClient } from "../src/paypal/client.ts";
import { buildApp } from "../src/server/app.ts";
import { loadConfig } from "../src/config.ts";
import { capturePosts, FakePayPal, newCheckoutKey, silentLogger, testPaypalConfig } from "./fake-paypal.ts";

const dir = mkdtempSync(join(tmpdir(), "ordertruth-g1a-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const dbFile = (name: string) => join(dir, `${name}-${++n}.sqlite`);

type Opts = ConstructorParameters<typeof CheckoutService>[3];
function setup(o: { path?: string; busyTimeoutMs?: number; svc?: Opts; fake?: FakePayPal } = {}) {
  const fake = o.fake ?? new FakePayPal();
  const store = new Store(o.path ?? ":memory:", o.busyTimeoutMs !== undefined ? { busyTimeoutMs: o.busyTimeoutMs } : {});
  const log = silentLogger();
  const svc = new CheckoutService(new PayPalClient(testPaypalConfig, fake.fetch), store, log, { secrets: [testPaypalConfig.clientSecret], ...o.svc });
  return { fake, store, log, svc };
}

async function approvedOrder(s: ReturnType<typeof setup>) {
  const o = await s.svc.createOrder("corr-setup", { checkoutKey: newCheckoutKey() });
  s.fake.approve(o.orderId);
  return o;
}

describe("F1: local write failure after PayPal applied the capture", () => {
  it("A1 real SQLITE_BUSY after capture 201 -> 503 outcome_unknown, one POST, never 'approved'; reconciler reaches captured with no further POST", async () => {
    const path = dbFile("busy");
    const s = setup({ path, busyTimeoutMs: 50, svc: { reconcileStaleMs: 0 } });
    const o = await approvedOrder(s);
    const locker = new DatabaseSync(path);
    s.fake.afterCaptureApply = () => locker.exec("BEGIN IMMEDIATE"); // another writer holds the lock when PayPal's 201 arrives
    const err = await s.svc.capture(o.orderId, "corr-busy").catch((e: unknown) => e);
    locker.exec("ROLLBACK");
    locker.close();
    s.fake.afterCaptureApply = undefined;

    expect(err).toBeInstanceOf(CheckoutError);
    expect((err as CheckoutError).code).toBe("outcome_unknown");
    expect((err as CheckoutError).httpStatus).toBe(503);
    expect(capturePosts(s.fake)).toHaveLength(1);
    const stuck = s.store.getAttemptByOrderId(o.orderId)!;
    expect(["capture_in_progress", "uncertain"]).toContain(stuck.state);

    // A buyer/browser retry of the same capture must not POST again.
    const retry = await s.svc.capture(o.orderId, "corr-retry");
    expect(retry.state).toBe("captured");
    expect(capturePosts(s.fake)).toHaveLength(1);
    s.store.close();
  });

  it("A1b reconciler alone converges a stuck capture_in_progress to captured from readback evidence", async () => {
    const s = setup({ path: dbFile("busy2"), busyTimeoutMs: 50, svc: { reconcileStaleMs: 0 } });
    const o = await approvedOrder(s);
    const fail = (s.store as any).appendEvidence.bind(s.store);
    (s.store as any).appendEvidence = (e: any) => {
      if (e.operation === "capture_order") throw Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR" });
      return fail(e);
    };
    await expect(s.svc.capture(o.orderId, "c")).rejects.toMatchObject({ code: "outcome_unknown" });
    (s.store as any).appendEvidence = fail;
    const r = await s.svc.reconcile("corr-reconcile");
    expect(r.outcomes).toEqual([expect.objectContaining({ orderId: o.orderId, to: "captured" })]);
    expect(s.store.getAttemptByOrderId(o.orderId)!.state).toBe("captured");
    expect(capturePosts(s.fake)).toHaveLength(1);
    s.store.close();
  });

  it("A2 evidence-file write failure after PayPal applied the capture cannot turn success into an error", async () => {
    const evidenceDir = join(dir, `ev-${++n}`);
    mkdirSync(evidenceDir);
    const s = setup({ svc: { evidenceDir } });
    const o = await approvedOrder(s);
    s.fake.afterCaptureApply = () => {
      rmSync(evidenceDir, { recursive: true, force: true });
      writeFileSync(evidenceDir, "not a directory"); // every later evidence file write now fails
    };
    const r = await s.svc.capture(o.orderId, "c");
    expect(r.state).toBe("captured");
    expect(capturePosts(s.fake)).toHaveLength(1);
    expect(s.log.lines.some((l) => l.includes("evidence_file_write_failed"))).toBe(true);
    // DB evidence (authoritative) is complete even though the file mirror failed.
    expect(s.store.listEvidence(r.attemptId).map((e) => e.operation)).toContain("post_capture_readback");
  });
});

describe("F2: durable checkout intent (buyer retry)", () => {
  const config = loadConfig({
    PAYPAL_ENV: "sandbox",
    PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com",
    PAYPAL_CLIENT_ID: testPaypalConfig.clientId,
    PAYPAL_CLIENT_SECRET: testPaypalConfig.clientSecret,
  });
  const creates = (f: FakePayPal) => f.calls.filter((c) => c.method === "POST" && c.path === "/v2/checkout/orders");

  it("A3 same checkout key returns the same order; after capture a retry is refused with no new PayPal order", async () => {
    const s = setup();
    const app = await buildApp({ config, checkout: s.svc, logger: false, webRoot: join(dir, "none") });
    const key = newCheckoutKey();
    const missing = await app.inject({ method: "POST", url: "/api/orders" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe("invalid_checkout_key");
    expect((await app.inject({ method: "POST", url: "/api/orders", headers: { "x-checkout-key": "short" } })).statusCode).toBe(400);

    const first = await app.inject({ method: "POST", url: "/api/orders", headers: { "x-checkout-key": key } });
    const second = await app.inject({ method: "POST", url: "/api/orders", headers: { "x-checkout-key": key } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().orderId).toBe(first.json().orderId);
    expect(second.json().reused).toBe(true);
    expect(creates(s.fake)).toHaveLength(1);

    s.fake.approve(first.json().orderId);
    expect((await app.inject({ method: "POST", url: `/api/orders/${first.json().orderId}/capture` })).json().state).toBe("captured");
    const after = await app.inject({ method: "POST", url: "/api/orders", headers: { "x-checkout-key": key } });
    expect(after.statusCode).toBe(409);
    expect(after.json()).toMatchObject({ error: "checkout_already_paid", details: { orderId: first.json().orderId, state: "captured" } });
    expect(creates(s.fake)).toHaveLength(1);
    await app.close();
  });

  it("A3b a retry while the outcome is unknown is refused as checkout_in_progress", async () => {
    const s = setup();
    const key = newCheckoutKey();
    const o = await s.svc.createOrder("c", { checkoutKey: key });
    s.fake.approve(o.orderId);
    s.fake.faults.capture = "timeout";
    expect((await s.svc.capture(o.orderId, "c")).state).toBe("uncertain");
    await expect(s.svc.createOrder("c2", { checkoutKey: key })).rejects.toMatchObject({ code: "checkout_in_progress", httpStatus: 409 });
    expect(creates(s.fake)).toHaveLength(1);
  });

  it("A4 concurrent creates with one key, from two services on one SQLite file, converge on one intent and one stored order", async () => {
    const path = dbFile("samekey");
    const fake = new FakePayPal();
    const a = setup({ path, fake });
    const b = setup({ path, fake });
    const key = newCheckoutKey();
    const rs = await Promise.all([a.svc.createOrder("c1", { checkoutKey: key }), b.svc.createOrder("c2", { checkoutKey: key }), a.svc.createOrder("c3", { checkoutKey: key })]);
    expect(new Set(rs.map((r) => r.orderId)).size).toBe(1);
    expect(new Set(rs.map((r) => r.attemptId)).size).toBe(1);
    expect(a.store.listAttempts()).toHaveLength(1);
    // Every create POST for this key used the same stable PayPal-Request-Id.
    expect(new Set(creates(fake).map((c) => c.headers["PayPal-Request-Id"])).size).toBe(1);
    a.store.close();
    b.store.close();
  });

  it("A4b create outcome unknown, then retry with the same key -> same attempt and same create request id", async () => {
    const s = setup();
    const key = newCheckoutKey();
    s.fake.faults.create = "timeout";
    await expect(s.svc.createOrder("c", { checkoutKey: key })).rejects.toMatchObject({ code: "provider_error" });
    expect(s.store.listAttempts()[0]!.state).toBe("created");
    delete s.fake.faults.create;
    const o = await s.svc.createOrder("c2", { checkoutKey: key });
    expect(s.store.listAttempts()).toHaveLength(1);
    expect(o.attemptId).toBe(s.store.listAttempts()[0]!.id);
    const ids = creates(s.fake).map((c) => c.headers["PayPal-Request-Id"]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });
});

describe("F3: guarded transitions across services sharing SQLite", () => {
  it("A10 service B cannot reset A's in-flight claim; exactly one capture POST", async () => {
    const path = dbFile("race");
    const fake = new FakePayPal();
    const a = setup({ path, fake });
    const b = setup({ path, fake });
    const o = await approvedOrder(a);
    let release!: () => void;
    let arrived!: () => void;
    const arrival = new Promise<void>((r) => (arrived = r));
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    fake.beforeCaptureApply = () => {
      if (!first) return;
      first = false;
      arrived();
      return gate;
    };
    const pa = a.svc.capture(o.orderId, "corr-a");
    await arrival; // A's capture POST is at PayPal, not yet applied
    const rb = await b.svc.capture(o.orderId, "corr-b").catch((e: unknown) => e);
    release();
    const ra = await pa;
    expect(ra.state).toBe("captured");
    expect(rb).toMatchObject({ code: "capture_in_progress" });
    expect(capturePosts(fake)).toHaveLength(1);
    a.store.close();
    b.store.close();
  });

  it("A9 DB trigger rejects an illegal transition even through raw SQL; updateAttempt cannot write state", async () => {
    const s = setup();
    const o = await approvedOrder(s);
    const a = s.store.getAttemptByOrderId(o.orderId)!;
    expect(s.store.transition(a.id, "approved")).toBe(true);
    expect(s.store.claimCapture(a.id, ["approved"])).toBe(true);
    expect(() => s.store.db.prepare("UPDATE payment_attempts SET state = 'approved' WHERE id = ?").run(a.id)).toThrow(/illegal attempt state transition/);
    expect(s.store.transition(a.id, "approved")).toBe(false);
    expect(() => s.store.updateAttempt(a.id, { state: "approved" } as any)).toThrow(/state/);
    expect(s.store.getAttempt(a.id)!.state).toBe("capture_in_progress");
  });

  it("A9b DB transition table equals the TypeScript TRANSITIONS map", () => {
    const s = new Store(":memory:");
    const rows = s.db.prepare("SELECT from_state, to_state FROM attempt_transitions ORDER BY from_state, to_state").all() as Array<{ from_state: string; to_state: string }>;
    const expected = ATTEMPT_STATES.flatMap((f) => TRANSITIONS[f].map((t) => ({ from_state: f as string, to_state: t as string }))).sort((x, y) =>
      x.from_state === y.from_state ? x.to_state.localeCompare(y.to_state) : x.from_state.localeCompare(y.from_state),
    );
    expect(rows.map((r) => ({ ...r }))).toEqual(expected);
    expect(TRANSITIONS.capture_in_progress).not.toContain("approved");
    expect(TRANSITIONS.uncertain).not.toContain("approved");
  });
});

describe("Readback-only reconciler and the settle window", () => {
  it("A5 reconciler issues only GET (plus OAuth) and never captures, whatever the local state", async () => {
    const s = setup({ svc: { reconcileStaleMs: 0 } });
    // (a) stale claim, nothing captured at PayPal (crash before POST)
    const a = await approvedOrder(s);
    const aRow = s.store.getAttemptByOrderId(a.orderId)!;
    s.store.transition(aRow.id, "approved");
    s.store.claimCapture(aRow.id, ["approved"]);
    // (b) pending capture at PayPal
    s.fake.captureStatus = "PENDING";
    const b = await approvedOrder(s);
    expect((await s.svc.capture(b.orderId, "c")).state).toBe("pending");
    s.fake.captureStatus = "COMPLETED";
    s.fake.orders.get(b.orderId)!.captures[0].status = "COMPLETED";
    s.fake.orders.get(b.orderId)!.status = "COMPLETED";
    // (c) captured at PayPal but local row still capture_in_progress (crash after 201)
    const c = await approvedOrder(s);
    const cRow = s.store.getAttemptByOrderId(c.orderId)!;
    s.store.transition(cRow.id, "approved");
    s.store.claimCapture(cRow.id, ["approved"]);
    const cap = await new PayPalClient(testPaypalConfig, s.fake.fetch).captureOrder(c.orderId, cRow.capture_request_id, { correlationId: "x" });
    expect(cap.httpStatus).toBe(201);

    const mark = s.fake.calls.length;
    const r = await s.svc.reconcile("corr-rec");
    const during = s.fake.calls.slice(mark);
    expect(during.length).toBeGreaterThan(0);
    for (const call of during) expect(call.method === "GET" || call.path === "/v1/oauth2/token").toBe(true);
    const to = Object.fromEntries(r.outcomes.map((x) => [x.orderId, x.to]));
    expect(to[a.orderId]).toBe("uncertain");
    expect(to[b.orderId]).toBe("captured");
    expect(to[c.orderId]).toBe("captured");
    // Payment-verification evidence only: the reconciler never writes merchant/repair classes.
    const classes = new Set(r.outcomes.flatMap((x) => s.store.listEvidence(x.attemptId).filter((e) => e.operation === "reconcile_readback").map((e) => e.evidence_class)));
    expect([...classes]).toEqual(["PAYPAL_API_READBACK"]);
  });

  it("A5b reconciler skips a fresh claim (another process may be mid-capture)", async () => {
    const s = setup({ svc: { reconcileStaleMs: 60_000 } });
    const a = await approvedOrder(s);
    const row = s.store.getAttemptByOrderId(a.orderId)!;
    s.store.transition(row.id, "approved");
    s.store.claimCapture(row.id, ["approved"]);
    const r = await s.svc.reconcile("c");
    expect(r.outcomes).toEqual([]);
    expect(s.store.getAttempt(row.id)!.state).toBe("capture_in_progress");
  });

  it("A6 timeout then immediate APPROVED readback is NOT proof: uncertain; retry refused inside the settle window; after it, one POST with the same request id", async () => {
    let t = Date.parse("2026-10-18T12:00:00Z");
    const s = setup({ svc: { captureSettleMs: 120_000, now: () => t } });
    const o = await approvedOrder(s);
    s.fake.faults.capture = "timeout";
    const r1 = await s.svc.capture(o.orderId, "c1");
    expect(r1.state).toBe("uncertain");
    delete s.fake.faults.capture;

    t += 5_000;
    await expect(s.svc.capture(o.orderId, "c2")).rejects.toMatchObject({ code: "capture_outcome_pending", httpStatus: 409 });
    expect(capturePosts(s.fake)).toHaveLength(1);

    t += 120_000;
    const r3 = await s.svc.capture(o.orderId, "c3");
    expect(r3.state).toBe("captured");
    const posts = capturePosts(s.fake);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.headers["PayPal-Request-Id"]).toBe(posts[0]!.headers["PayPal-Request-Id"]);
    expect(posts[0]!.headers["PayPal-Request-Id"]).toBe(`ot-capture-${r3.attemptId}`);
  });

  it("A7 terminal short-circuit: capture of an already-captured order makes zero PayPal calls", async () => {
    const s = setup();
    const o = await approvedOrder(s);
    expect((await s.svc.capture(o.orderId, "c")).state).toBe("captured");
    const before = s.fake.calls.length;
    expect((await s.svc.capture(o.orderId, "c2")).state).toBe("captured");
    expect(s.fake.calls.length).toBe(before);
  });
});

describe("Correlation evidence (custom_id)", () => {
  const expected = { orderId: "ORDER1234", amount: { currency: "USD" as const, minor: 100 }, customId: "ci_1" };
  it("A8 a completed capture whose readback lacks custom_id is a mismatch, not captured", () => {
    const v = verifyCaptureReadback(
      { id: "ORDER1234", status: "COMPLETED", intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "1.00" }, payments: { captures: [{ id: "C1", status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } }] } }] },
      expected,
    );
    expect(v.state).toBe("mismatch");
    expect(v.reasons.join(" ")).toMatch(/custom_id/);
  });

  it("A8b a pre-capture readback with a foreign custom_id is refused without any capture POST", async () => {
    const s = setup();
    const o = await approvedOrder(s);
    s.fake.customIdOverride = "ci_someone-else";
    await expect(s.svc.capture(o.orderId, "c")).rejects.toMatchObject({ code: "provider_mismatch", httpStatus: 409 });
    expect(capturePosts(s.fake)).toHaveLength(0);
    expect(s.store.getAttemptByOrderId(o.orderId)!.state).toBe("mismatch");
  });

  it("A8c a pre-capture readback without custom_id is refused without any capture POST", async () => {
    const s = setup();
    const o = await approvedOrder(s);
    s.fake.customIdOverride = null;
    await expect(s.svc.capture(o.orderId, "c")).rejects.toMatchObject({ code: "provider_mismatch" });
    expect(capturePosts(s.fake)).toHaveLength(0);
  });
});
