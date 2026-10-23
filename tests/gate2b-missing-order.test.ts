/** Gate 2B: synthetic isolated records only; no provider or AI client. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, it } from "vitest";
import { MIGRATIONS, Store } from "../src/db/store.ts";
import { InvariantChecker } from "../src/merchant/checker.ts";
import { MerchantRepo, REFERENCE_ORG as ORG } from "../src/merchant/repo.ts";
import { ReferenceMerchant } from "../src/merchant/reference-merchant.ts";
import { buildIncidentApi, ORG_HEADER } from "../src/merchant/api.ts";
import { canonical, RepairService } from "../src/merchant/repair.ts";
import { injectDuplicateOrderRace } from "../src/merchant/fault-injection.ts";

const dir = mkdtempSync(join(tmpdir(), "ot-gate2b-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let serial = 0;
const T = Date.parse("2026-10-19T00:00:00.000Z");
const ID = "ci_00000000-0000-4000-8000-000000000002";
const count = (s: Store, table: string) => (s.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
function fixture(state = "captured", readback = true) {
  const path = join(dir, `${++serial}.sqlite`);
  const s = new Store(path);
  s.createIntentWithAttempt({ id: ID, sku: "SKU", currency: "USD", amount_minor: 100, correlation_id: "synthetic" }, { id: "pa_test", createRequestId: "create", captureRequestId: "capture" });
  s.attachOrder("pa_test", "SYNTHETICORDER", "CREATED");
  s.transition("pa_test", state as "captured", { capture_id: "SYNTHETICCAP", capture_status: state === "captured" ? "COMPLETED" : "PENDING", captured_minor: 100, captured_currency: "USD" });
  const summary = { id: "SYNTHETICORDER", status: "COMPLETED", purchase_units: [{ custom_id: ID, captures: [{ id: "SYNTHETICCAP", status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } }] }] };
  const append = (data: unknown = summary, at = T, status = 200) => Number(s.db.prepare(`INSERT INTO evidence (attempt_id,evidence_class,operation,http_status,correlation_id,summary_json,created_at) VALUES ('pa_test','PAYPAL_API_READBACK','GET',?,'synthetic',?,?)`).run(status, JSON.stringify(data), new Date(at).toISOString()).lastInsertRowid);
  if (readback) append();
  const checker = (now = T + 300_001, graceMs = 300_000) => new InvariantChecker(s, { now: () => now, missingOrderGraceMs: graceMs });
  return { s, path, summary, append, checker, repo: new MerchantRepo(s) };
}

it("completed capture and zero effective orders beyond grace opens exactly one traceable incident", () => {
  const x = fixture();
  try {
    const before = JSON.stringify(x.s.listEvidence("pa_test"));
    const c = x.checker().evaluateIntent(ORG, ID);
    expect(c).toMatchObject({ result: "VIOLATED", incidentOpened: true, activeOrderCount: 0 });
    expect(x.repo.getIncident(ORG, c.incidentId!)!.incident_class).toBe("MISSING_MERCHANT_ORDER");
    const e = x.repo.getEvaluation(ORG, c.evaluationSeq)!;
    expect(JSON.parse(e.facts_json)).toMatchObject({ matchingOrderIds: [], missingOrder: { graceMs: 300000, confirmedAt: "2026-10-19T00:00:00.000Z", dueAt: "2026-10-19T00:05:00.000Z" } });
    expect(x.repo.incidentEvidence(c.incidentId!).map(e => e.evidence_class)).toEqual(["PAYPAL_API_READBACK"]);
    expect(JSON.stringify(x.s.listEvidence("pa_test"))).toBe(before);
    expect(count(x.s, "merchant_orders")).toBe(0);
    for (let i = 0; i < 3; i++) expect(x.checker().evaluateIntent(ORG, ID)).toMatchObject({ incidentId: c.incidentId, incidentOpened: false, evidenceLinked: 0 });
    expect(count(x.s, "incidents")).toBe(1);
  } finally { x.s.close(); }
});

it.each([[299999, false], [300000, true], [300001, true], [-1, false]])("grace boundary %i ms yields incident=%s", (elapsed, incident) => {
  const x = fixture();
  try { expect(x.checker(T + elapsed).evaluateIntent(ORG, ID).incidentOpened).toBe(incident); } finally { x.s.close(); }
});

it("configurable grace is used without changing persisted timestamps", () => {
  const x = fixture();
  try {
    expect(x.checker(T + 999, 1000).evaluateIntent(ORG, ID).incidentOpened).toBe(false);
    expect(x.checker(T + 1000, 1000).evaluateIntent(ORG, ID).incidentOpened).toBe(true);
  } finally { x.s.close(); }
});

it("repeated successful readbacks do not postpone the first persisted confirmation deadline", () => {
  const x = fixture();
  try { x.append(x.summary, T + 100000); expect(x.checker(T + 300000).evaluateIntent(ORG, ID).incidentOpened).toBe(true); } finally { x.s.close(); }
});

it.each(["future", "reversed", "invalid"])("%s confirmation timestamp fails closed", kind => {
  const x = fixture();
  try {
    x.append(x.summary, kind === "future" ? T + 900000 : T - 1);
    if (kind === "invalid") x.s.db.prepare("INSERT INTO evidence (attempt_id,evidence_class,operation,http_status,correlation_id,summary_json,created_at) VALUES ('pa_test','PAYPAL_API_READBACK','GET',200,'synthetic',?,'invalid')").run(JSON.stringify(x.summary));
    expect(x.checker().evaluateIntent(ORG, ID).incidentOpened).toBe(false);
  } finally { x.s.close(); }
});

it("zero grace is explicit and an invalid clock records nothing", () => {
  const x = fixture();
  try {
    expect(() => x.checker(NaN).evaluateIntent(ORG, ID)).toThrow(/clock/);
    expect(count(x.s, "invariant_evaluations")).toBe(0);
    expect(x.checker(T, 0).evaluateIntent(ORG, ID).incidentOpened).toBe(true);
  } finally { x.s.close(); }
});

it.each([-1, NaN, Infinity, 0.5])("invalid grace %s is rejected before recording anything", grace => {
  const x = fixture();
  try { expect(() => x.checker(T, grace).evaluateIntent(ORG, ID)).toThrow(/grace/i); expect(count(x.s, "invariant_evaluations")).toBe(0); } finally { x.s.close(); }
});

it.each(["pending", "uncertain"])("%s local capture never accuses missing order", state => {
  const x = fixture(state);
  try { expect(x.checker().evaluateIntent(ORG, ID).incidentOpened).toBe(false); } finally { x.s.close(); }
});

it("missing authoritative readback never accuses missing order", () => {
  const x = fixture("captured", false);
  try { expect(x.checker().evaluateIntent(ORG, ID).incidentOpened).toBe(false); } finally { x.s.close(); }
});

it.each(["capture", "order"])("missing %s identity on both local state and readback is insufficient evidence", kind => {
  const x = fixture();
  try {
    const data = structuredClone(x.summary);
    if (kind === "capture") {
      x.s.updateAttempt("pa_test", { capture_id: null });
      delete (data.purchase_units[0]!.captures[0]! as { id?: string }).id;
    } else {
      x.s.updateAttempt("pa_test", { paypal_order_id: null });
      delete (data as { id?: string }).id;
    }
    x.append(data, T + 1);
    expect(x.checker().evaluateIntent(ORG, ID)).toMatchObject({ result: "NOT_ELIGIBLE", incidentOpened: false });
  } finally { x.s.close(); }
});

it.each(["REFUNDED", "PARTIALLY_REFUNDED", "PENDING", "DENIED"])("newest %s capture readback suppresses an older completed capture", status => {
  const x = fixture();
  try { const data = structuredClone(x.summary); data.purchase_units[0]!.captures[0]!.status = status; x.append(data, T + 1); expect(x.checker().evaluateIntent(ORG, ID).incidentOpened).toBe(false); } finally { x.s.close(); }
});

it.each(["empty", "wrong-order", "wrong-intent", "wrong-amount", "order-pending", "failed", "malformed", "null", "null-unit", "null-capture"])("latest %s readback fails closed instead of falling back to old success", kind => {
  const x = fixture();
  try {
    const data = structuredClone(x.summary);
    if (kind === "empty") data.purchase_units[0]!.captures = [];
    if (kind === "wrong-order") data.id = "OTHER";
    if (kind === "wrong-intent") data.purchase_units[0]!.custom_id = "OTHER";
    if (kind === "wrong-amount") data.purchase_units[0]!.captures[0]!.amount.value = "2.00";
    if (kind === "order-pending") data.status = "APPROVED";
    const value = kind === "null" ? null : kind === "null-unit" ? { purchase_units: [null] } : kind === "null-capture" ? { purchase_units: [{ captures: [null] }] } : kind === "malformed" ? "invalid shape" : data;
    x.append(value, T + 1, kind === "failed" ? 500 : 200);
    expect(x.checker().evaluateIntent(ORG, ID).incidentOpened).toBe(false);
  } finally { x.s.close(); }
});

it("a contradictory interval restarts grace when a subsequent readback confirms again", () => {
  const x = fixture();
  try {
    x.append({ id: "OTHER", purchase_units: [] }, T + 2);
    x.append(x.summary, T + 100000);
    expect(x.checker(T + 399999).evaluateIntent(ORG, ID).incidentOpened).toBe(false);
    expect(x.checker(T + 400000).evaluateIntent(ORG, ID).incidentOpened).toBe(true);
  } finally { x.s.close(); }
});

it.each(["pre_capture_readback_error", "post_capture_readback_error", "reconcile_readback_error", "readback_error", "webhook_readback_error"])("persisted %s response suppresses detection and resets grace after fresh confirmation", operation => {
  const x = fixture();
  try {
    // CheckoutService writes failed GET observations as RESPONSE, never as successful READBACK.
    x.s.db.prepare("INSERT INTO evidence (attempt_id,evidence_class,operation,http_status,correlation_id,summary_json,created_at) VALUES ('pa_test','PAYPAL_API_RESPONSE',?,503,'synthetic','{}',?)").run(operation, new Date(T + 100000).toISOString());
    expect(x.checker().evaluateIntent(ORG, ID).incidentOpened).toBe(false);
    x.append(x.summary, T + 200000);
    expect(x.checker(T + 499999).evaluateIntent(ORG, ID).incidentOpened).toBe(false);
    expect(x.checker(T + 500000).evaluateIntent(ORG, ID).incidentOpened).toBe(true);
  } finally { x.s.close(); }
});

it("healthy order and late order before the first check produce no missing incident", async () => {
  const x = fixture();
  try { await new ReferenceMerchant(x.s).healthyBothPaths(ORG, ID); expect(x.checker().evaluateIntent(ORG, ID)).toMatchObject({ result: "HOLDS", incidentOpened: false }); } finally { x.s.close(); }
});

it("late order preserves historical incident and evidence while API shows latest healthy observation and no recovery", async () => {
  const x = fixture();
  const app = await buildIncidentApi({ store: x.s });
  try {
    const c = x.checker().evaluateIntent(ORG, ID);
    const evidence = x.repo.incidentEvidence(c.incidentId!);
    await new ReferenceMerchant(x.s).healthyBothPaths(ORG, ID);
    expect(x.checker().evaluateIntent(ORG, ID)).toMatchObject({ result: "HOLDS", incidentOpened: false });
    const r = await app.inject({ url: `/api/incidents/${c.incidentId}`, headers: { [ORG_HEADER]: ORG } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ class: "MISSING_MERCHANT_ORDER", state: "open", openingEvaluation: { result: "VIOLATED" }, latestEvaluation: { result: "HOLDS" }, missingOrder: { recoverySupported: false, lastCheckedCondition: "ORDER_PRESENT", impact: { currency: "USD", minor: 100 } } });
    expect(r.json().missingOrder.nextAction).toMatch(/separate authorization/i);
    expect(x.repo.incidentEvidence(c.incidentId!)).toEqual(evidence);
    expect(count(x.s, "incidents")).toBe(1);
    expect(() => new RepairService(x.s, ORG).plan(c.incidentId!, "tester")).toThrow();
    expect(count(x.s, "repair_plans")).toBe(0);
  } finally { await app.close(); x.s.close(); }
});

it("organization checks and API reads do not disclose another organization's missing incident", async () => {
  const x = fixture();
  const app = await buildIncidentApi({ store: x.s });
  try {
    x.repo.createOrganization("org_other", "Other synthetic org");
    const c = x.checker().evaluateIntent(ORG, ID);
    expect(() => x.checker().evaluateIntent("org_other", ID)).toThrow(/organization/);
    expect(x.checker().evaluateAll("org_other").checks).toEqual([]);
    expect((await app.inject({ url: `/api/incidents/${c.incidentId}`, headers: { [ORG_HEADER]: "org_other" } })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/incidents", headers: { [ORG_HEADER]: "org_other" } })).json().incidents).toEqual([]);
    expect((await app.inject({ url: `/api/incidents/${c.incidentId}` })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/api/incidents/${c.incidentId}`, headers: { [ORG_HEADER]: ORG } })).statusCode).toBe(405);
  } finally { await app.close(); x.s.close(); }
});

it("rollback after incident insertion leaves no half-incident and restart safely retries", () => {
  const x = fixture();
  x.s.db.exec("CREATE TRIGGER synthetic_crash BEFORE INSERT ON incident_evidence BEGIN SELECT RAISE(ABORT,'synthetic crash'); END");
  expect(() => x.checker().evaluateIntent(ORG, ID)).toThrow(/synthetic crash/);
  expect(count(x.s, "incidents")).toBe(0);
  expect(count(x.s, "invariant_evaluations")).toBe(0);
  x.s.db.exec("DROP TRIGGER synthetic_crash");
  x.s.close();
  const s = new Store(x.path);
  try { expect(new InvariantChecker(s, { now: () => T + 300001 }).evaluateIntent(ORG, ID).incidentOpened).toBe(true); } finally { s.close(); }
});

it("committed incident and immutable evidence survive independent connections and restart", () => {
  const x = fixture();
  const c = x.checker().evaluateIntent(ORG, ID);
  const evidence = x.repo.incidentEvidence(c.incidentId!);
  x.s.close();
  const s = new Store(x.path), other = new Store(x.path);
  try {
    for (const db of [s, other]) {
      expect(new InvariantChecker(db, { now: () => T + 300001 }).evaluateIntent(ORG, ID)).toMatchObject({ incidentId: c.incidentId, incidentOpened: false, evidenceLinked: 0 });
      expect(new MerchantRepo(db).incidentEvidence(c.incidentId!)).toEqual(evidence);
      expect(db.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() => db.db.prepare("UPDATE incident_evidence SET summary_json='{}'").run()).toThrow(/append-only/);
      expect(() => db.db.prepare("DELETE FROM invariant_evaluations").run()).toThrow(/append-only/);
    }
    expect(count(s, "incidents")).toBe(1);
  } finally { other.close(); s.close(); }
});

const childArgs = (path: string, mode: string) => ["--import", "tsx", "tests/helpers/missing-order-process.ts", path, ID, mode];
it.each([["crash-before-commit", 77, 0], ["crash-after-commit", 78, 1]] as const)("real child %s persists only committed transactions", (mode, code, committed) => {
  const x = fixture(); x.s.close();
  const child = spawnSync(process.execPath, childArgs(x.path, mode), { timeout: 10000, encoding: "utf8" });
  expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(code);
  const s = new Store(x.path);
  try {
    expect(count(s, "incidents")).toBe(committed);
    expect(count(s, "invariant_evaluations")).toBe(committed);
    expect(count(s, "incident_evidence")).toBe(committed);
    expect(new InvariantChecker(s, { now: () => T + 300001 }).evaluateIntent(ORG, ID).incidentOpened).toBe(committed === 0);
    expect(count(s, "incidents")).toBe(1);
    expect(s.db.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
  } finally { s.close(); }
});

it("concurrent independent processes open exactly one missing incident with no duplicate evidence", async () => {
  const x = fixture(); x.s.close();
  const run = () => new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(process.execPath, childArgs(x.path, "check"), { timeout: 10000 });
    let out = "", err = "";
    child.stdout.on("data", d => out += String(d)); child.stderr.on("data", d => err += String(d));
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(JSON.parse(out) as Record<string, unknown>) : reject(Error(`child ${code}: ${err}`)));
  });
  const checks = await Promise.all([run(), run(), run()]);
  expect(checks.filter(c => c.incidentOpened)).toHaveLength(1);
  expect(new Set(checks.map(c => c.incidentId)).size).toBe(1);
  const s = new Store(x.path);
  try { expect(count(s, "incidents")).toBe(1); expect(count(s, "incident_evidence")).toBe(1); expect(count(s, "invariant_evaluations")).toBe(3); } finally { s.close(); }
});

it("a later duplicate is a separate class and never reuses missing-order evidence or recovery", async () => {
  const x = fixture();
  try {
    const missing = x.checker().evaluateIntent(ORG, ID);
    const original = x.repo.incidentEvidence(missing.incidentId!);
    await injectDuplicateOrderRace(new ReferenceMerchant(x.s), ORG, ID);
    const duplicate = x.checker().evaluateIntent(ORG, ID);
    expect(duplicate.incidentOpened).toBe(true);
    expect(duplicate.incidentId).not.toBe(missing.incidentId);
    expect(x.repo.listIncidents(ORG).map(i => i.incident_class).sort()).toEqual(["DUPLICATE_MERCHANT_ORDER", "MISSING_MERCHANT_ORDER"]);
    expect(x.repo.incidentEvidence(missing.incidentId!)).toEqual(original);
    expect(() => new RepairService(x.s, ORG).plan(missing.incidentId!, "tester")).toThrow();
  } finally { x.s.close(); }
});

it("v6 to v7 migration preserves synthetic duplicate incident, evidence, repair references and immutable guards", async () => {
  const x = fixture();
  await injectDuplicateOrderRace(new ReferenceMerchant(x.s), ORG, ID);
  const duplicate = x.checker().evaluateIntent(ORG, ID);
  new RepairService(x.s, ORG).plan(duplicate.incidentId!, "synthetic reviewer");
  const legacyPath = join(dir, `${++serial}-legacy.sqlite`);
  const legacy = new DatabaseSync(legacyPath);
  // Fixture connection only, not persisted in the file: ~130 autocommitted DDL statements each
  // created and synced a rollback journal, which exceeded 15 s on a GitHub Windows runner.
  legacy.exec("PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF");
  legacy.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (let i = 0; i < 6; i++) { legacy.exec(MIGRATIONS[i]!); legacy.prepare("INSERT INTO schema_migrations VALUES (?, 'synthetic')").run(i + 1); }
  // Hydrate the synthetic v6 database without replaying business transitions; restore ALL
  // original guards before snapshot/migration. This never runs against a historical database.
  const guards = legacy.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger'").all() as Array<{ name: string; sql: string }>;
  for (const g of guards) legacy.exec(`DROP TRIGGER ${g.name}`);
  const tables = (x.s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('sqlite_sequence','schema_migrations') ORDER BY rowid").all() as Array<{ name: string }>).map(t => t.name);
  for (const t of tables) {
    const rows = x.s.db.prepare(`SELECT * FROM ${t}`).all();
    for (const row of rows) {
      const keys = Object.keys(row);
      legacy.prepare(`INSERT OR IGNORE INTO ${t} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row));
    }
  }
  for (const g of guards) legacy.exec(g.sql);
  const stable = (db: DatabaseSync) => canonical(Object.fromEntries(tables.map(t => [t, db.prepare(`SELECT * FROM ${t}`).all()])));
  const before = stable(legacy); legacy.close(); x.s.close();
  const migrated = new Store(legacyPath);
  try {
    expect(stable(migrated.db)).toBe(before);
    expect(migrated.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(migrated.db.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    expect(() => migrated.db.prepare("UPDATE incidents SET title='bad'").run()).toThrow(/immutable/);
    expect(() => migrated.db.prepare("DELETE FROM incidents").run()).toThrow(/never deleted/);
    expect(new MerchantRepo(migrated).getIncident(ORG, duplicate.incidentId!)!.incident_class).toBe("DUPLICATE_MERCHANT_ORDER");
  } finally { migrated.close(); }
});
