/**
 * Stage 1C — reference merchant contract, CONTROLLED_FAULT_INJECTION, invariant checker, incident
 * evidence and read-only API. PayPal is the in-memory fake (MOCKED); the evidence rows it produces
 * have the same shape as live ones. The checker itself never calls PayPal.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { MIGRATIONS, Store } from "../src/db/store.ts";
import { buildIncidentApi, ORG_HEADER } from "../src/merchant/api.ts";
import { InvariantChecker } from "../src/merchant/checker.ts";
import { CONTRACT_ID } from "../src/merchant/contract.ts";
import { FaultInjectionRefused, injectDuplicateOrderRace } from "../src/merchant/fault-injection.ts";
import { MerchantError, ReferenceMerchant } from "../src/merchant/reference-merchant.ts";
import { MerchantRepo, REFERENCE_ORG } from "../src/merchant/repo.ts";
import { captureEvent, deliver, ourOrder, setupWebhook, type Setup } from "./helpers/webhook-fixtures.ts";

const dir = mkdtempSync(join(tmpdir(), "ordertruth-s1c-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const dbFile = () => join(dir, `s1c-${++n}.sqlite`);
const ORG = REFERENCE_ORG;

/** One genuine-shaped capture: create, buyer approval, capture + readback, verified webhook processed. */
async function capturedWithWebhook(s: Setup) {
  const o = await ourOrder(s);
  s.fake.approve(o.orderId);
  const c = await s.checkout.capture(o.orderId, "corr-s1c-capture");
  expect(c.state).toBe("captured");
  const r = await deliver(s, captureEvent({ orderId: o.orderId, captureId: o.captureId, customId: o.intentId }));
  expect(r.status).toBe(200);
  await s.svc.processor.drain();
  return o;
}

async function scenario(mode: "healthy" | "fault", path = dbFile()) {
  const s = await setupWebhook({ path });
  const o = await capturedWithWebhook(s);
  const merchant = new ReferenceMerchant(s.store);
  if (mode === "healthy") await merchant.healthyBothPaths(ORG, o.intentId);
  else await injectDuplicateOrderRace(merchant, ORG, o.intentId);
  const checker = new InvariantChecker(s.store);
  const run = checker.evaluateAll(ORG);
  return { s, o, merchant, checker, run, repo: new MerchantRepo(s.store), path };
}

const count = (db: DatabaseSync | Store["db"], sql: string, ...p: Array<string | number>) => (db.prepare(sql).get(...p) as { n: number }).n;
const classCounts = (repo: MerchantRepo, incidentId: string) =>
  repo.incidentEvidence(incidentId).reduce<Record<string, number>>((m, e) => ((m[e.evidence_class] = (m[e.evidence_class] ?? 0) + 1), m), {});

describe("healthy negative control vs controlled fault", () => {
  it("C1 healthy: both order paths fire, exactly one merchant order, HOLDS, no incident", async () => {
    const { s, o, repo, run } = await scenario("healthy");
    const orders = repo.ordersForIntent(ORG, o.intentId);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.fault_injection_id).toBeNull();
    expect(orders[0]!.capture_id).toBe(o.captureId);
    const c = run.checks.find((x) => x.intentId === o.intentId)!;
    expect(c.result).toBe("HOLDS");
    expect(c.incidentId).toBeNull();
    expect(count(s.store.db, "SELECT COUNT(*) n FROM incidents")).toBe(0);
    expect(count(s.store.db, "SELECT COUNT(*) n FROM incident_evidence")).toBe(0);
    s.store.close();
  });

  it("C2 fault: two labelled orders from one intent -> VIOLATED -> one high-severity incident with all four evidence classes", async () => {
    const { s, o, repo, run } = await scenario("fault");
    const orders = repo.ordersForIntent(ORG, o.intentId);
    expect(orders).toHaveLength(2);
    expect(new Set(orders.map((x) => x.created_by_path))).toEqual(new Set(["capture_return", "webhook_capture_completed"]));
    const faults = repo.faultsForIntent(ORG, o.intentId);
    expect(faults).toHaveLength(1);
    expect(faults[0]!.label).toBe("CONTROLLED_FAULT_INJECTION");
    expect(orders.every((x) => x.fault_injection_id === faults[0]!.id)).toBe(true);

    const c = run.checks.find((x) => x.intentId === o.intentId)!;
    expect(c.result).toBe("VIOLATED");
    expect(c.incidentOpened).toBe(true);
    const inc = repo.getIncident(ORG, c.incidentId!)!;
    expect(inc).toMatchObject({ incident_class: "DUPLICATE_MERCHANT_ORDER", severity: "high", state: "open", contract: CONTRACT_ID, paypal_order_id: o.orderId, capture_id: o.captureId, intent_id: o.intentId });
    const cc = classCounts(repo, inc.id);
    expect(cc.MERCHANT_DB_OBSERVED).toBe(2);
    expect(cc.CONTROLLED_FAULT_INJECTION).toBe(1);
    expect(cc.PAYPAL_VERIFIED_WEBHOOK).toBe(1);
    expect(cc.PAYPAL_API_READBACK).toBeGreaterThanOrEqual(2); // post-capture + webhook readback
    expect(JSON.parse(inc.reproduction_json).cause).toBe("CONTROLLED_FAULT_INJECTION");
    s.store.close();
  });

  it("C3 repeatable: 5 fault runs and 5 healthy runs give identical outcomes", async () => {
    const shape = (x: Awaited<ReturnType<typeof scenario>>) => {
      const c = x.run.checks.find((y) => y.intentId === x.o.intentId)!;
      const out = { orders: x.repo.ordersForIntent(ORG, x.o.intentId).length, result: c.result, incidents: x.repo.listIncidents(ORG).length, classes: c.incidentId ? classCounts(x.repo, c.incidentId) : {} };
      x.s.store.close();
      return out;
    };
    const faults = [];
    const healthy = [];
    for (let i = 0; i < 5; i++) faults.push(shape(await scenario("fault")));
    for (let i = 0; i < 5; i++) healthy.push(shape(await scenario("healthy")));
    for (const f of faults) expect(f).toEqual(faults[0]);
    for (const h of healthy) expect(h).toEqual({ orders: 1, result: "HOLDS", incidents: 0, classes: {} });
    expect(faults[0]).toMatchObject({ orders: 2, result: "VIOLATED", incidents: 1 });
  });

  it("C4 re-running the checker opens no second incident and links no duplicate evidence; each run is recorded", async () => {
    const { s, o, checker, repo } = await scenario("fault");
    const before = repo.incidentEvidence(repo.listIncidents(ORG)[0]!.id).length;
    for (let i = 0; i < 3; i++) {
      const c = checker.evaluateIntent(ORG, o.intentId);
      expect(c.result).toBe("VIOLATED");
      expect(c.incidentOpened).toBe(false);
      expect(c.evidenceLinked).toBe(0);
    }
    expect(repo.listIncidents(ORG)).toHaveLength(1);
    expect(repo.incidentEvidence(repo.listIncidents(ORG)[0]!.id)).toHaveLength(before);
    expect(count(s.store.db, "SELECT COUNT(*) n FROM invariant_evaluations WHERE intent_id = ? AND result = 'VIOLATED'", o.intentId)).toBe(4);
    s.store.close();
  });

  it("C5 restart: incident, evidence and orders survive close/reopen; a fresh checker after restart opens nothing new", async () => {
    const x = await scenario("fault");
    const incId = x.repo.listIncidents(ORG)[0]!.id;
    const app1 = await buildIncidentApi({ store: x.s.store });
    const before = (await app1.inject({ url: `/api/incidents/${incId}`, headers: { [ORG_HEADER]: ORG } })).json();
    await app1.close();
    x.s.store.close();

    const store = new Store(x.path);
    expect(count(store.db, "SELECT MAX(version) n FROM schema_migrations")).toBe(MIGRATIONS.length);
    const c = new InvariantChecker(store).evaluateIntent(ORG, x.o.intentId);
    expect(c).toMatchObject({ result: "VIOLATED", incidentId: incId, incidentOpened: false, evidenceLinked: 0 });
    const app2 = await buildIncidentApi({ store });
    const after = (await app2.inject({ url: `/api/incidents/${incId}`, headers: { [ORG_HEADER]: ORG } })).json();
    expect(after.evidence).toEqual(before.evidence);
    expect(after.affectedOrders).toEqual(before.affectedOrders);
    expect(after.openedAt).toBe(before.openedAt);
    expect(after.latestEvaluation.seq).toBeGreaterThan(before.latestEvaluation.seq);
    await app2.close();
    store.close();
  });

  it("C6 the checker makes zero PayPal calls and changes no payment or merchant state", async () => {
    const s = await setupWebhook({ path: dbFile() });
    const o = await capturedWithWebhook(s);
    await injectDuplicateOrderRace(new ReferenceMerchant(s.store), ORG, o.intentId);
    const calls = s.fake.calls.length;
    const attempt = JSON.stringify(s.store.getAttemptByOrderId(o.orderId));
    const orders = JSON.stringify(new MerchantRepo(s.store).ordersForIntent(ORG, o.intentId));
    new InvariantChecker(s.store).evaluateAll(ORG);
    expect(s.fake.calls.length).toBe(calls);
    expect(JSON.stringify(s.store.getAttemptByOrderId(o.orderId))).toBe(attempt);
    expect(JSON.stringify(new MerchantRepo(s.store).ordersForIntent(ORG, o.intentId))).toBe(orders);
    s.store.close();
  });

  it("C7 an unlabelled concurrent race (no injector) is still detected but never attributed to a controlled fault", async () => {
    // REF-BUG-1 is organic: the merchant's await between check and insert is the window; the
    // injector's barrier only pins the interleaving. An organic duplicate must not borrow the label.
    const s = await setupWebhook({ path: dbFile() });
    const o = await capturedWithWebhook(s);
    const merchant = new ReferenceMerchant(s.store);
    await Promise.all([merchant.placeOrderForCapturedIntent(ORG, o.intentId, "capture_return"), merchant.placeOrderForCapturedIntent(ORG, o.intentId, "webhook_capture_completed")]);
    const c = new InvariantChecker(s.store).evaluateIntent(ORG, o.intentId);
    expect(c.result).toBe("VIOLATED");
    const repo = new MerchantRepo(s.store);
    expect(repo.faultsForIntent(ORG, o.intentId)).toHaveLength(0);
    expect(JSON.parse(repo.getIncident(ORG, c.incidentId!)!.reproduction_json).cause).toBe("UNKNOWN");
    expect(classCounts(repo, c.incidentId!).CONTROLLED_FAULT_INJECTION).toBeUndefined();
    const app = await buildIncidentApi({ store: s.store });
    const d = (await app.inject({ url: `/api/incidents/${c.incidentId}`, headers: { [ORG_HEADER]: ORG } })).json();
    expect(d.affectedOrders.map((x: { provenance: string }) => x.provenance)).toEqual(["REFERENCE_MERCHANT_FLOW", "REFERENCE_MERCHANT_FLOW"]);
    await app.close();
    s.store.close();
  });
});

describe("false positives: no incident unless the contract is genuinely violated", () => {
  it("F1 uncaptured intents (awaiting approval) with no orders -> NOT_ELIGIBLE; the merchant refuses to order them", async () => {
    const s = await setupWebhook();
    const o = await ourOrder(s);
    const c = new InvariantChecker(s.store).evaluateIntent(ORG, o.intentId);
    expect(c).toMatchObject({ result: "NOT_ELIGIBLE", incidentId: null });
    await expect(new ReferenceMerchant(s.store).placeOrderForCapturedIntent(ORG, o.intentId, "capture_return")).rejects.toBeInstanceOf(MerchantError);
    await expect(injectDuplicateOrderRace(new ReferenceMerchant(s.store), ORG, o.intentId)).rejects.toBeInstanceOf(FaultInjectionRefused);
    s.store.close();
  });

  it("F2 captured with zero orders -> OUT_OF_SCOPE (missing order is not this incident class), no incident", async () => {
    const s = await setupWebhook();
    const o = await capturedWithWebhook(s);
    expect(new InvariantChecker(s.store).evaluateIntent(ORG, o.intentId)).toMatchObject({ result: "OUT_OF_SCOPE", incidentId: null, activeOrderCount: 0 });
    s.store.close();
  });

  it("F3 local state says captured but NO authoritative readback shows a capture -> duplicates are not accused", async () => {
    const s = await setupWebhook();
    const st = s.store;
    st.createIntentWithAttempt(
      { id: "ci_00000000-0000-4000-8000-00000000f003", sku: "OT-GATE0-SANDBOX-TEST", currency: "USD", amount_minor: 100, correlation_id: "corr-f3", checkout_key: "ck_f3f3f3f3f3f3f3f3f3" },
      { id: "pa_f3", createRequestId: "c-f3", captureRequestId: "k-f3" },
    );
    st.attachOrder("pa_f3", "FAKEF300000000001", "CREATED");
    expect(st.transition("pa_f3", "captured", { capture_id: "CAPF3", capture_status: "COMPLETED", captured_minor: 100, captured_currency: "USD" })).toBe(true);
    const intentId = "ci_00000000-0000-4000-8000-00000000f003";
    await injectDuplicateOrderRace(new ReferenceMerchant(st), ORG, intentId);
    const c = new InvariantChecker(st).evaluateIntent(ORG, intentId);
    expect(c.result).toBe("OUT_OF_SCOPE");
    expect(c.reasons.join(" ")).toMatch(/no authoritative PAYPAL_API_READBACK/);
    expect(c.incidentId).toBeNull();
    st.close();
  });

  it("F4 a newer readback contradicting the capture (e.g. REFUNDED) removes eligibility: no incident", async () => {
    const s = await setupWebhook();
    const o = await capturedWithWebhook(s);
    await injectDuplicateOrderRace(new ReferenceMerchant(s.store), ORG, o.intentId);
    // MOCKED later readback row, same allowlist summary shape as summarizeOrder().
    s.store.appendEvidence({
      attemptId: o.attemptId, evidenceClass: "PAYPAL_API_READBACK", operation: "readback", httpStatus: 200, debugId: "dbgF4", requestId: null, correlationId: "corr-f4", durationMs: 1,
      summary: { id: o.orderId, status: "COMPLETED", purchase_units: [{ custom_id: o.intentId, captures: [{ id: o.captureId, status: "REFUNDED", amount: { currency_code: "USD", value: "1.00" } }] }] },
    });
    const c = new InvariantChecker(s.store).evaluateIntent(ORG, o.intentId);
    expect(c.result).toBe("OUT_OF_SCOPE");
    expect(c.reasons.join(" ")).toMatch(/REFUNDED/);
    expect(new MerchantRepo(s.store).listIncidents(ORG)).toHaveLength(0);
    s.store.close();
  });

  it("F5 a failed (non-200) or pre-capture readback never confirms; only the faulty intent among several gets an incident", async () => {
    const s = await setupWebhook({ path: dbFile() });
    const healthy = await capturedWithWebhook(s);
    const faulty = await capturedWithWebhook(s);
    await ourOrder(s); // a third, never approved
    const m = new ReferenceMerchant(s.store);
    await m.healthyBothPaths(ORG, healthy.intentId);
    await injectDuplicateOrderRace(m, ORG, faulty.intentId);
    const run = new InvariantChecker(s.store).evaluateAll(ORG);
    expect(run.checks.map((c) => c.result).sort()).toEqual(["HOLDS", "NOT_ELIGIBLE", "VIOLATED"]);
    const incs = new MerchantRepo(s.store).listIncidents(ORG);
    expect(incs).toHaveLength(1);
    expect(incs[0]!.intent_id).toBe(faulty.intentId);
    const readbacks = new MerchantRepo(s.store).incidentEvidence(incs[0]!.id).filter((e) => e.evidence_class === "PAYPAL_API_READBACK");
    for (const r of readbacks) {
      const row = s.store.db.prepare("SELECT * FROM evidence WHERE seq = ?").get(Number(r.ref_id)) as { operation: string; http_status: number };
      expect(row.http_status).toBe(200);
      expect(row.operation).not.toBe("pre_capture_readback"); // pre-capture readback shows no capture
    }
    s.store.close();
  });
});

describe("evidence integrity (DB-enforced labels)", () => {
  it("E1 every incident evidence link resolves to a record of its own class, intent and attempt", async () => {
    const { s, repo } = await scenario("fault");
    const inc = repo.listIncidents(ORG)[0]!;
    for (const e of repo.incidentEvidence(inc.id)) {
      if (e.evidence_class === "PAYPAL_API_READBACK") {
        const r = s.store.db.prepare("SELECT evidence_class, attempt_id FROM evidence WHERE seq = ?").get(Number(e.ref_id)) as { evidence_class: string; attempt_id: string };
        expect(r).toEqual({ evidence_class: "PAYPAL_API_READBACK", attempt_id: inc.attempt_id });
      } else if (e.evidence_class === "PAYPAL_VERIFIED_WEBHOOK") {
        const w = s.store.db.prepare("SELECT w.state, d.state AS ds, w.attempt_id FROM webhook_events w JOIN webhook_deliveries d ON d.seq = w.first_delivery_seq WHERE event_id = ?").get(e.ref_id);
        expect(w).toEqual({ state: "processed", ds: "verified", attempt_id: inc.attempt_id });
      } else if (e.evidence_class === "MERCHANT_DB_OBSERVED") {
        expect(e.ref_type).toBe("merchant_order");
        expect(repo.ordersForIntent(ORG, inc.intent_id).map((o) => o.id)).toContain(e.ref_id);
      } else {
        expect(e.ref_type).toBe("fault_injection");
      }
    }
    s.store.close();
  });

  it("E2 mislabelled or cross-intent links, rewrites and deletions are refused by the database", async () => {
    const { s, repo, o } = await scenario("fault");
    const db = s.store.db;
    const inc = repo.listIncidents(ORG)[0]!;
    const ins = (cls: string, type: string, ref: string) =>
      db.prepare("INSERT INTO incident_evidence (incident_id, evidence_class, ref_type, ref_id, source_at, summary_json, linked_at) VALUES (?, ?, ?, ?, NULL, '{}', 'x')").run(inc.id, cls, type, ref);
    const response = db.prepare("SELECT seq FROM evidence WHERE evidence_class = 'PAYPAL_API_RESPONSE' AND attempt_id = ? LIMIT 1").get(o.attemptId) as { seq: number };
    expect(() => ins("PAYPAL_API_READBACK", "evidence", String(response.seq))).toThrow(/must reference/); // a capture response is not a readback
    expect(() => ins("MERCHANT_DB_OBSERVED", "evidence", String(response.seq))).toThrow(/CHECK|must reference/); // trigger or CHECK, whichever fires first
    expect(() => ins("PAYPAL_VERIFIED_WEBHOOK", "webhook_event", "WH-DOES-NOT-EXIST")).toThrow(/must reference/);
    expect(() => ins("AI_HYPOTHESIS", "evidence", "1")).toThrow(/CHECK|must reference/);
    // An order of a different intent cannot be attached to this incident.
    const other = await capturedWithWebhook(s);
    const { order } = await new ReferenceMerchant(s.store).placeOrderForCapturedIntent(ORG, other.intentId, "capture_return");
    expect(() => ins("MERCHANT_DB_OBSERVED", "merchant_order", order.id)).toThrow(/must reference/);
    // Append-only / immutable.
    expect(() => db.prepare("UPDATE incident_evidence SET summary_json = '{}'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM incident_evidence").run()).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE incidents SET severity = 'low'").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM incidents").run()).toThrow(/never deleted/);
    expect(() => db.prepare("DELETE FROM merchant_orders").run()).toThrow(/never deleted/);
    expect(() => db.prepare("UPDATE merchant_orders SET fault_injection_id = NULL").run()).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE fault_injections SET label = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM invariant_evaluations").run()).toThrow(/append-only/);
    s.store.close();
  });

  it("E3 an incident cannot be opened without a VIOLATED evaluation of the same intent", async () => {
    const { s, o, run } = await scenario("healthy");
    const holds = run.checks.find((c) => c.intentId === o.intentId)!;
    expect(() =>
      s.store.db
        .prepare(
          `INSERT INTO incidents (id, organization_id, incident_class, contract, dedup_key, severity, state, intent_id, attempt_id, paypal_order_id, capture_id, title, opened_by_evaluation_seq, reproduction_json, opened_at)
           VALUES ('inc_x', ?, 'DUPLICATE_MERCHANT_ORDER', ?, 'k', 'high', 'open', ?, ?, ?, ?, 't', ?, '{}', 'x')`,
        )
        .run(ORG, CONTRACT_ID, o.intentId, o.attemptId, o.orderId, o.captureId, holds.evaluationSeq),
    ).toThrow(/VIOLATED evaluation/);
    s.store.close();
  });
});

describe("read-only incident API and cross-organization denial", () => {
  it("A1 incident list and detail expose identity, severity, timestamps, labelled evidence, affected orders and reproduction", async () => {
    const { s, o, repo } = await scenario("fault");
    const app = await buildIncidentApi({ store: s.store });
    const h = { [ORG_HEADER]: ORG };
    const list = (await app.inject({ url: "/api/incidents", headers: h })).json();
    expect(list.incidents).toHaveLength(1);
    expect(list.incidents[0]).toMatchObject({ class: "DUPLICATE_MERCHANT_ORDER", severity: "high", state: "open", paypalOrderId: o.orderId, captureId: o.captureId, affectedOrderCount: 2 });
    const d = (await app.inject({ url: `/api/incidents/${list.incidents[0].id}`, headers: h })).json();
    expect(d.payment).toEqual({ intentId: o.intentId, attemptId: o.attemptId, paypalOrderId: o.orderId, captureId: o.captureId });
    expect(d.openingEvaluation.result).toBe("VIOLATED");
    expect(Date.parse(d.openedAt)).not.toBeNaN();
    expect(d.affectedOrders).toHaveLength(2);
    expect(d.affectedOrders.every((x: { provenance: string }) => x.provenance === "CONTROLLED_FAULT_INJECTION")).toBe(true);
    expect(new Set(d.evidence.map((e: { evidenceClass: string }) => e.evidenceClass))).toEqual(new Set(["PAYPAL_API_READBACK", "PAYPAL_VERIFIED_WEBHOOK", "MERCHANT_DB_OBSERVED", "CONTROLLED_FAULT_INJECTION"]));
    expect(d.reproduction.cause).toBe("CONTROLLED_FAULT_INJECTION");
    expect(d.evidenceCounts.MERCHANT_DB_OBSERVED).toBe(repo.ordersForIntent(ORG, o.intentId).length);
    const ev = (await app.inject({ url: `/api/evaluations?intentId=${o.intentId}`, headers: h })).json();
    expect(ev.evaluations[0].result).toBe("VIOLATED");
    expect((await app.inject({ url: "/api/incidents/not-an-id", headers: h })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/evaluations?intentId=bad", headers: h })).statusCode).toBe(400);
    await app.close();
    s.store.close();
  });

  it("A2 another organization sees nothing and cannot distinguish the incident from a missing one", async () => {
    const { s, o } = await scenario("fault");
    const repo = new MerchantRepo(s.store);
    repo.createOrganization("org_other", "Other merchant");
    const app = await buildIncidentApi({ store: s.store });
    const incId = repo.listIncidents(ORG)[0]!.id;
    const other = { [ORG_HEADER]: "org_other" };
    expect((await app.inject({ url: "/api/incidents", headers: other })).json().incidents).toEqual([]);
    const r = await app.inject({ url: `/api/incidents/${incId}`, headers: other });
    expect(r.statusCode).toBe(404);
    const missing = await app.inject({ url: "/api/incidents/inc_00000000-0000-4000-8000-000000000000", headers: other });
    expect(r.body).toBe(missing.body);
    expect((await app.inject({ url: `/api/evaluations?intentId=${o.intentId}`, headers: other })).json().evaluations).toEqual([]);
    for (const headers of [{}, { [ORG_HEADER]: "org_unknown" }, { [ORG_HEADER]: "ORG_REFERENCE" }, { [ORG_HEADER]: "org_reference' OR 1=1" }]) {
      expect((await app.inject({ url: "/api/incidents", headers })).statusCode).toBe(401);
      expect((await app.inject({ url: `/api/incidents/${incId}`, headers })).statusCode).toBe(401);
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      expect((await app.inject({ method, url: `/api/incidents/${incId}`, headers: { [ORG_HEADER]: ORG } })).statusCode).toBe(405);
    }
    expect(repo.listIncidents(ORG)).toHaveLength(1);
    await app.close();
    s.store.close();
  });

  it("A3 another organization cannot place orders, inject faults or evaluate against this organization's intent", async () => {
    const s = await setupWebhook();
    const o = await capturedWithWebhook(s);
    const repo = new MerchantRepo(s.store);
    repo.createOrganization("org_other", "Other merchant");
    const m = new ReferenceMerchant(s.store);
    await expect(m.placeOrderForCapturedIntent("org_other", o.intentId, "capture_return")).rejects.toMatchObject({ code: "unknown_intent" });
    await expect(injectDuplicateOrderRace(m, "org_other", o.intentId)).rejects.toBeInstanceOf(FaultInjectionRefused);
    expect(() => new InvariantChecker(s.store).evaluateIntent("org_other", o.intentId)).toThrow(/not found/);
    expect(new InvariantChecker(s.store).evaluateAll("org_other").checks).toEqual([]);
    // Direct insert with a mismatched organization is refused by the database too.
    expect(() =>
      s.store.db
        .prepare(
          `INSERT INTO merchant_orders (id, organization_id, intent_id, attempt_id, paypal_order_id, capture_id, sku, currency, amount_minor, status, created_by_path, fault_injection_id, created_at)
           VALUES ('mo_x', 'org_other', ?, ?, ?, ?, 'S', 'USD', 100, 'placed', 'capture_return', NULL, 'x')`,
        )
        .run(o.intentId, o.attemptId, o.orderId, o.captureId),
    ).toThrow(/merchant order must/);
    s.store.close();
  });
});

describe("migration 4 is additive", () => {
  it("M1 a v3 database with payment data migrates to v4 with every existing row and value unchanged", () => {
    const path = dbFile();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (let v = 0; v < 3; v++) {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations VALUES (?, 'x')").run(v + 1);
    }
    db.prepare("INSERT INTO checkout_intents (id, sku, currency, amount_minor, correlation_id, created_at, checkout_key) VALUES ('ci_m1', 'S', 'USD', 100, 'c', 't', 'ck_m1m1m1m1m1m1m1m1m1')").run();
    db.prepare("INSERT INTO payment_attempts (id, intent_id, create_request_id, capture_request_id, state, created_at, updated_at) VALUES ('pa_m1', 'ci_m1', 'a', 'b', 'created', 't', 't')").run();
    db.prepare("INSERT INTO evidence (attempt_id, evidence_class, operation, correlation_id, summary_json, created_at) VALUES ('pa_m1', 'PAYPAL_API_READBACK', 'readback', 'c', '{}', 't')").run();
    const snap = (d: DatabaseSync) => JSON.stringify(["checkout_intents", "payment_attempts", "evidence"].map((t) => d.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
    const before = snap(db);
    db.close();

    const store = new Store(path);
    expect(count(store.db, "SELECT MAX(version) n FROM schema_migrations")).toBe(4);
    const after = JSON.parse(snap(store.db as unknown as DatabaseSync)) as Array<Array<Record<string, unknown>>>;
    expect(after[0]![0]!.organization_id).toBe(REFERENCE_ORG);
    delete after[0]![0]!.organization_id;
    expect(JSON.stringify(after)).toBe(before);
    for (const t of ["merchant_orders", "incidents", "incident_evidence", "invariant_evaluations", "fault_injections"]) expect(count(store.db, `SELECT COUNT(*) n FROM ${t}`)).toBe(0);
    store.close();
    // Reopening applies nothing twice.
    const again = new Store(path);
    expect(count(again.db, "SELECT COUNT(*) n FROM schema_migrations")).toBe(4);
    again.close();
  });
});
