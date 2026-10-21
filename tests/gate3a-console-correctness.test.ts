// Gate 3A regressions: console truth claims (A, B, captured value), demo recheck preflight (C) and
// org-scoped legacy links (D). Every database here is NEW and synthetic; nothing historical is opened.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db/store.ts';
import { buildIncidentApi } from '../src/merchant/api.ts';
import { mountConsole } from '../src/merchant/console-static.ts';
import * as Demo from '../src/merchant/console-demo.ts';
import { seedConsoleDemo, CONSOLE_DEMO_CORRELATION } from '../src/merchant/console-demo.ts';
import { InvariantChecker } from '../src/merchant/checker.ts';
import { ReferenceMerchant } from '../src/merchant/reference-merchant.ts';
import { REFERENCE_ORG } from '../src/merchant/repo.ts';
import { RepairService } from '../src/merchant/repair.ts';
import * as M from '../web/console/model.ts';

const ORG = 'org_reference';
const MIN = 60_000;
type Scenario = Parameters<typeof seedConsoleDemo>[2];

async function synthetic(scenarios: Scenario, after?: (store: Store) => Promise<void> | void) {
  const store = new Store(':memory:');
  await seedConsoleDemo(store, Date.now(), scenarios);
  await after?.(store);
  const app = await buildIncidentApi({ store });
  const get = async (url: string, org = ORG) => { const r = await app.inject({ url, headers: { 'x-ordertruth-org': org } }); expect(r.statusCode).toBe(200); return r.json(); };
  const incidents = M.parseIncidents(await get('/api/incidents'), ORG);
  const checkouts = M.linkIncidents(M.parseCheckouts(await get('/api/evaluations'), ORG), incidents);
  const detail = async (id: string) => M.parseDetail(await get(`/api/incidents/${id}`), ORG);
  return { store, app, incidents, checkouts, detail, get, close: async () => { await app.close(); store.close(); } };
}
const verdictOf = (checkouts: M.Checkout[], incidents: M.IncidentSummary[], now = Date.now()) => M.verdict(M.overview(checkouts, incidents, now));
const ALL_CLEAR = 'Every checked payment matches its order.';

describe('A. Overview never claims an all-clear it cannot back', () => {
  it('no incidents but one payment waiting and one unpaid is not "every payment matches"', async () => {
    const s = await synthetic([
      { sku: 'CANVAS-TOTE', minor: 3600, kind: 'healthy', checkoutAgoMs: 240_000, readbackAgoMs: 40_000 },
      { sku: 'RAIN-SHELL', minor: 17200, kind: 'waiting', checkoutAgoMs: 2 * MIN, readbackAgoMs: MIN },
      { sku: 'MERINO-SOCKS', minor: 2400, kind: 'unpaid', checkoutAgoMs: 50_000, readbackAgoMs: 0 },
    ]);
    try {
      expect(s.incidents).toHaveLength(0);
      const v = verdictOf(s.checkouts, s.incidents);
      expect(v.headline).not.toBe(ALL_CLEAR);
      expect(v.tone).toBe('wait');
      expect(v.headline).toBe('No open incidents. 1 payment is still waiting for an order.');
      expect(v.notes.join(' ')).toContain('1 checkout was not captured, so no order is expected.');
    } finally { await s.close(); }
  });

  it('claims the all-clear only when every checked checkout matched', async () => {
    const s = await synthetic([
      { sku: 'CANVAS-TOTE', minor: 3600, kind: 'healthy', checkoutAgoMs: 240_000, readbackAgoMs: 40_000 },
      { sku: 'CAMP-MUG', minor: 1850, kind: 'healthy', checkoutAgoMs: 80_000, readbackAgoMs: 6_000 },
    ]);
    try { expect(verdictOf(s.checkouts, s.incidents)).toEqual({ tone: 'hold', headline: ALL_CLEAR, notes: [] }); } finally { await s.close(); }
  });

  it('separates unpaid checkouts from matched ones and says when nothing was captured', async () => {
    const s = await synthetic([
      { sku: 'CANVAS-TOTE', minor: 3600, kind: 'healthy', checkoutAgoMs: 240_000, readbackAgoMs: 40_000 },
      { sku: 'MERINO-SOCKS', minor: 2400, kind: 'unpaid', checkoutAgoMs: 50_000, readbackAgoMs: 0 },
    ]);
    const u = await synthetic([{ sku: 'MERINO-SOCKS', minor: 2400, kind: 'unpaid', checkoutAgoMs: 50_000, readbackAgoMs: 0 }]);
    try {
      expect(verdictOf(s.checkouts, s.incidents).headline).toBe('Every captured payment matches its order (1 of 2 checkouts).');
      expect(verdictOf(u.checkouts, u.incidents)).toMatchObject({ tone: 'neutral', headline: 'No captured payments to match yet.' });
    } finally { await s.close(); await u.close(); }
  });

  it('flags undecided and contradictory records instead of an all-clear', () => {
    const base: M.Checkout = { intentId: 'ci_00000000-0000-4000-8000-000000000001', seq: 1, sku: 'X', amountMinor: 100, currency: 'USD', createdAt: '2026-01-01T00:00:00.000Z', result: 'HOLDS', outcome: 'matched',
      orders: 1, orderIds: [], paypalOrderId: null, captureId: null, attemptState: 'captured', evaluatedAt: '2026-01-01T00:01:00.000Z', dueAt: null, confirmedAt: null, reasons: [], incidentId: null, graceMs: null, readbackConfirmed: true };
    const unclear = { ...base, intentId: 'ci_00000000-0000-4000-8000-000000000002', result: 'NOT_ELIGIBLE' as const, outcome: 'unclear' as const, readbackConfirmed: false };
    expect(verdictOf([base, unclear], [])).toMatchObject({ tone: 'neutral', headline: 'No open incidents, but 1 check could not decide.' });
    // The latest check says duplicate, yet the incident list has no open incident for it.
    const dup = { ...base, intentId: 'ci_00000000-0000-4000-8000-000000000003', result: 'VIOLATED' as const, outcome: 'duplicate' as const, orders: 2 };
    const v = verdictOf([base, dup], []);
    expect(v).toMatchObject({ tone: 'break', headline: 'Rule checks and incidents disagree.' });
    expect(v.notes[0]).toContain('no open incident');
  });

  it('keeps resolved history visible without hiding it behind the all-clear', async () => {
    const s = await synthetic([
      { sku: 'CANVAS-TOTE', minor: 3600, kind: 'healthy', checkoutAgoMs: 240_000, readbackAgoMs: 40_000 },
      { sku: 'WOOL-BEANIE', minor: 2800, kind: 'duplicate', checkoutAgoMs: 110_000, readbackAgoMs: 9_000 },
    ], store => {
      // SIMULATED_TEST approval: a test fixture, never presented as a genuine human approval.
      const svc = new RepairService(store, ORG);
      const inc = store.db.prepare('SELECT id FROM incidents').get()!.id as string;
      const p = svc.plan(inc, 'Test Requester'); svc.approveSimulated(p.id, p.plan_sha256, 'Test Approver', p.plan_sha256.slice(-8)); svc.execute(p.id);
    });
    try {
      expect(s.incidents.map(i => i.state)).toEqual(['resolved']);
      const v = verdictOf(s.checkouts, s.incidents);
      expect(v).toMatchObject({ tone: 'hold', headline: ALL_CLEAR });
      expect(v.notes).toEqual(['1 incident resolved earlier stays on record under Incidents.']);
    } finally { await s.close(); }
  });
});

describe('B. Grace is read from the stored deadline and grace, never assumed', () => {
  it('distinguishes inside grace, deadline passed but not re-checked, and re-checked after the deadline', async () => {
    const s = await synthetic([{ sku: 'RAIN-SHELL', minor: 17200, kind: 'waiting', checkoutAgoMs: 70_000, readbackAgoMs: 60_000 }],
      store => { new InvariantChecker(store, { missingOrderGraceMs: 120_000 }).evaluateAll(REFERENCE_ORG); });
    try {
      const c = s.checkouts[0]!;
      expect(c).toMatchObject({ outcome: 'waiting', graceMs: 120_000, readbackConfirmed: true });
      const due = Date.parse(c.dueAt!);
      expect(M.graceStatus(c, due - 1)).toMatchObject({ phase: 'inside', label: 'Inside the 2 min grace period' });
      const late = M.graceStatus(c, due + 1)!;
      expect(late).toMatchObject({ phase: 'overdue_unchecked', label: 'Deadline passed, not re-checked' });
      expect(late.label).not.toContain('Inside');
      const o = M.overview(s.checkouts, s.incidents, due + 1);
      expect(o.overdue.map(x => x.sku)).toEqual(['RAIN-SHELL']); expect(o.insideGrace).toEqual([]);
      expect(M.verdict(o).headline).toBe('No open incidents, but 1 payment is overdue for a re-check.');
      expect(o.strip[0]!.label).toContain('Deadline passed, not re-checked');
    } finally { await s.close(); }
  });

  it('a re-check after the deadline opens a missing-order incident and reads as re-checked', async () => {
    const s = await synthetic([{ sku: 'DAYPACK-20L', minor: 8900, kind: 'missing', checkoutAgoMs: 9 * MIN, readbackAgoMs: 8 * MIN }]);
    try {
      const c = s.checkouts[0]!;
      expect(c).toMatchObject({ outcome: 'missing', graceMs: 300_000 });
      expect(M.graceStatus(c, Date.now())).toMatchObject({ phase: 'rechecked_after_deadline' });
      const d = await s.detail(s.incidents[0]!.id);
      expect(d.missing).toMatchObject({ graceMs: 300_000 });
      expect(M.missingNow(d)).toBe('still_missing');
      const t = M.buildTimeline(d, c);
      expect(t.events.find(e => e.key === 'due')!.story).toBe('The 5 min grace period ended and the store still had no order for this payment.');
      expect(t.breaks[0]!.to).toBeNull();
    } finally { await s.close(); }
  });

  it('a late order after a missing-order incident is shown as present, and the incident stays open', async () => {
    const s = await synthetic([{ sku: 'DAYPACK-20L', minor: 8900, kind: 'missing', checkoutAgoMs: 9 * MIN, readbackAgoMs: 8 * MIN }], async store => {
      const intent = store.db.prepare('SELECT id FROM checkout_intents').get()!.id as string;
      await new ReferenceMerchant(store).healthyBothPaths(REFERENCE_ORG, intent);
      new InvariantChecker(store).evaluateAll(REFERENCE_ORG);
    });
    try {
      expect(s.incidents.map(i => i.state)).toEqual(['open']);
      const d = await s.detail(s.incidents[0]!.id);
      expect(M.missingNow(d)).toBe('late_order');
      const t = M.buildTimeline(d, s.checkouts[0]!);
      const lateIdx = t.events.findIndex(e => e.lane === 'store' && e.key.startsWith('o'));
      expect(lateIdx).toBeGreaterThan(0);
      expect(t.breaks[0]!.to).toBe(lateIdx);
    } finally { await s.close(); }
  });

  it('the console source carries no hardcoded five-minute grace text', () => {
    for (const f of ['web/console/main.ts', 'web/console/model.ts']) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/5 minute grace|five-minute grace/i);
    }
  });
});

describe('captured value is only what a stored PayPal readback confirmed', () => {
  it('excludes a capture recorded locally without a confirming readback and says so', async () => {
    const s = await synthetic([
      { sku: 'CANVAS-TOTE', minor: 3600, kind: 'healthy', checkoutAgoMs: 240_000, readbackAgoMs: 40_000 },
      { sku: 'CAMP-MUG', minor: 1850, kind: 'healthy', checkoutAgoMs: 80_000, readbackAgoMs: 6_000 },
    ], store => {
      // Synthetic only: the local attempt still says captured, but the newest stored readback shows the capture refunded,
      // so no rule check can rely on it.
      const row = store.db.prepare("SELECT a.id, a.paypal_order_id p, a.capture_id c, a.intent_id i FROM payment_attempts a JOIN checkout_intents i ON i.id=a.intent_id WHERE i.sku='CAMP-MUG'").get()!;
      const summary = { id: row.p, status: 'COMPLETED', purchase_units: [{ custom_id: row.i, captures: [{ id: row.c, status: 'REFUNDED', amount: { currency_code: 'USD', value: '18.50' } }] }] };
      store.db.prepare("INSERT INTO evidence(attempt_id,evidence_class,operation,http_status,correlation_id,summary_json,created_at) VALUES(?,'PAYPAL_API_READBACK','GET',200,?,?,?)")
        .run(row.id as string, CONSOLE_DEMO_CORRELATION, JSON.stringify(summary), new Date().toISOString());
      new InvariantChecker(store).evaluateAll(REFERENCE_ORG);
    });
    try {
      const by = Object.fromEntries(s.checkouts.map(c => [c.sku, c]));
      expect(by['CAMP-MUG']).toMatchObject({ attemptState: 'captured', readbackConfirmed: false });
      expect(by['CANVAS-TOTE']).toMatchObject({ readbackConfirmed: true });
      const o = M.overview(s.checkouts, s.incidents);
      expect(o).toMatchObject({ capturedMinor: 3600, capturedConfirmed: 1, capturedUnconfirmed: 1 });
      expect(M.verdict(o).notes.join(' ')).toContain('without a confirming PayPal readback');
    } finally { await s.close(); }
  });
});

/* ---------------- C. demo recheck preflight ---------------- */
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const recheck = (path: string) => spawnSync(process.execPath, ['--import', 'tsx', 'src/merchant/console-demo.ts', '--recheck', '--out', path], { timeout: 20000, encoding: 'utf8' });
const tables = (p: string) => { const u = new URL(`file:///${p.replace(/\\/g, '/')}`); u.searchParams.set('immutable', '1'); const d = new DatabaseSync(u as never, { readOnly: true }); try { return (d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name); } finally { d.close(); } };
async function demoDb(dir: string, name = 'demo.sqlite', mutate?: (s: Store) => void) {
  const p = join(dir, name); const s = new Store(p);
  await seedConsoleDemo(s, Date.now(), [{ sku: 'RAIN-SHELL', minor: 17200, kind: 'waiting', checkoutAgoMs: 2 * MIN, readbackAgoMs: MIN }]);
  mutate?.(s); s.close(); return p;
}

describe('C. demo recheck refuses every non-demo target before anything opens it for writing', () => {
  it('a foreign SQLite database is refused and left byte-identical, with no migration applied', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ot-3a-c-'));
    try {
      const p = join(dir, 'foreign.sqlite');
      const d = new DatabaseSync(p); d.exec("CREATE TABLE notes(x TEXT); INSERT INTO notes VALUES ('keep');"); d.close();
      const before = sha(p);
      const r = recheck(p);
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stderr).toContain('console demo refused');
      expect(sha(p)).toBe(before);
      expect(tables(p)).toEqual(['notes']);
      expect(existsSync(`${p}-wal`)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a migrated but empty database instead of passing vacuously', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ot-3a-c-'));
    try {
      const p = join(dir, 'empty.sqlite'); new Store(p).close(); const before = sha(p);
      const r = recheck(p);
      expect(r.status, r.stdout + r.stderr).toBe(2); expect(r.stderr).toMatch(/no checkouts/);
      expect(sha(p)).toBe(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([
    ['malformed bytes', (dir: string) => { const p = join(dir, 'bad.sqlite'); writeFileSync(p, 'not a database at all'); return p; }, /not a SQLite database/],
    ['a directory', (dir: string) => { const p = join(dir, 'folder.sqlite'); mkdirSync(p); return p; }, /not a regular file/],
    ['a missing file', (dir: string) => join(dir, 'absent.sqlite'), /not found/],
    ['a truncated SQLite header', (dir: string) => { const p = join(dir, 'trunc.sqlite'); writeFileSync(p, Buffer.from('SQLite format 3\0')); return p; }, /malformed|unreadable|not a SQLite database/],
  ])('refuses %s without creating or changing anything', (_name, make, why) => {
    const dir = mkdtempSync(join(tmpdir(), 'ot-3a-c-'));
    try {
      const p = make(dir);
      const before = existsSync(p) && !p.endsWith('folder.sqlite') ? sha(p) : null;
      const r = recheck(p);
      expect(r.status, r.stdout + r.stderr).toBe(2); expect(r.stderr).toMatch(why);
      if (before) expect(sha(p)).toBe(before);
      expect(existsSync(`${p}-wal`)).toBe(false); expect(existsSync(`${p}-shm`)).toBe(false);
      if (p.endsWith('absent.sqlite')) expect(existsSync(p)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses mixed demo and non-demo records, and schemas older or newer than this build', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ot-3a-c-'));
    try {
      const mixed = await demoDb(dir, 'mixed.sqlite', s => s.createIntentWithAttempt({ id: 'ci_00000000-0000-4000-8000-0000000000aa', sku: 'REAL', currency: 'USD', amount_minor: 100, correlation_id: 'not-a-demo' }, { id: 'pa_mixed', createRequestId: 'c-mixed', captureRequestId: 'k-mixed' }));
      const foreignOrder = await demoDb(dir, 'order.sqlite', s => s.db.prepare("UPDATE payment_attempts SET paypal_order_id='5O190127TN364715T'").run());
      const older = await demoDb(dir, 'older.sqlite', s => s.db.prepare('DELETE FROM schema_migrations WHERE version=(SELECT MAX(version) FROM schema_migrations)').run());
      const newer = await demoDb(dir, 'newer.sqlite', s => s.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES ((SELECT MAX(version)+1 FROM schema_migrations), '2026-01-01T00:00:00.000Z')").run());
      for (const [p, why] of [[mixed, /non-demo checkout/], [foreignOrder, /non-demo PayPal identifier/], [older, /schema version/], [newer, /schema version/]] as const) {
        const before = sha(p), r = recheck(p);
        expect(r.status, `${p}\n${r.stdout}${r.stderr}`).toBe(2); expect(r.stderr).toMatch(why);
        expect(sha(p)).toBe(before);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a synthetic protected path, including a case-changed alias, before reading it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ot-3a-c-'));
    try {
      const p = join(dir, 'Protected.sqlite'); writeFileSync(p, 'never read');
      expect(Demo.preflightDemoRecheck(p, [p])).toEqual({ ok: false, reason: 'refusing protected historical database' });
      expect(Demo.preflightDemoRecheck(p.toUpperCase(), [p])).toMatchObject({ ok: false, reason: 'refusing protected historical database' });
      expect(readFileSync(p, 'utf8')).toBe('never read');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('re-checks a genuine synthetic demo database, and only then migrates nothing new', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ot-3a-c-'));
    try {
      const p = await demoDb(dir);
      expect(Demo.preflightDemoRecheck(p, [])).toMatchObject({ ok: true });
      const r = recheck(p);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain('Checks: OUT_OF_SCOPE 1');
      expect(r.stdout).toContain('after the 5 min grace period');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/* ---------------- D. org-scoped legacy links ---------------- */
describe('D. legacy incident links keep their organization scope', () => {
  const id = 'inc_00000000-0000-4000-8000-000000000024';
  async function server() {
    const dir = mkdtempSync(join(tmpdir(), 'ot-3a-d-')); mkdirSync(join(dir, 'assets')); writeFileSync(join(dir, 'index.html'), '<h1>Console</h1>');
    const store = new Store(':memory:'); const app = await buildIncidentApi({ store }); await mountConsole(app, dir);
    return { app, close: async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
  }
  it('carries a valid org through the redirect, and keeps the old redirect when no org is given', async () => {
    const s = await server();
    try {
      for (const url of [`/investigation/${id}?org=org_other`, `/investigation/${id}/?mode=local&org=org_other`]) {
        const r = await s.app.inject(url); expect(r.statusCode, url).toBe(302); expect(r.headers.location).toBe(`/console/incidents/${id}?lens=eng&org=org_other`);
      }
      const plain = await s.app.inject(`/investigation/${id}`); expect(plain.headers.location).toBe(`/console/incidents/${id}?lens=eng`);
    } finally { await s.close(); }
  });
  it('rejects a malformed, empty or repeated org instead of defaulting, and a wrong incident ID', async () => {
    const s = await server();
    try {
      for (const url of [`/investigation/${id}?org=ORG_OTHER`, `/investigation/${id}?org=`, `/investigation/${id}?org=org_a&org=org_b`, `/investigation/${id}?org=org_x%2F..`, `/investigation/${id}?org=org_${'a'.repeat(41)}`]) {
        const r = await s.app.inject(url); expect(r.statusCode, url).toBe(400); expect(r.headers.location).toBeUndefined();
        expect(r.headers['content-security-policy']).toContain("default-src 'self'");
      }
      expect((await s.app.inject('/investigation/inc_wrong?org=org_other')).statusCode).toBe(404);
    } finally { await s.close(); }
  });
  it('the console reads the link scope strictly: none, valid, or invalid, never a silent default', () => {
    expect(M.scopeFromUrl('?lens=eng')).toEqual({ kind: 'none' });
    expect(M.scopeFromUrl('?lens=eng&org=org_other')).toEqual({ kind: 'valid', org: 'org_other' });
    for (const q of ['?org=', '?org=Org_other', '?org=org_a&org=org_b', '?org=org_other%20', '?org=reference']) expect(M.scopeFromUrl(q).kind, q).toBe('invalid');
  });
  it('a valid but different org cannot read another org\'s incident', async () => {
    const s = await synthetic([{ sku: 'WOOL-BEANIE', minor: 2800, kind: 'duplicate', checkoutAgoMs: 110_000, readbackAgoMs: 9_000 }]);
    try {
      const inc = s.incidents[0]!.id;
      const other = await s.app.inject({ url: `/api/incidents/${inc}`, headers: { 'x-ordertruth-org': 'org_other' } });
      expect(other.statusCode).toBe(404);
      const unknown = await s.app.inject({ url: `/api/incidents/${inc}`, headers: { 'x-ordertruth-org': 'org_nobody' } });
      expect(unknown.statusCode).toBeGreaterThanOrEqual(400); expect(unknown.body).not.toContain(inc);
    } finally { await s.close(); }
  });
});
