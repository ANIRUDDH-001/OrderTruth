import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/store.ts';
import { buildIncidentApi } from '../src/merchant/api.ts';
import { mountConsole, CONSOLE_CSP } from '../src/merchant/console-static.ts';
import { seedConsoleDemo } from '../src/merchant/console-demo.ts';
import { RepairService } from '../src/merchant/repair.ts';
import * as M from '../web/console/model.ts';
import { ApiError, getJson } from '../web/console/api.ts';

const ORG = 'org_reference';
const H = { 'x-ordertruth-org': ORG };

async function seeded() {
  const store = new Store(':memory:');
  const checks = (await seedConsoleDemo(store)).checks;
  const app = await buildIncidentApi({ store });
  const get = async (url: string, org = ORG) => { const r = await app.inject({ url, headers: { 'x-ordertruth-org': org } }); expect(r.statusCode).toBe(200); return r.json(); };
  const load = async () => {
    const incidents = M.parseIncidents(await get('/api/incidents'), ORG);
    const checkouts = M.linkIncidents(M.parseCheckouts(await get('/api/evaluations'), ORG), incidents);
    return { incidents, checkouts };
  };
  const detail = async (id: string) => M.parseDetail(await get(`/api/incidents/${id}`), ORG);
  const changes = () => store.db.prepare('SELECT total_changes() n').get()!.n as number;
  return { store, app, checks, get, load, detail, changes, close: async () => { await app.close(); store.close(); } };
}

describe('console over the real read-only API on a synthetic seed', () => {
  it('maps every seeded scenario to the right outcome, totals and incident links without writing', async () => {
    const s = await seeded();
    try {
      const tally = s.checks.reduce<Record<string, number>>((m, c) => ((m[c.result] = (m[c.result] ?? 0) + 1), m), {});
      expect(tally).toEqual({ HOLDS: 3, VIOLATED: 3, OUT_OF_SCOPE: 1, NOT_ELIGIBLE: 1 });
      const before = s.changes();
      const { incidents, checkouts } = await s.load();
      const by = Object.fromEntries(checkouts.map(c => [c.sku, c]));
      expect(Object.fromEntries(checkouts.map(c => [c.sku, c.outcome]))).toEqual({
        'CANVAS-TOTE': 'matched', 'TRAIL-RUNNER-42': 'matched', 'CAMP-MUG': 'matched', 'FIELD-JACKET-M': 'duplicate',
        'WOOL-BEANIE': 'duplicate', 'DAYPACK-20L': 'missing', 'RAIN-SHELL': 'waiting', 'MERINO-SOCKS': 'unpaid' });
      // Violation facts nest the attempt under repairFacts; the console must still read the payment.
      for (const sku of ['FIELD-JACKET-M', 'WOOL-BEANIE']) { expect(by[sku]!.attemptState).toBe('captured'); expect(by[sku]!.paypalOrderId).toMatch(/^DEMO/); expect(by[sku]!.orders).toBe(2); }
      for (const c of checkouts) expect(c.createdAt).not.toBeNull();
      expect(incidents).toHaveLength(3);
      for (const sku of ['FIELD-JACKET-M', 'WOOL-BEANIE', 'DAYPACK-20L']) expect(by[sku]!.incidentId).toMatch(/^inc_[0-9a-f-]{36}$/);
      expect(by['CAMP-MUG']!.incidentId).toBeNull();
      const o = M.overview(checkouts, incidents);
      expect(o).toMatchObject({ checked: 8, matched: 3, resolved: 0, unpaid: 1, unclear: 0, capturedMinor: 3600 + 12900 + 14800 + 8900 + 2800 + 1850 + 17200, atRiskMinor: 14800 + 2800 + 8900 });
      expect(o.open).toHaveLength(3); expect(o.waiting.map(c => c.sku)).toEqual(['RAIN-SHELL']);
      expect(o.strip.map(x => x.intentId).sort()).toEqual(checkouts.map(c => c.intentId).sort());
      expect(s.changes()).toBe(before);
    } finally { await s.close(); }
  });

  it('draws a broken seam for duplicate and missing incidents and offers only honest next steps', async () => {
    const s = await seeded();
    try {
      const { incidents, checkouts } = await s.load();
      for (const i of incidents) {
        const d = await s.detail(i.id), c = checkouts.find(x => x.intentId === i.intentId)!;
        const t = M.buildTimeline(d, c), st = M.repairStage(d, Date.now());
        expect(t.events[0]!.key).toBe('checkout');
        expect(t.columns.map(x => Date.parse(x.at))).toEqual(t.columns.map(x => Date.parse(x.at)).toSorted((a, b) => a - b));
        expect(t.healedAt).toBeNull();
        // Nothing has been repaired yet, and every record names what it can and cannot show.
        expect(d.records).toEqual([]);
        for (const e of d.evidence) expect(M.scopeOf(e.cls).not.length).toBeGreaterThan(0);
        if (d.kind === 'duplicate') {
          // The opening check cited the PayPal readback and every store order it counted.
          expect(d.evidence.filter(e => e.cited).map(e => e.cls).toSorted()).toEqual(['MERCHANT_DB_OBSERVED', 'MERCHANT_DB_OBSERVED', 'PAYPAL_API_READBACK']);
          expect(d.evidence.filter(e => e.cls === 'MERCHANT_DB_OBSERVED').every(e => e.snapshotStatus === 'placed' && e.nowStatus === 'placed')).toBe(true);
          expect(t.breaks).toEqual([{ from: t.events.findIndex(e => e.title === 'Extra order created'), to: null, label: 'More than one live order' }]);
          expect(st.stage).toBe('needs_plan');
          expect(M.repairCommands(st, i.id, ORG).map(x => x.command)).toEqual([expect.stringContaining('repair plan'), expect.stringContaining('repair approve'), expect.stringContaining('repair execute')]);
        } else {
          expect(d.kind).toBe('missing');
          expect(t.breaks).toEqual([{ from: t.events.findIndex(e => e.lane === 'paypal'), to: null, label: 'No store order' }]);
          expect(t.events.some(e => e.key === 'due')).toBe(true);
          expect(st.stage).toBe('unsupported');
          expect(M.repairCommands(st, i.id, ORG)).toEqual([]);
        }
        // Every command keeps the database a placeholder; no real path reaches the page.
        for (const x of M.repairCommands(st, i.id, ORG)) expect(x.command).toContain(M.DB_PLACEHOLDER);
      }
    } finally { await s.close(); }
  });

  it('walks a duplicate through plan, expiry, simulated approval, execution and heal', async () => {
    const s = await seeded();
    try {
      const { incidents } = await s.load();
      const [a, b] = incidents.filter(i => i.kind === 'duplicate');
      const svc = new RepairService(s.store, ORG);
      const plan = svc.plan(a!.id, 'Test Requester');
      let d = await s.detail(a!.id);
      let st = M.repairStage(d, Date.now());
      expect(st.stage).toBe('awaiting_approval');
      const cmds = M.repairCommands(st, a!.id, ORG).map(x => x.command).join('\n');
      expect(cmds).toContain(`--plan ${plan.id}`); expect(cmds).toContain(`--plan-sha256 ${plan.plan_sha256}`);
      expect(M.repairStage(d, Date.parse(plan.expires_at) + 1).stage).toBe('expired');

      const p2 = svc.plan(b!.id, 'Test Requester');
      svc.approveSimulated(p2.id, p2.plan_sha256, 'Test Approver', p2.plan_sha256.slice(-8));
      expect(M.repairStage(await s.detail(b!.id), Date.now()).stage).toBe('approved');
      svc.execute(p2.id);
      d = await s.detail(b!.id);
      st = M.repairStage(d, Date.now());
      expect(st.stage).toBe('resolved');
      if (st.stage === 'resolved') expect(st.resolution.postcondition?.result).toBe('HOLDS');
      expect(d.approvals[0]!.mode).toBe('SIMULATED_TEST');
      // The stored record lists every row in time order, and the voided store row reads as changed since detection.
      expect(d.records.map(r => r.kind).filter(k => k !== 'audit')).toEqual(['plan', 'approval', 'void', 'resolution', 'run']);
      expect(d.records.filter(r => r.kind === 'audit').map(r => r.text)).toEqual(['Audit entry 2: PLANNED.', 'Audit entry 3: APPROVED.', 'Audit entry 4: SUCCEEDED.']); // entry 1 is the other incident's plan
      expect(d.records.map(r => Date.parse(r.at!))).toEqual(d.records.map(r => Date.parse(r.at!)).toSorted((x, y) => x - y));
      expect(d.records.find(r => r.kind === 'approval')!.text).toBe(`Test Approver approved plan ${M.shortId(p2.id)} (simulated in a test). The name is declared, not authenticated.`);
      expect(d.records.find(r => r.kind === 'run')!.text).toMatch(/ended SUCCEEDED\. Stored PayPal evidence hash unchanged\.$/);
      expect(d.records.find(r => r.kind === 'resolution')!.text).toMatch(/^Resolved by check #\d+: HOLDS, 1 live order\.$/);
      expect(d.records.find(r => r.kind === 'plan')!.fields.find(([k]) => k === 'plan_sha256')![1]).toBe(p2.plan_sha256);
      const voided = d.orders.find(o => o.effective !== 'placed')!.id;
      expect(d.evidence.find(e => e.refId === voided)).toMatchObject({ snapshotStatus: 'placed', nowStatus: 'voided_duplicate', cited: true });
      const t = M.buildTimeline(d, null);
      expect(t.healedAt).not.toBeNull();
      expect(t.breaks[0]!.to).toBe(t.healedAt);
      expect(t.events[t.healedAt!]!.key).toMatch(/^void:/);
      const after = await s.load();
      // Repair-written evaluations nest the attempt under repairFacts; the payment must still read as captured.
      const ca = after.checkouts.find(c => c.intentId === a!.intentId)!, cb = after.checkouts.find(c => c.intentId === b!.intentId)!;
      expect([ca.outcome, ca.attemptState]).toEqual(['duplicate', 'captured']);
      expect([cb.outcome, cb.attemptState, cb.orders]).toEqual(['matched', 'captured', 1]);
      expect(ca.paypalOrderId).toMatch(/^DEMO/); expect(cb.captureId).toMatch(/^DEMOCAP/);
      expect(M.overview(after.checkouts, after.incidents)).toMatchObject({ resolved: 1, matched: 4, capturedMinor: 3600 + 12900 + 14800 + 8900 + 2800 + 1850 + 17200 });
      expect(after.checkouts.find(c => c.intentId === b!.intentId)!.incidentId).toBe(b!.id);
    } finally { await s.close(); }
  });

  it('serves a rules-only advisory, read-only and org-scoped', async () => {
    const s = await seeded();
    try {
      const { incidents } = await s.load();
      const before = s.changes();
      for (const i of incidents) {
        const raw = await s.get(`/api/incidents/${i.id}/advisory`);
        expect(raw.providerConfigured).toBe(false);
        const a = M.parseAdvisory(raw, i.id, ORG);
        expect(a.calls).toBe(0);
        expect(() => M.parseAdvisory(raw, i.id, 'org_other')).toThrow();
      }
      const id = incidents[0]!.id, url = `/api/incidents/${id}/advisory`;
      expect((await s.app.inject({ url })).statusCode).toBe(401);
      expect((await s.app.inject({ url, headers: { 'x-ordertruth-org': 'org_nobody' } })).statusCode).toBe(401);
      expect((await s.app.inject({ url, headers: { 'x-ordertruth-org': 'org_other' } })).statusCode).toBe(404);
      expect((await s.app.inject({ url: '/api/incidents/inc_bad/advisory', headers: H })).statusCode).toBe(400);
      expect((await s.app.inject({ url: '/api/incidents/inc_00000000-0000-4000-8000-000000000000/advisory', headers: H })).statusCode).toBe(404);
      for (const method of ['POST', 'PUT', 'DELETE'] as const) expect((await s.app.inject({ method, url, headers: H })).statusCode).toBe(405);
      expect(s.changes()).toBe(before);
    } finally { await s.close(); }
  });

  it('keeps organizations apart and finds records by item, ID or outcome', async () => {
    const s = await seeded();
    try {
      const other = M.parseCheckouts(await s.get('/api/evaluations', 'org_other'), 'org_other');
      expect(other).toEqual([]);
      expect(() => M.parseCheckouts({ organizationId: 'org_other', evaluations: [] }, ORG)).toThrow(/different organization/);
      const { incidents, checkouts } = await s.load();
      const idx = M.searchIndex(incidents, checkouts);
      const beanie = M.search(idx, 'beanie');
      expect(beanie.map(x => x.kind)).toEqual(['incident', 'checkout']);
      expect(beanie.every(x => x.href.startsWith('/console/incidents/inc_'))).toBe(true);
      const mug = checkouts.find(c => c.sku === 'CAMP-MUG')!;
      expect(M.search(idx, mug.paypalOrderId!.toLowerCase())[0]!.href).toBe(`/console/checkouts?q=${mug.intentId}`);
      expect(M.search(idx, 'zzzz')).toEqual([]);
      expect(M.search(idx, '   ')).toEqual([]);
      expect(checkouts.filter(c => M.matchesQuery(c, 'duplicate')).map(c => c.sku).sort()).toEqual(['FIELD-JACKET-M', 'WOOL-BEANIE']);
    } finally { await s.close(); }
  });
});

describe('console model edges', () => {
  it('derives outcomes from rule results without guessing', () => {
    expect(M.outcomeOf('HOLDS', 1, 'captured', null)).toBe('matched');
    expect(M.outcomeOf('VIOLATED', 2, 'captured', null)).toBe('duplicate');
    expect(M.outcomeOf('VIOLATED', 0, 'captured', null)).toBe('missing');
    expect(M.outcomeOf('VIOLATED', 1, 'captured', null)).toBe('unclear');
    expect(M.outcomeOf('OUT_OF_SCOPE', 0, 'captured', '2026-01-01T00:00:00.000Z')).toBe('waiting');
    expect(M.outcomeOf('NOT_ELIGIBLE', 0, 'awaiting_buyer_approval', null)).toBe('unpaid');
    expect(M.outcomeOf('NOT_ELIGIBLE', 0, null, null)).toBe('unclear');
  });
  it.each([null, [], {}, { organizationId: ORG }, { organizationId: ORG, evaluations: 'x' }])('rejects malformed evaluations %j', raw => expect(() => M.parseCheckouts(raw, ORG)).toThrow());
  it('drops malformed rows instead of inventing values', () => {
    expect(M.parseCheckouts({ organizationId: ORG, evaluations: [{ seq: 1 }, { seq: 2, intentId: 'ci_x', result: 'HOLDS', activeOrderCount: 1, evaluatedAt: '2026-01-01T00:00:00Z' }] }, ORG)).toEqual([]);
    expect(M.parseIncidents({ organizationId: ORG, incidents: [{ id: 'nope' }] }, ORG)).toEqual([]);
  });
  it('formats money, references and lenses', () => {
    expect(M.money(2800)).toBe('$28.00'); expect(M.money(null)).toBe('Amount unavailable');
    expect(M.incidentRef('inc_3ac2b007-414a-4016-9999-24e7bd0c8af6')).toBe('INC-3AC2B0');
    expect(M.lensFrom('?lens=eng')).toBe('eng'); expect(M.lensFrom('?lens=<x>')).toBe('ops'); expect(M.lensFrom('')).toBe('ops');
  });
});

describe('console API client', () => {
  const reply = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;
  it('maps every failure to a named kind and sends only the scope header', async () => {
    let seen: RequestInit | undefined;
    const ok = (async (_u: string, init: RequestInit) => { seen = init; return new Response('{"a":1}', { status: 200 }); }) as unknown as typeof fetch;
    expect(await getJson('/api/incidents', ORG, ok)).toEqual({ a: 1 });
    expect(seen).toMatchObject({ method: 'GET', credentials: 'omit', headers: H });
    const kind = async (f: typeof fetch, org = ORG) => { try { await getJson('/api/x', org, f); return 'none'; } catch (e) { return e instanceof ApiError ? e.kind : 'other'; } };
    expect(await kind(ok, 'Bad Scope')).toBe('scope');
    expect(await kind(reply(401, ''))).toBe('scope');
    expect(await kind(reply(404, ''))).toBe('not_found');
    expect(await kind(reply(400, ''))).toBe('bad_request');
    expect(await kind(reply(500, ''))).toBe('server');
    expect(await kind(reply(200, '<html>'))).toBe('malformed');
    expect(await kind(reply(200, 'x'.repeat(1_000_001)))).toBe('malformed');
    expect(await kind((async () => { throw new TypeError('refused'); }) as unknown as typeof fetch)).toBe('network');
  });
});

describe('console serving', () => {
  it('serves the shell on valid deep links, a 404 shell elsewhere, assets only from the build, and never accepts writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ot-console-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<h1>Console</h1>'); writeFileSync(join(dir, 'assets', 'app.js'), '// app'); writeFileSync(join(dir, 'assets', '.env'), 'SECRET=1'); writeFileSync(join(dir, 'private.sqlite'), 'db');
    const store = new Store(':memory:'); const app = await buildIncidentApi({ store });
    try {
      await mountConsole(app, dir);
      for (const url of ['/console/', '/console/incidents', '/console/checkouts', '/console/recovery', '/console/incidents/inc_3ac2b007-414a-4016-9999-24e7bd0c8af6']) {
        const r = await app.inject(url);
        expect(r.statusCode, url).toBe(200); expect(r.body).toContain('Console');
        expect(r.headers['content-security-policy']).toBe(CONSOLE_CSP);
        expect(r.headers['cache-control']).toBe('no-store'); expect(r.headers['x-content-type-options']).toBe('nosniff');
        expect(r.headers['access-control-allow-origin']).toBeUndefined();
      }
      for (const url of ['/console/settings', '/console/incidents/not-an-id', '/console/a/b/c']) {
        const r = await app.inject(url);
        expect(r.statusCode, url).toBe(404); expect(r.headers['content-type']).toContain('text/html'); expect(r.headers['content-security-policy']).toBe(CONSOLE_CSP);
      }
      for (const url of ['/', '/console']) { const r = await app.inject(url); expect(r.statusCode).toBe(302); expect(r.headers.location).toBe('/console/'); }
      expect((await app.inject('/console/assets/app.js')).statusCode).toBe(200);
      expect((await app.inject('/console/assets/missing.js')).headers['content-type']).not.toContain('text/html');
      expect((await app.inject('/console/assets/.env')).body).not.toContain('SECRET');
      expect((await app.inject('/console/private.sqlite')).body).not.toContain('db\n');
      expect((await app.inject('/console/assets/../private.sqlite')).body).not.toBe('db');
      for (const method of ['POST', 'PUT', 'DELETE'] as const) expect((await app.inject({ method, url: '/console/' })).statusCode).toBe(405);
    } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses to start without a build', async () => {
    const store = new Store(':memory:'); const app = await buildIncidentApi({ store });
    try { await expect(mountConsole(app, join(tmpdir(), 'ot-no-console-build'))).rejects.toThrow(/build missing/); } finally { await app.close(); store.close(); }
  });
});
