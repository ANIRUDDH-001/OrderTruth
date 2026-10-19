// Stage 1C demo: healthy vs CONTROLLED_FAULT_INJECTION on ISOLATED COPIES of a real database.
// The source database is only ever byte-copied (never opened, never migrated); its sha256 is
// checked before and after. No PayPal client exists in this process: no network call is possible
// from the merchant, the injector or the checker. Copies migrate to the Stage 1C schema.
import { copyFileSync, createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Store } from "../db/store.ts";
import { buildIncidentApi, ORG_HEADER } from "./api.ts";
import { InvariantChecker } from "./checker.ts";
import { injectDuplicateOrderRace } from "./fault-injection.ts";
import { ReferenceMerchant } from "./reference-merchant.ts";
import { REFERENCE_ORG } from "./repo.ts";

const sha256 = (p: string) =>
  new Promise<string>((ok, fail) => {
    const h = createHash("sha256");
    createReadStream(p).on("data", (d) => h.update(d)).on("end", () => ok(h.digest("hex"))).on("error", fail);
  });

function fail(msg: string): never {
  console.error(`stage1c demo refused: ${msg}`);
  process.exit(2);
}

const { values: a } = parseArgs({
  options: {
    source: { type: "string", default: ".work/ordertruth.sqlite" },
    "out-dir": { type: "string", default: ".work/stage1c" },
    "report-dir": { type: "string", default: ".work/runs/stage1c" },
    mode: { type: "string", default: "both" },
    "target-order": { type: "string" },
  },
});
const source = resolve(a.source!);
const outDir = resolve(a["out-dir"]!);
const reportDir = resolve(a["report-dir"]!);
const modes = a.mode === "both" ? (["healthy", "fault"] as const) : a.mode === "healthy" || a.mode === "fault" ? ([a.mode] as const) : fail("--mode must be healthy, fault or both");
const target = a["target-order"];
if (modes.includes("fault" as never) && !target) fail("--target-order <PayPal order id> is required for fault mode");
if (target && !/^[A-Z0-9]{10,30}$/.test(target)) fail("--target-order is not a PayPal order id");
if (!existsSync(source)) fail("source database not found");
// A -wal file means the source has uncheckpointed writes; a byte copy would not be a snapshot.
if (existsSync(`${source}-wal`)) fail("source has a -wal file (writer active or unclean shutdown); stop it first");

async function run(mode: "healthy" | "fault", sourceSha: string) {
  const copy = resolve(outDir, `${mode}.sqlite`);
  if (copy === source) fail("copy path equals source");
  for (const p of [copy, `${copy}-wal`, `${copy}-shm`]) if (existsSync(p)) fail(`${p} exists; refusing to overwrite (move it away first)`);
  copyFileSync(source, copy);
  if ((await sha256(copy)) !== sourceSha) fail("copy is not byte-identical to source");

  const store = new Store(copy);
  try {
    const merchant = new ReferenceMerchant(store);
    const actions: Array<Record<string, unknown>> = [];
    let targetFound = false;
    for (const intentId of merchant.repo.listIntentIds(REFERENCE_ORG)) {
      const att = store.getAttemptByIntentId(intentId);
      if (att?.state !== "captured") continue;
      if (mode === "fault" && att.paypal_order_id === target) {
        targetFound = true;
        const r = await injectDuplicateOrderRace(merchant, REFERENCE_ORG, intentId);
        actions.push({ intentId, paypalOrderId: att.paypal_order_id, action: "CONTROLLED_FAULT_INJECTION", faultInjectionId: r.faultInjectionId, ordersCreated: r.results.filter((x) => x.created).length });
      } else {
        const r = await merchant.healthyBothPaths(REFERENCE_ORG, intentId);
        actions.push({ intentId, paypalOrderId: att.paypal_order_id, action: "healthy both paths", ordersCreated: r.filter((x) => x.created).length });
      }
    }
    if (mode === "fault" && !targetFound) fail("target order is not a captured intent in the source database");

    const checks = new InvariantChecker(store).evaluateAll(REFERENCE_ORG);
    const app = await buildIncidentApi({ store });
    const h = { [ORG_HEADER]: REFERENCE_ORG };
    const list = (await app.inject({ url: "/api/incidents", headers: h })).json() as { incidents: Array<{ id: string }> };
    const details = [];
    for (const i of list.incidents) details.push((await app.inject({ url: `/api/incidents/${i.id}`, headers: h })).json());
    // A second (empty) organization in the COPY only, to show cross-org reads see nothing.
    let otherOrg: number | null = null;
    if (list.incidents[0]) {
      merchant.repo.createOrganization("org_other_demo", "Stage 1C demo: other organization (copy only)");
      otherOrg = (await app.inject({ url: `/api/incidents/${list.incidents[0].id}`, headers: { [ORG_HEADER]: "org_other_demo" } })).statusCode;
    }
    await app.close();

    const orders = store.db.prepare("SELECT intent_id, paypal_order_id, capture_id, created_by_path, fault_injection_id FROM merchant_orders ORDER BY intent_id, created_by_path").all();
    const report = {
      mode,
      label: mode === "fault" ? "CONTROLLED_FAULT_INJECTION on an isolated copy" : "HEALTHY negative control on an isolated copy",
      sourceSha256: sourceSha,
      copy,
      actions,
      merchantOrders: orders,
      checks: checks.checks.filter((c) => c.result !== "NOT_ELIGIBLE"),
      notEligibleIntents: checks.checks.filter((c) => c.result === "NOT_ELIGIBLE").length,
      incidents: details,
      crossOrgDetailStatus: otherOrg,
    };
    writeFileSync(resolve(reportDir, `demo-${mode}.json`), JSON.stringify(report, null, 2));
    const byResult = checks.checks.reduce<Record<string, number>>((m, c) => ((m[c.result] = (m[c.result] ?? 0) + 1), m), {});
    console.log(`${mode}: orders=${orders.length} results=${JSON.stringify(byResult)} incidents=${details.length}${otherOrg === null ? "" : ` crossOrgStatus=${otherOrg}`}`);
  } finally {
    store.close();
  }
}

mkdirSync(outDir, { recursive: true });
mkdirSync(reportDir, { recursive: true });
const before = await sha256(source);
for (const m of modes) await run(m, before);
const after = await sha256(source);
if (after !== before || existsSync(`${source}-wal`)) fail("SOURCE DATABASE CHANGED during the demo");
console.log(`source sha256 unchanged: ${after}`);
