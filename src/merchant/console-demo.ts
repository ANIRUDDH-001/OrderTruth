// Console demo seeder: builds a NEW synthetic database for the operations console. No provider
// client, AI client, environment loader or network import exists in this process. Every row is
// synthetic; PAYPAL_API_READBACK rows are constructed readback snapshots, labelled as such in their
// correlation id. Historical databases are refused, and an existing output is never overwritten.
//   pnpm console:demo                       seed .work/console-demo/console.sqlite
//   pnpm console:demo --recheck             re-run the invariant checker on that database (grace can elapse)
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, Store } from "../db/store.ts";
import { DEFAULT_MISSING_ORDER_GRACE_MS } from "./missing-order.ts";
import { InvariantChecker, type IntentCheck } from "./checker.ts";
import { injectDuplicateOrderRace } from "./fault-injection.ts";
import { ReferenceMerchant } from "./reference-merchant.ts";
import { MerchantRepo, REFERENCE_ORG } from "./repo.ts";

export const CONSOLE_DEMO_CORRELATION = "synthetic-console-demo";
const PROTECTED = [".work/ordertruth.sqlite", ".work/stage1d/review/fault.sqlite", ".work/runs/gate1-human-demo-prep/actual-evidence-demo.sqlite"];

type Scenario = { sku: string; minor: number; kind: "healthy" | "duplicate" | "missing" | "waiting" | "unpaid"; checkoutAgoMs: number; readbackAgoMs: number };
const MIN = 60_000;
export const SCENARIOS: Scenario[] = [
  // Order rows are stamped when written (now), so scenarios with orders keep the readback close to now.
  { sku: "CANVAS-TOTE", minor: 3600, kind: "healthy", checkoutAgoMs: 240_000, readbackAgoMs: 40_000 },
  { sku: "TRAIL-RUNNER-42", minor: 12900, kind: "healthy", checkoutAgoMs: 190_000, readbackAgoMs: 25_000 },
  { sku: "FIELD-JACKET-M", minor: 14800, kind: "duplicate", checkoutAgoMs: 160_000, readbackAgoMs: 18_000 },
  { sku: "DAYPACK-20L", minor: 8900, kind: "missing", checkoutAgoMs: 9 * MIN, readbackAgoMs: 8 * MIN },
  { sku: "WOOL-BEANIE", minor: 2800, kind: "duplicate", checkoutAgoMs: 110_000, readbackAgoMs: 9_000 },
  { sku: "CAMP-MUG", minor: 1850, kind: "healthy", checkoutAgoMs: 80_000, readbackAgoMs: 6_000 },
  { sku: "RAIN-SHELL", minor: 17200, kind: "waiting", checkoutAgoMs: 2 * MIN, readbackAgoMs: 1 * MIN },
  { sku: "MERINO-SOCKS", minor: 2400, kind: "unpaid", checkoutAgoMs: 50_000, readbackAgoMs: 0 },
];

const token = (n: number) => randomUUID().replace(/-/g, "").toUpperCase().slice(0, n);
const money = (minor: number) => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;

/** Seeds one scenario into a fresh synthetic store. Timestamps are constructed relative to `now`. */
export async function seedConsoleDemo(store: Store, now = Date.now(), scenarios = SCENARIOS) {
  const repo = new MerchantRepo(store), merchant = new ReferenceMerchant(store);
  if (repo.listIntentIds(REFERENCE_ORG).length > 0) throw Error("database already has checkouts; seed a new file");
  repo.createOrganization("org_other", "Synthetic isolation control");
  const at = (ago: number) => new Date(now - ago).toISOString();
  for (const s of scenarios) {
    const intent = `ci_${randomUUID()}`, attempt = `pa_${token(16).toLowerCase()}`, order = `DEMO${token(13)}`, capture = `DEMOCAP${token(10)}`;
    store.createIntentWithAttempt({ id: intent, sku: s.sku, currency: "USD", amount_minor: s.minor, correlation_id: CONSOLE_DEMO_CORRELATION }, { id: attempt, createRequestId: `demo-create-${token(8)}`, captureRequestId: `demo-capture-${token(8)}` });
    // Synthetic timeline only: the checkout started before its readback, as it would in a real flow.
    store.db.prepare("UPDATE checkout_intents SET created_at=? WHERE id=?").run(at(s.checkoutAgoMs), intent);
    store.db.prepare("UPDATE payment_attempts SET created_at=? WHERE id=?").run(at(s.checkoutAgoMs), attempt);
    store.attachOrder(attempt, order, "CREATED");
    if (s.kind === "unpaid") continue;
    store.transition(attempt, "captured", { capture_id: capture, capture_status: "COMPLETED", captured_minor: s.minor, captured_currency: "USD" });
    const summary = { id: order, status: "COMPLETED", purchase_units: [{ custom_id: intent, captures: [{ id: capture, status: "COMPLETED", amount: { currency_code: "USD", value: money(s.minor) } }] }] };
    store.db.prepare("INSERT INTO evidence(attempt_id,evidence_class,operation,http_status,correlation_id,summary_json,created_at) VALUES(?,'PAYPAL_API_READBACK','GET',200,?,?,?)")
      .run(attempt, CONSOLE_DEMO_CORRELATION, JSON.stringify(summary), at(s.readbackAgoMs));
    if (s.kind === "healthy") await merchant.healthyBothPaths(REFERENCE_ORG, intent);
    if (s.kind === "duplicate") await injectDuplicateOrderRace(merchant, REFERENCE_ORG, intent);
  }
  return new InvariantChecker(store).evaluateAll(REFERENCE_ORG);
}

function refuse(m: string): never { console.error(`console demo refused: ${m}`); process.exit(2); }

const PROTECTED_PATHS = () => PROTECTED.map(x => resolve(x));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const real = (p: string) => { try { return realpathSync(p); } catch { return null; } };
function isProtected(p: string, protectedPaths: string[]) {
  const rp = real(p);
  return protectedPaths.some(x => same(resolve(p), resolve(x)) || (rp !== null && real(x) !== null && same(rp, real(x)!)));
}
const identity = (p: string) => { const s = lstatSync(p); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`; };
export type RecheckPreflight = { ok: true; path: string; identity: string } | { ok: false; reason: string };
/** Strictly read-only gate for --recheck. Runs before anything opens the file for writing (Store migrates
 * on open), and fails closed on any target that is not a current, synthetic console demo database. */
export function preflightDemoRecheck(target: string, protectedPaths = PROTECTED_PATHS()): RecheckPreflight {
  const no = (reason: string): RecheckPreflight => ({ ok: false, reason });
  const path = resolve(target);
  if (isProtected(path, protectedPaths)) return no("refusing protected historical database");
  let st; try { st = lstatSync(path); } catch { return no("database not found; seed it first"); }
  if (st.isSymbolicLink() || !st.isFile()) return no("target is not a regular file (directories and links are refused)");
  const head = Buffer.alloc(16), fd = openSync(path, "r");
  try { if (readSync(fd, head, 0, 16, 0) < 16) return no("target is not a SQLite database"); } finally { closeSync(fd); }
  if (head.toString("latin1") !== "SQLite format 3\0") return no("target is not a SQLite database");
  // A live WAL pair is opened read-only as is; otherwise immutable=1 so SQLite creates no -wal or -shm file.
  const wal = existsSync(`${path}-wal`), shm = existsSync(`${path}-shm`);
  if (wal !== shm) return no("database has a partial write-ahead log; stop other processes and retry");
  const url = pathToFileURL(path); url.searchParams.set(wal ? "mode" : "immutable", wal ? "ro" : "1");
  let db: DatabaseSync;
  try { db = new DatabaseSync(url, { readOnly: true }); } catch { return no("database is malformed or unreadable"); }
  try {
    const one = <T>(sql: string, ...args: string[]) => db.prepare(sql).get(...args) as T;
    if (one<{ quick_check: string }>("PRAGMA quick_check").quick_check !== "ok") return no("database is malformed or unreadable");
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name));
    if (!["schema_migrations", "checkout_intents", "payment_attempts", "evidence"].every(t => tables.has(t))) return no("not an OrderTruth database; recheck only runs on a console demo database");
    const v = one<{ n: number; v: number | null }>("SELECT COUNT(*) n, MAX(version) v FROM schema_migrations");
    if (v.n !== MIGRATIONS.length || v.v !== MIGRATIONS.length) return no(`schema version ${v.v ?? 0} does not match this build (${MIGRATIONS.length}); refusing to migrate`);
    if (one<{ n: number }>("SELECT COUNT(*) n FROM checkout_intents").n === 0) return no("database has no checkouts; recheck only runs on a seeded console demo database");
    if (one<{ n: number }>("SELECT COUNT(*) n FROM checkout_intents WHERE correlation_id <> ?", CONSOLE_DEMO_CORRELATION).n > 0) return no("database holds a non-demo checkout; recheck only runs on a console demo database");
    if (one<{ n: number }>("SELECT COUNT(*) n FROM payment_attempts WHERE (paypal_order_id IS NOT NULL AND paypal_order_id NOT GLOB 'DEMO*') OR (capture_id IS NOT NULL AND capture_id NOT GLOB 'DEMOCAP*')").n > 0) return no("database holds a non-demo PayPal identifier; refusing");
    if (one<{ n: number }>("SELECT COUNT(*) n FROM evidence WHERE evidence_class IN ('PAYPAL_API_READBACK','PAYPAL_API_RESPONSE','PAYPAL_VERIFIED_WEBHOOK') AND correlation_id <> ?", CONSOLE_DEMO_CORRELATION).n > 0) return no("database holds non-demo PayPal evidence; refusing");
    if (tables.has("webhook_deliveries") && one<{ n: number }>("SELECT COUNT(*) n FROM webhook_deliveries").n > 0) return no("database holds webhook deliveries; not a console demo database");
  } catch { return no("database is malformed or unreadable"); } finally { db.close(); }
  return { ok: true, path, identity: identity(path) };
}

async function main() {
  const { values: a } = parseArgs({ options: { out: { type: "string", default: ".work/console-demo/console.sqlite" }, recheck: { type: "boolean", default: false } } });
  const out = resolve(a.out!);
  if (isProtected(out, PROTECTED_PATHS())) refuse("refusing protected historical database");
  if (a.recheck) {
    const pre = preflightDemoRecheck(out);
    if (!pre.ok) refuse(pre.reason);
    // Narrow the gap between the read-only check and the writable open: the file must be the one just checked.
    if (identity(out) !== pre.identity) refuse("database changed during preflight; retry");
    const store = new Store(out);
    try { report(out, new InvariantChecker(store).evaluateAll(REFERENCE_ORG).checks); } finally { store.close(); }
    return;
  }
  for (const p of [out, `${out}-wal`, `${out}-shm`]) if (existsSync(p)) refuse(`${p} exists; refusing to overwrite (move it away or pass --out)`);
  mkdirSync(dirname(out), { recursive: true });
  const store = new Store(out);
  try { report(out, (await seedConsoleDemo(store)).checks); } finally { store.close(); }
}

function report(out: string, checks: IntentCheck[]) {
  const tally = checks.reduce<Record<string, number>>((m, c) => ((m[c.result] = (m[c.result] ?? 0) + 1), m), {});
  console.log(`Synthetic console database: ${out}`);
  console.log(`Checks: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  for (const c of checks) if (c.incidentOpened) console.log(`Incident opened: ${c.incidentId}`);
  console.log("\nServe it (127.0.0.1 only):");
  console.log(`  pnpm build && pnpm incidents --db "${out}"`);
  console.log("  then open http://127.0.0.1:3003/console/ (scope org_reference; a dev header, not authentication)");
  console.log("\nRepair a duplicate through the local CLI (approval needs an interactive terminal):");
  console.log(`  pnpm repair plan --db "${out}" --org org_reference --incident <inc_id> --requester "<your name>"`);
  console.log(`  pnpm repair approve --db "${out}" --org org_reference --plan <rp_id> --plan-sha256 <sha> --operator "<your name>"`);
  console.log(`  pnpm repair execute --db "${out}" --org org_reference --plan <rp_id>`);
  console.log(`\nRe-run checks after the ${DEFAULT_MISSING_ORDER_GRACE_MS / MIN} min grace period: pnpm console:demo --recheck --out "${out}"`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
