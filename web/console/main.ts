import { h, icon, clear } from './dom.ts';
import { getJson, ApiError, ORG_PATTERN, INCIDENT_PATTERN } from './api.ts';
import { fetchDetail } from './load.ts';
import * as M from './model.ts';
import type { Checkout, IncidentSummary, Detail, Advisory, Stage, Timeline, Lens } from './model.ts';

/* ---------------- state ---------------- */
const ORG_KEY = 'ordertruth.console.org';
const DEFAULT_ORG = 'org_reference';
function storedOrg(): string {
  try { const v = localStorage.getItem(ORG_KEY); return v && ORG_PATTERN.test(v) ? v : DEFAULT_ORG; } catch { return DEFAULT_ORG; }
}
const state = {
  org: storedOrg(),
  checkouts: [] as Checkout[],
  incidents: [] as IncidentSummary[],
  loadedAt: null as number | null,
  error: null as Error | null,
  loading: null as Promise<void> | null,
  details: new Map<string, Promise<{ detail: Detail; advisory: Advisory | Error }>>(),
  scopeEditing: false,
};
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const main = $('main');

async function loadAll(): Promise<void> {
  if (state.loading) return state.loading;
  state.loading = (async () => {
    try {
      const [inc, ev] = await Promise.all([getJson('/api/incidents', state.org), getJson('/api/evaluations', state.org)]);
      const incidents = M.parseIncidents(inc, state.org);
      state.checkouts = M.linkIncidents(M.parseCheckouts(ev, state.org), incidents);
      state.incidents = incidents;
      state.error = null;
      state.loadedAt = Date.now();
    } catch (e) {
      state.error = e instanceof Error ? e : Error('Unknown failure');
      state.checkouts = []; state.incidents = []; state.loadedAt = null;
    } finally {
      state.loading = null;
      renderShell();
    }
  })();
  return state.loading;
}
function loadDetail(id: string) {
  let p = state.details.get(id);
  if (!p) {
    p = (async () => {
      const detail = await fetchDetail(id, state.org);
      let advisory: Advisory | Error;
      try { advisory = M.parseAdvisory(await getJson(`/api/incidents/${id}/advisory`, state.org), id, state.org); } catch (e) { advisory = e instanceof Error ? e : Error('Guidance unavailable'); }
      return { detail, advisory };
    })();
    p.catch(() => state.details.delete(id));
    state.details.set(id, p);
  }
  return p;
}

/* ---------------- shell ---------------- */
function renderShell() {
  const open = state.incidents.filter(i => i.state === 'open').length;
  const count = $('open-count');
  count.hidden = open === 0; count.textContent = String(open); count.setAttribute('aria-label', `${open} open`);
  const checked = $('checked');
  checked.textContent = state.loadedAt ? `Updated ${M.clock(new Date(state.loadedAt).toISOString())}` : state.error ? (state.error instanceof ApiError && state.error.kind === 'scope' ? 'Scope not found' : 'Not connected') : 'Loading…';
  renderScope(); renderHealth();
}
function renderScope() {
  const box = $('scope');
  const initials = state.org.replace(/^org_/, '').slice(0, 2).toUpperCase();
  if (!state.scopeEditing) {
    clear(box, h('div', { class: 'scope-row' }, h('span', { class: 'scope-av', 'aria-hidden': 'true' }, initials),
      h('div', {}, h('b', {}, state.org), h('small', {}, 'Dev scope, not a sign-in')),
      h('button', { class: 'link', onclick: () => { state.scopeEditing = true; renderScope(); ($('scope-input') as HTMLInputElement).focus(); } }, 'Change')));
    return;
  }
  const input = h('input', { id: 'scope-input', name: 'org', value: state.org, required: true, pattern: ORG_PATTERN.source.slice(1, -1), 'aria-describedby': 'scope-hint scope-err', autocomplete: 'off', spellcheck: 'false' });
  const err = h('p', { class: 'err', id: 'scope-err', 'aria-live': 'polite' });
  input.addEventListener('input', () => { err.textContent = ''; input.removeAttribute('aria-invalid'); });
  const form = h('form', { novalidate: true, onsubmit: (e: Event) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!ORG_PATTERN.test(v)) { err.textContent = 'Use the form org_name: lowercase letters, digits and underscores.'; input.setAttribute('aria-invalid', 'true'); return; }
    setOrg(v);
  } },
    h('label', { for: 'scope-input', class: 'hint', id: 'scope-hint' }, 'Organization to read. This header scopes records; it does not authenticate you.'),
    input, err,
    h('div', { class: 'scope-row' }, h('button', { class: 'btn pri sm', type: 'submit' }, 'Use scope'), h('button', { class: 'btn sec sm', type: 'button', onclick: () => { state.scopeEditing = false; renderScope(); } }, 'Cancel')));
  clear(box, form);
}
function setOrg(org: string) {
  state.org = org; state.scopeEditing = false; state.details.clear();
  try { localStorage.setItem(ORG_KEY, org); } catch { /* per-viewer convenience only */ }
  renderShell();
  if (location.pathname.startsWith('/console/incidents/')) navigate('/console/incidents', true);
  void loadAll().then(route);
}
function renderHealth() {
  const api = state.error instanceof ApiError && (state.error.kind === 'network' || state.error.kind === 'server') ? 'bad' : state.error ? 'bad' : state.loadedAt ? 'ok' : 'off';
  const apiText = api === 'ok' ? 'Connected' : api === 'bad' ? (state.error instanceof ApiError && state.error.kind === 'scope' ? 'Unknown scope' : 'Not reachable') : 'Connecting';
  clear($('health'),
    h('li', {}, h('span', { class: `dot ${api}` }), h('div', {}, 'Incident API', h('small', {}, apiText))),
    h('li', {}, h('span', { class: 'dot off' }), h('div', {}, 'PayPal', h('small', {}, 'Not contacted by this console'))),
    h('li', {}, h('span', { class: 'dot off' }), h('div', {}, 'AI advisory', h('small', {}, 'Not configured, rules only'))));
}

/* ---------------- router ---------------- */
type Route = { page: 'overview' | 'incidents' | 'incident' | 'checkouts' | 'recovery' | 'missing'; id?: string };
function parseRoute(path: string): Route {
  const p = path.replace(/\/+$/, '') || '/';
  if (p === '/console') return { page: 'overview' };
  if (p === '/console/incidents') return { page: 'incidents' };
  if (p === '/console/checkouts') return { page: 'checkouts' };
  if (p === '/console/recovery') return { page: 'recovery' };
  const m = /^\/console\/incidents\/([^/]+)$/.exec(p);
  if (m && INCIDENT_PATTERN.test(m[1]!)) return { page: 'incident', id: m[1]! };
  return { page: 'missing' };
}
let firstRender = true;
function navigate(url: string, replace = false) {
  if (replace) history.replaceState(null, '', url); else history.pushState(null, '', url);
  void route();
}
const params = () => new URLSearchParams(location.search);
function setParam(key: string, value: string | null) {
  const p = params(); if (value === null || value === '') p.delete(key); else p.set(key, value);
  const qs = p.toString(); history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}`);
}
async function route() {
  const r = parseRoute(location.pathname);
  const navKey = r.page === 'incident' ? 'incidents' : r.page;
  document.querySelectorAll<HTMLAnchorElement>('[data-nav]').forEach(a => a.dataset.nav === navKey ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  $('rail').classList.remove('open'); $('menu-btn').setAttribute('aria-expanded', 'false');
  closeResults();
  const focus = !firstRender; firstRender = false;
  if (!state.loadedAt && !state.error) { renderLoading(); await loadAll(); }
  if (parseRoute(location.pathname).page !== r.page || (r.id && parseRoute(location.pathname).id !== r.id)) return; // navigated meanwhile
  if (r.page === 'missing') renderNotFound();
  else if (state.error) renderError(state.error);
  else if (r.page === 'overview') renderOverview();
  else if (r.page === 'incidents') renderIncidents();
  else if (r.page === 'checkouts') renderCheckouts();
  else if (r.page === 'recovery') await renderRecovery();
  else if (r.page === 'incident') await renderIncident(r.id!);
  if (focus) main.focus({ preventScroll: false });
  window.scrollTo({ top: 0 });
}
document.addEventListener('click', e => {
  const a = (e.target as Element).closest?.('a');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target === '_blank') return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/console')) return;
  e.preventDefault(); navigate(url.pathname + url.search);
});
window.addEventListener('popstate', () => void route());

/* ---------------- shared pieces ---------------- */
const title = (t: string) => { document.title = `${t} · OrderTruth`; };
const statusPill = (label: string, tone: M.Tone) => h('span', { class: `st ${tone}` }, label);
const evChip = (cls: string, label?: string) => h('span', { class: `ev ${M.EVIDENCE_LABEL[cls] ? cls : 'UNKNOWN'}`, title: cls }, label ?? M.EVIDENCE_LABEL[cls] ?? cls);
const agoEl = (iso: string | null) => h('span', { 'data-ago': iso ?? '', title: M.utc(iso) }, M.ago(iso, Date.now()));
function plainTitle(i: { kind: M.IncidentKind; orderCount: number }, sku: string) {
  return i.kind === 'duplicate' ? `One payment, ${i.orderCount} orders` : i.kind === 'missing' ? 'Paid, but no order' : `Contract broken for ${sku}`;
}
function toast(text: string, bad = false) {
  const t = $('toast'); t.textContent = text; t.classList.toggle('bad', bad); t.classList.add('on');
  window.setTimeout(() => t.classList.remove('on'), 2600);
}
function command(c: string) {
  // Flags never wrap at their own hyphens; long values (hashes, IDs) may still break anywhere.
  const code = h('code', {}, c.split(/(--[a-z0-9-]+)/).map(t => t.startsWith('--') ? h('span', { class: 'nb' }, t) : t));
  const btn = h('button', { type: 'button', 'aria-label': 'Copy command', onclick: async () => {
    try { await navigator.clipboard.writeText(c); toast('Command copied'); btn.lastChild!.textContent = 'Copied'; window.setTimeout(() => { btn.lastChild!.textContent = 'Copy'; }, 1800); }
    catch { const range = document.createRange(); range.selectNodeContents(code); const sel = getSelection(); sel?.removeAllRanges(); sel?.addRange(range); toast('Clipboard blocked. The command is selected; press Ctrl+C.', true); }
  } }, icon('copy'), h('span', {}, 'Copy'));
  return h('div', { class: 'cmd' }, code, btn);
}
function renderLoading() {
  clear(main, h('div', { class: 'skel h1', 'aria-hidden': 'true' }), h('div', { class: 'skel p', 'aria-hidden': 'true' }), h('div', { class: 'skel block', 'aria-hidden': 'true' }), h('p', { class: 'vh', role: 'status' }, 'Loading'));
}
function renderError(e: Error) {
  const scope = e instanceof ApiError && e.kind === 'scope';
  const network = e instanceof ApiError && e.kind === 'network';
  title(scope ? 'Unknown scope' : 'Not connected');
  clear(main, h('div', { class: 'state', role: 'alert' },
    h('div', { class: 'state-mark bad' }, icon(scope ? 'lock' : 'plug')),
    h('h1', {}, scope ? 'This organization is not in the database' : network ? 'The incident API is not reachable' : 'The console could not read the incident API'),
    h('p', {}, e.message),
    network ? h('p', {}, 'Run ', h('code', {}, 'pnpm incidents --db <isolated.sqlite>'), ' and reload. This console never shows sample data in place of real records.') : null,
    h('div', { class: 'actions' },
      h('button', { class: 'btn pri', onclick: () => void refresh() }, icon('refresh'), 'Try again'),
      scope ? h('button', { class: 'btn sec', onclick: () => { state.scopeEditing = true; renderScope(); $('rail').classList.add('open'); ($('scope-input') as HTMLInputElement).focus(); } }, 'Change scope') : null)));
}
function renderNotFound(message = 'There is no console page at this address.') {
  title('Not found');
  clear(main, h('div', { class: 'state' }, h('div', { class: 'state-mark' }, icon('search')), h('h1', {}, 'Nothing here'), h('p', {}, message),
    h('div', { class: 'actions' }, h('a', { class: 'btn pri', href: '/console/' }, 'Go to overview'), h('a', { class: 'btn sec', href: '/console/incidents' }, 'View incidents'))));
}

/* ---------------- overview ---------------- */
function renderOverview() {
  title('Overview');
  const o = M.overview(state.checkouts, state.incidents);
  const byIntent = new Map(state.checkouts.map(c => [c.intentId, c]));
  if (o.checked === 0) {
    clear(main, h('div', { class: 'state' }, h('div', { class: 'state-mark' }, icon('list')), h('h1', {}, 'No checkouts have been checked yet'),
      h('p', {}, `OrderTruth has no rule checks for ${state.org}. Seed a synthetic database with `, h('code', {}, 'pnpm console:demo'), ' or run the checker, then refresh.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn pri', onclick: () => void refresh() }, icon('refresh'), 'Refresh'))));
    return;
  }
  const n = o.open.length;
  const headline = n === 0 ? 'Every checked payment matches its order.' : `${n} payment${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} attention.`;
  const nextDue = o.waiting[0]?.dueAt ?? null;
  clear(main,
    h('div', { class: 'head' }, h('div', {}, h('h1', {}, headline),
      h('p', { class: 'lede' }, `OrderTruth compared ${o.checked} checkout${o.checked === 1 ? '' : 's'} with their PayPal captures and store orders. Last check `, agoEl(o.lastCheckedAt), '.'))),
    h('section', { class: 'panel ov-strip', 'aria-labelledby': 'strip-h' },
      h('div', { class: 'ph' }, h('h2', { id: 'strip-h' }, 'Every checkout, oldest to newest'), h('span', { class: 'sub' }, 'Select a red block to open its incident')),
      h('div', { class: 'strip', role: 'list' }, o.strip.map(s => s.href
        ? h('a', { role: 'listitem', class: s.outcome, href: s.href, 'aria-label': s.label, title: s.label })
        : h('span', { role: 'listitem', class: s.outcome, 'aria-label': s.label, title: s.label }))),
      h('div', { class: 'strip-legend', 'aria-hidden': 'true' }, h('span', {}, h('i', { class: 'matched' }), 'Matched'), h('span', {}, h('i', { class: 'break' }), 'Duplicate or missing order'), h('span', {}, h('i', { class: 'waiting' }), 'Waiting inside grace'), h('span', {}, h('i', { class: 'neutral' }), 'Not captured or undecided')),
      h('div', { class: 'kpis' },
        h('div', {}, h('small', {}, 'Captured value checked'), h('b', {}, M.money(o.capturedMinor)), h('em', {}, 'from PayPal readbacks')),
        h('div', {}, h('small', {}, 'Matched'), h('b', {}, `${o.matched} of ${o.checked}`), h('em', {}, 'one capture, one order')),
        h('div', {}, h('small', {}, 'Open incidents'), h('b', { class: n ? 'break' : '' }, String(n)), h('em', {}, n ? `${M.money(o.atRiskMinor)} in affected payments` : `${o.resolved} resolved`)),
        h('div', {}, h('small', {}, 'Waiting for an order'), h('b', {}, String(o.waiting.length)), h('em', {}, nextDue ? h('span', {}, 'next deadline ', h('span', { 'data-ago': nextDue }, M.ago(nextDue, Date.now()))) : 'none inside grace')))),
    h('div', { class: 'ov-grid' },
      h('section', { class: 'panel', 'aria-labelledby': 'att-h' },
        h('div', { class: 'ph' }, h('h2', { id: 'att-h' }, 'Needs attention'), h('span', { class: 'sub' }, 'Open incidents, newest first'), h('div', { class: 'r' }, h('a', { class: 'btn sec sm', href: '/console/incidents' }, 'All incidents'))),
        n === 0 ? h('p', { class: 'empty' }, 'Nothing needs attention. Resolved incidents stay listed under Incidents.') :
          h('ul', { class: 'att' }, o.open.map(i => {
            const c = byIntent.get(i.intentId);
            return h('li', {}, h('a', { href: `/console/incidents/${i.id}` },
              h('span', { class: 'sev', 'aria-hidden': 'true' }, icon('alert')),
              h('span', {}, h('span', { class: 't' }, `${plainTitle(i, c?.sku ?? '')} · ${c?.sku ?? 'Checkout'}`), h('span', { class: 'd' }, `${M.incidentRef(i.id)} · ${M.KIND_LABEL[i.kind]} · opened `, agoEl(i.openedAt))),
              h('span', { class: 'amt' }, M.money(c?.amountMinor ?? null, c?.currency), h('small', {}, 'paid once'))));
          }))),
      h('div', { class: 'stack' },
        h('section', { class: 'panel', 'aria-labelledby': 'wait-h' },
          h('div', { class: 'ph' }, h('h2', { id: 'wait-h' }, 'Waiting for an order'), h('span', { class: 'sub' }, 'Paid, inside the 5 minute grace')),
          o.waiting.length === 0 ? h('p', { class: 'empty' }, 'No payment is waiting for its order.') :
            h('ul', { class: 'wait-list' }, o.waiting.map(c => h('li', {}, icon('clock'),
              h('div', {}, h('b', {}, `${c.sku} · ${M.money(c.amountMinor, c.currency)}`), h('small', {}, `Captured ${M.clock(c.confirmedAt)} · no order yet`)),
              h('span', { class: 'due' }, 'deadline ', h('span', { 'data-ago': c.dueAt ?? '' }, M.ago(c.dueAt, Date.now())))))),
          o.waiting.length ? h('p', { class: 'empty' }, 'This is the last recorded check. The incident opens only when the checker runs again after the deadline.') : null),
        h('section', { class: 'panel', 'aria-labelledby': 'read-h' },
          h('div', { class: 'ph' }, h('h2', { id: 'read-h' }, 'How to read the evidence')),
          h('ul', { class: 'legend-list' },
            h('li', {}, evChip('PAYPAL_API_READBACK'), 'Stored answer from the PayPal API. Not refreshed by this page.'),
            h('li', {}, evChip('MERCHANT_DB_OBSERVED'), 'Seen in the store’s own database.'),
            h('li', {}, evChip('DETERMINISTIC_EVALUATION'), 'OrderTruth’s rule: one capture, one live order.'),
            h('li', {}, evChip('CONTROLLED_FAULT_INJECTION'), 'A deliberate lab fault, never a customer event.'),
            h('li', {}, evChip('OPERATOR_STATEMENT'), 'A person’s typed statement. Dashed means claimed, not proven.'))))));
}

/* ---------------- incidents list ---------------- */
function renderIncidents() {
  title('Incidents');
  const filter = (['open', 'resolved', 'all'] as const).find(f => f === params().get('filter')) ?? 'open';
  const q = params().get('q') ?? '';
  const byIntent = new Map(state.checkouts.map(c => [c.intentId, c]));
  const counts = { open: state.incidents.filter(i => i.state === 'open').length, resolved: state.incidents.filter(i => i.state === 'resolved').length, all: state.incidents.length };
  const body = h('tbody');
  const fill = () => {
    const f = (['open', 'resolved', 'all'] as const).find(x => x === params().get('filter')) ?? 'open', query = (params().get('q') ?? '').toLowerCase().trim();
    const rows = state.incidents.filter(i => f === 'all' || i.state === f).filter(i => !query || [i.id, M.incidentRef(i.id), i.title, M.KIND_LABEL[i.kind], byIntent.get(i.intentId)?.sku, i.paypalOrderId, i.captureId, i.intentId].join(' ').toLowerCase().includes(query))
      .toSorted((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
    clear(body, rows.length === 0 ? h('tr', {}, h('td', { colspan: '5', class: 'empty' }, query ? `No incidents match “${query}”.` : f === 'open' ? 'No open incidents. Every checked payment matches its order, or is still inside its grace period.' : f === 'resolved' ? 'No resolved incidents yet. Resolved incidents appear here after a repair and re-check.' : 'No incidents have been opened for this organization.')) :
      rows.map(i => {
        const c = byIntent.get(i.intentId), href = `/console/incidents/${i.id}`;
        return h('tr', { class: 'go', onclick: (e: Event) => { if (!(e.target as Element).closest('a')) navigate(href); } },
          h('td', {}, h('a', { class: 'row-link', href }, plainTitle(i, c?.sku ?? '')), h('small', {}, `${M.incidentRef(i.id)} · ${M.KIND_LABEL[i.kind]}`)),
          h('td', {}, h('span', { class: 'strong' }, c?.sku ?? 'Unknown item'), h('small', {}, M.money(c?.amountMinor ?? null, c?.currency))),
          h('td', { class: 'hide-sm' }, String(i.orderCount), h('small', {}, i.kind === 'missing' ? 'expected 1' : 'live or voided')),
          h('td', { class: 'hide-sm' }, agoEl(i.openedAt), h('small', {}, M.utc(i.openedAt).slice(0, 19))),
          h('td', {}, i.state === 'open' ? statusPill('Open', 'break') : statusPill('Resolved', 'hold')));
      }));
  };
  const tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Filter incidents' }, (['open', 'resolved', 'all'] as const).map(f =>
    h('button', { 'aria-pressed': String(f === filter), onclick: (e: Event) => { setParam('filter', f === 'open' ? null : f); tabs.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget))); fill(); } },
      f === 'open' ? 'Open' : f === 'resolved' ? 'Resolved' : 'All', h('span', { class: 'n' }, String(counts[f])))));
  const input = h('input', { type: 'search', class: 'filter', value: q, placeholder: 'Filter', 'aria-label': 'Filter incidents', oninput: () => { setParam('q', input.value); fill(); } });
  fill();
  clear(main,
    h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Incidents'), h('p', { class: 'lede' }, 'A payment becomes an incident when its PayPal capture and the store’s orders disagree. Incidents are never deleted; a repair resolves them after a re-check.'))),
    h('section', { class: 'panel', 'aria-label': 'Incident list' }, h('div', { class: 'ph' }, tabs, h('div', { class: 'r' }, h('label', { class: 'mini-search' }, icon('search'), input))),
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Incident'), h('th', {}, 'Item'), h('th', { class: 'hide-sm' }, 'Orders'), h('th', { class: 'hide-sm' }, 'Opened'), h('th', {}, 'Status'))), body))));
}

/* ---------------- checkouts ---------------- */
const CHECKOUT_FILTERS = [
  { id: 'all', label: 'All', test: (_c: Checkout) => true },
  { id: 'attention', label: 'Needs attention', test: (c: Checkout) => c.outcome === 'duplicate' || c.outcome === 'missing' },
  { id: 'waiting', label: 'Waiting', test: (c: Checkout) => c.outcome === 'waiting' },
  { id: 'matched', label: 'Matched', test: (c: Checkout) => c.outcome === 'matched' },
  { id: 'other', label: 'Not captured or undecided', test: (c: Checkout) => c.outcome === 'unpaid' || c.outcome === 'unclear' },
] as const;
function renderCheckouts() {
  title('Checkouts');
  const body = h('tbody');
  const fill = () => {
    const f = CHECKOUT_FILTERS.find(x => x.id === params().get('filter')) ?? CHECKOUT_FILTERS[0], q = params().get('q') ?? '';
    const rows = state.checkouts.filter(f.test).filter(c => !q || M.matchesQuery(c, q)).toSorted((a, b) => Date.parse(b.createdAt ?? b.evaluatedAt) - Date.parse(a.createdAt ?? a.evaluatedAt));
    clear(body, rows.length === 0 ? h('tr', {}, h('td', { colspan: '6', class: 'empty' }, q ? `No checkouts match “${q}”.` : 'No checkouts in this group.')) :
      rows.map(c => {
        const o = M.OUTCOME[c.outcome];
        return h('tr', {},
          h('td', {}, h('span', { class: 'strong' }, c.sku), h('small', { class: 'mono', title: c.intentId }, M.shortId(c.intentId))),
          h('td', { class: 'num' }, M.money(c.amountMinor, c.currency)),
          h('td', { class: 'hide-sm' }, c.attemptState === 'captured' ? 'Captured' : c.attemptState === 'awaiting_buyer_approval' ? 'Awaiting buyer' : c.attemptState ?? 'Unknown', h('small', { class: 'mono' }, c.paypalOrderId ?? '')),
          h('td', { class: 'hide-sm' }, String(c.orders), h('small', {}, c.orders === 1 ? 'live order' : 'live orders')),
          h('td', {}, statusPill(o.label, o.tone), h('details', { class: 'why' }, h('summary', {}, 'Why'), h('ul', { class: 'reasons' }, c.reasons.map(r => h('li', {}, r))))),
          h('td', {}, c.incidentId ? h('a', { class: 'btn sec sm', href: `/console/incidents/${c.incidentId}` }, 'Open incident') : h('span', { class: 'muted' }, 'No incident'), h('small', {}, 'checked ', agoEl(c.evaluatedAt))));
      }));
  };
  const current = CHECKOUT_FILTERS.find(x => x.id === params().get('filter'))?.id ?? 'all';
  const tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Filter checkouts' }, CHECKOUT_FILTERS.map(f =>
    h('button', { 'aria-pressed': String(f.id === current), onclick: (e: Event) => { setParam('filter', f.id === 'all' ? null : f.id); tabs.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget))); fill(); } },
      f.label, h('span', { class: 'n' }, String(state.checkouts.filter(f.test).length)))));
  const input = h('input', { type: 'search', class: 'filter', value: params().get('q') ?? '', placeholder: 'Filter by item or ID', 'aria-label': 'Filter checkouts', oninput: () => { setParam('q', input.value); fill(); } });
  fill();
  clear(main,
    h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Checkouts'), h('p', { class: 'lede' }, 'The latest rule check for every checkout: did one PayPal capture produce exactly one live store order?'))),
    h('section', { class: 'panel', 'aria-label': 'Checkout list' }, h('div', { class: 'ph' }, tabs, h('div', { class: 'r' }, h('label', { class: 'mini-search' }, icon('search'), input))),
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', { class: 'num' }, 'Amount'), h('th', { class: 'hide-sm' }, 'Payment'), h('th', { class: 'hide-sm' }, 'Store orders'), h('th', {}, 'Result'), h('th', {}, 'Incident'))), body))));
}

/* ---------------- recovery ---------------- */
async function renderRecovery() {
  title('Recovery');
  renderLoading();
  const ids = state.incidents.slice(0, 50).map(i => i.id);
  let rows: Array<{ i: IncidentSummary; d: Detail; st: Stage }>;
  try {
    const loaded = await Promise.all(ids.map(id => loadDetail(id)));
    if (parseRoute(location.pathname).page !== 'recovery') return;
    rows = loaded.map((x, n) => ({ i: state.incidents[n]!, d: x.detail, st: M.repairStage(x.detail, Date.now()) }));
  } catch (e) { renderError(e instanceof Error ? e : Error('Recovery records could not be read.')); return; }
  const byIntent = new Map(state.checkouts.map(c => [c.intentId, c]));
  const ready = rows.filter(r => !['resolved', 'unsupported'].includes(r.st.stage));
  const done = rows.filter(r => r.st.stage === 'resolved');
  const manual = rows.filter(r => r.st.stage === 'unsupported');
  const stageText = (st: Stage) => st.stage === 'needs_plan' ? 'Needs a repair plan' : st.stage === 'awaiting_approval' ? 'Plan waiting for approval' : st.stage === 'approved' ? 'Approved, ready to run' : st.stage === 'expired' ? 'Plan expired, needs a new one' : st.stage === 'failed' ? `Last attempt refused (${st.execution.outcome})` : st.stage === 'resolved' ? 'Repaired and re-checked' : 'Manual investigation';
  const item = (r: typeof rows[number], tone: M.Tone) => {
    const c = byIntent.get(r.i.intentId);
    return h('li', {}, h('span', { class: `sev ${tone === 'hold' ? 'resolved' : ''}`, 'aria-hidden': 'true' }, icon(tone === 'hold' ? 'check' : 'alert')),
      h('div', {}, h('a', { href: `/console/incidents/${r.i.id}` }, `${plainTitle(r.i, c?.sku ?? '')} · ${c?.sku ?? 'Checkout'}`), h('small', {}, `${M.incidentRef(r.i.id)} · ${stageText(r.st)}`)),
      statusPill(r.st.stage === 'resolved' ? 'Resolved' : r.st.stage === 'unsupported' ? 'Not supported' : 'Open', tone));
  };
  const list = (rs: typeof rows, tone: M.Tone, empty: string) => rs.length ? h('ul', { class: 'rec-list' }, rs.map(r => item(r, tone))) : h('p', { class: 'empty' }, empty);
  clear(main,
    h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Recovery'), h('p', { class: 'lede' }, 'Duplicate orders can be voided in the store through a planned, approved and re-checked repair. This page reads the records; the repair itself runs in a terminal.'))),
    h('div', { class: 'ov-grid' },
      h('div', { class: 'stack' },
        h('section', { class: 'panel', 'aria-labelledby': 'r1' }, h('div', { class: 'ph' }, h('h2', { id: 'r1' }, 'Ready to repair'), h('span', { class: 'sub' }, 'Duplicate orders with no completed repair')), list(ready, 'break', 'No duplicate is waiting for a repair.')),
        h('section', { class: 'panel', 'aria-labelledby': 'r2' }, h('div', { class: 'ph' }, h('h2', { id: 'r2' }, 'Repaired'), h('span', { class: 'sub' }, 'Each one has a receipt and a passing re-check')), list(done, 'hold', 'No repair has completed yet.')),
        h('section', { class: 'panel', 'aria-labelledby': 'r3' }, h('div', { class: 'ph' }, h('h2', { id: 'r3' }, 'Needs manual investigation'), h('span', { class: 'sub' }, 'Missing orders are never created automatically')), list(manual, 'neutral', 'No missing-order incidents.'))),
      h('section', { class: 'panel', 'aria-labelledby': 'how-h' }, h('div', { class: 'ph' }, h('h2', { id: 'how-h' }, 'How a repair works')),
        h('ol', { class: 'how' },
          h('li', {}, h('div', {}, h('b', {}, 'Plan'), h('p', {}, 'Records which order stays live and which is voided, with a hash of the evidence it relied on. Expires after 15 minutes.'))),
          h('li', {}, h('div', {}, h('b', {}, 'Approve'), h('p', {}, 'A person types the plan hash in an interactive terminal. The name is declared, not authenticated, and separation of duties is not enforced in this build.'))),
          h('li', {}, h('div', {}, h('b', {}, 'Run'), h('p', {}, 'Voids the extra order in the store only. PayPal is never contacted: no refund, capture or cancellation.'))),
          h('li', {}, h('div', {}, h('b', {}, 'Re-check'), h('p', {}, 'The rule runs again. Only a passing re-check resolves the incident, and every step is kept in an append-only log.')))))));
}

/* ---------------- incident detail ---------------- */
async function renderIncident(id: string) {
  renderLoading();
  let data: { detail: Detail; advisory: Advisory | Error };
  try { data = await loadDetail(id); }
  catch (e) {
    if (parseRoute(location.pathname).id !== id) return;
    if (e instanceof ApiError && e.kind === 'not_found') { renderNotFound(`No incident ${M.incidentRef(id)} exists in ${state.org}. It may belong to another organization scope.`); return; }
    renderError(e instanceof Error ? e : Error('The incident could not be read.')); return;
  }
  if (parseRoute(location.pathname).id !== id) return;
  const { detail: d, advisory } = data, v = d.view;
  const checkout = state.checkouts.find(c => c.intentId === v.intent) ?? null;
  const sku = checkout?.sku ?? 'this checkout', amount = M.money(d.amountMinor, d.currency), now = Date.now();
  const st = M.repairStage(d, now), t = M.buildTimeline(d, checkout);
  const live = d.orders.filter(o => o.effective === 'placed').length;
  title(`${M.incidentRef(id)} ${M.KIND_LABEL[d.kind]}`);
  const lens: Lens = M.lensFrom(location.search);

  const headline = d.kind === 'missing' ? 'Payment captured. No order created.' : d.state === 'resolved' ? 'Extra order voided. One payment, one order.' : `One payment captured. ${d.orders.length} orders created.`;
  const lede = d.kind === 'missing'
    ? `PayPal confirmed ${amount} for ${sku}, and the store still had no order when the grace period ended${d.missing?.dueAt ? ` at ${M.clock(d.missing.dueAt)}` : ''}. Fulfillment may be delayed; this is not proof of a lost payment.`
    : d.state === 'resolved' ? `The buyer paid ${amount} once for ${sku}. The store had created ${d.orders.length} orders; the extra one was voided and OrderTruth re-checked the payment.`
    : `The buyer paid ${amount} once for ${sku}, but the store created ${d.orders.length} live orders. If every order ships, ${d.orders.length - 1 === 1 ? 'one is an extra order' : `${d.orders.length - 1} are extra orders`}.`;
  const pill = d.state === 'resolved' ? statusPill('Resolved and re-checked', 'hold') : st.stage === 'awaiting_approval' ? statusPill('Awaiting approval', 'wait') : st.stage === 'approved' ? statusPill('Approved, not run', 'wait') : statusPill('Open', 'break');
  const page = h('div', { 'data-lens': lens });
  const lensBtn = (l: Lens, label: string, ic: string) => h('button', { 'aria-pressed': String(lens === l), onclick: (e: Event) => {
    page.dataset.lens = l; setParam('lens', l === 'eng' ? 'eng' : null);
    (e.currentTarget as Element).parentElement!.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
  } }, icon(ic), label);

  clear(page,
    h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, h('a', { href: '/console/incidents' }, 'Incidents'), h('span', { 'aria-hidden': 'true' }, '/'), h('span', { 'aria-current': 'page' }, M.incidentRef(id))),
    h('div', { class: 'head' }, h('div', {}, h('h1', {}, headline), h('p', { class: 'lede' }, lede)),
      h('div', { class: 'head-r' }, pill, h('div', { class: 'lens', role: 'group', 'aria-label': 'View as' }, lensBtn('ops', 'Operations', 'ops'), lensBtn('eng', 'Engineering', 'code')))),
    v.warnings.length ? h('div', { class: 'notice warn', role: 'status' }, icon('alert'), h('ul', { class: 'warnings' }, v.warnings.map(w => h('li', {}, w)))) : null,
    ribbon(t, d, live, amount),
    h('div', { class: 'grid-a' },
      h('div', { class: 'stack' },
        storyPanel(t), ordersPanel(d, st, live, amount), historyPanel(d, t),
        contractPanel(d), lineagePanel(d), recordPanel(d), guidancePanel(advisory, d), identifiersPanel(d, checkout)),
      h('aside', { class: 'act', 'aria-label': 'Next step' }, opsNext(d, st, id, live), engNext(d, checkout))));
  clear(main, page);
}

function ribbon(t: Timeline, d: Detail, live: number, amount: string) {
  const cols = t.events.length;
  const grid = h('div', { class: 'rb-grid', 'aria-hidden': 'true' });
  grid.style.gridTemplateColumns = `136px repeat(${Math.max(cols, 1)}, minmax(112px, 1fr))`;
  const broken = (lane: M.Lane, i: number) => lane === 'store' && t.breaks.some(b => i >= b.from && (b.to === null || i < b.to));
  const storeAt = (i: number) => t.events[i]?.lane === 'store';
  const labelAt = (b: Timeline['breaks'][number]) => { for (let i = b.from; i < (b.to ?? cols); i++) if (!storeAt(i)) return i; return b.from; };
  let n = 0;
  for (const lane of M.LANES) {
    grid.append(h('div', { class: 'rb-lane' }, lane.name, h('small', {}, lane.sub)));
    t.events.forEach((e, i) => {
      const cell = h('div', { class: `rb-cell ${lane.id}${broken(lane.id, i) ? ' broken' : ''}${lane.id === 'store' && t.healedAt === i ? ' healed' : ''}` });
      if (lane.id === 'store') {
        // Label each break once, in its first cell that has no store node, so it never covers one.
        const b = t.breaks.find(b => labelAt(b) === i);
        if (b) cell.append(h('span', { class: 'break-label' }, b.label));
      }
      if (e.lane === lane.id) {
        const node = h('div', { class: `node ${e.mark}`, title: `${e.title}. ${e.detail}. ${M.utc(e.at)}` }, h('b', {}, e.title), h('span', {}, e.detail));
        node.style.setProperty('--i', String(n++));
        cell.append(node);
      }
      grid.append(cell);
    });
  }
  grid.append(h('div', { class: 'rb-lane axis' }, 'Time'));
  t.columns.forEach(c => grid.append(h('div', { class: 'rb-cell axis' }, h('b', {}, M.clock(c.at)),
    h('span', { class: `delta${c.delta !== null && c.delta < 1000 ? ' fast' : ''}` }, c.delta === null ? M.day(c.at) : `+${M.duration(c.delta)}`))));
  const observed = d.kind === 'missing' ? h('span', {}, h('b', {}, 'Observed '), h('span', { class: 'bad' }, 'no store order after the grace period'))
    : d.state === 'resolved' ? h('span', {}, h('b', {}, 'Now '), h('span', { class: 'ok' }, `${live} live order after repair`))
    : h('span', {}, h('b', {}, 'Observed '), h('span', { class: 'bad' }, `${live} live orders${d.orders.length > 1 && d.orders[1]!.createdAt && d.orders[0]!.createdAt ? `, created ${M.duration(Date.parse(d.orders[1]!.createdAt) - Date.parse(d.orders[0]!.createdAt))} apart` : ''}`));
  const providerOk = d.view.provider.trust.startsWith('PAYPAL_API_READBACK');
  return h('section', { class: 'panel ribbon', 'aria-labelledby': 'rb-h' },
    h('div', { class: 'rb-top' }, h('h2', { id: 'rb-h' }, 'Reconciliation'),
      h('span', { class: 'range' }, t.start ? `${M.day(t.start)} · ${M.clock(t.start)} to ${M.clock(t.end)} local time` : 'No timed records'),
      h('div', { class: 'rb-legend' }, h('span', {}, h('i', { class: 'lg p' }), 'Proven by PayPal'), h('span', {}, h('i', { class: 'lg m' }), 'Seen in store'), h('span', {}, h('i', { class: 'lg c' }), 'Claimed or planned'), h('span', {}, h('i', { class: 'lg b' }), 'Seam broken'))),
    h('div', { class: 'rb-scroll', tabindex: '0', 'aria-label': 'Reconciliation timeline, scrolls sideways' }, grid,
      h('ol', { class: 'vh' }, t.events.map(e => h('li', {}, `${M.clock(e.at)}, ${M.LANES.find(l => l.id === e.lane)!.name}: ${e.title}. ${e.detail}.`)))),
    h('div', { class: 'rb-foot' },
      h('span', {}, h('b', {}, 'Expected '), 'one live order per capture'),
      observed,
      h('span', {}, h('b', {}, 'PayPal '), providerOk ? `one completed capture of ${amount}, unchanged` : 'capture evidence unavailable or inconsistent'),
      h('span', { class: 'muted' }, 'Columns follow time order; gaps are labelled, not drawn to scale.')));
}
function storyPanel(t: Timeline) {
  return h('section', { class: 'panel ops', 'aria-labelledby': 'story-h' },
    h('div', { class: 'ph' }, h('h2', { id: 'story-h' }, 'What happened'), h('span', { class: 'sub' }, 'In plain words, with the source of each line')),
    t.events.length === 0 ? h('p', { class: 'empty' }, 'No timed records are linked to this incident.') :
      h('ol', { class: 'story' }, t.events.map(e => h('li', {}, h('time', { datetime: e.at, title: M.utc(e.at) }, M.clock(e.at)), h('p', {}, e.story), e.tag ? evChip(e.tag.cls, e.tag.label) : h('span', {})))));
}
function ordersPanel(d: Detail, st: Stage, live: number, amount: string) {
  const plan = st.stage === 'awaiting_approval' || st.stage === 'approved' || st.stage === 'expired' || st.stage === 'failed' ? st.plan : st.stage === 'resolved' ? st.plan : null;
  if (d.kind === 'missing') {
    return h('section', { class: 'panel ops', 'aria-labelledby': 'ord-h' },
      h('div', { class: 'ph' }, h('h2', { id: 'ord-h' }, 'Expected order'), h('span', { class: 'sub' }, 'Checked against the store database')),
      h('p', { class: 'empty' }, 'The store has no order for this payment. OrderTruth will not create one; recovery needs a separate, authorized decision.'),
      h('div', { class: 'facts' },
        h('div', {}, h('small', {}, 'Paid by buyer'), h('b', {}, amount), h('em', {}, 'confirmed by PayPal')),
        h('div', {}, h('small', {}, 'Store orders'), h('b', {}, String(d.orders.length)), h('em', {}, 'expected 1')),
        h('div', {}, h('small', {}, 'Latest check'), h('b', {}, d.missing?.lastChecked === 'ORDER_PRESENT' ? 'Order present' : d.missing?.lastChecked === 'MISSING_AFTER_GRACE' ? 'Still missing' : 'Re-check needed'))));
  }
  const extra = Math.max(live - 1, 0);
  return h('section', { class: 'panel ops', 'aria-labelledby': 'ord-h' },
    h('div', { class: 'ph' }, h('h2', { id: 'ord-h' }, 'Affected orders'), h('span', { class: 'sub' }, 'Every store order for this one payment')),
    h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Order'), h('th', { class: 'hide-sm' }, 'Created by'), h('th', { class: 'hide-sm' }, 'Created'), h('th', { class: 'num' }, 'Amount'), h('th', {}, 'Status now'), h('th', {}, plan ? 'Repair plan' : 'Plan'))),
      h('tbody', {}, d.orders.map((o, n) => {
        const voided = o.effective !== 'placed';
        const decision = plan ? (plan.keep === o.id ? h('span', { class: 'pill keep' }, icon('check'), 'Keep') : plan.voids.includes(o.id) ? h('span', { class: 'pill void' }, icon('x'), 'Void in store') : h('span', { class: 'pill neutral' }, 'Not in plan')) : h('span', { class: 'muted' }, 'Set by the plan');
        return h('tr', {},
          h('td', {}, h('span', { class: 'strong mono', title: o.id }, M.shortId(o.id)), h('small', {}, n === 0 ? 'First order' : d.orders[0]!.createdAt && o.createdAt ? `Created ${M.duration(Date.parse(o.createdAt) - Date.parse(d.orders[0]!.createdAt))} later` : 'Later order')),
          h('td', { class: 'hide-sm' }, M.pathLabel(o.path), o.faultInjection ? h('small', {}, 'during a controlled test') : null),
          h('td', { class: 'hide-sm' }, h('span', { title: M.utc(o.createdAt) }, M.clock(o.createdAt))),
          h('td', { class: `num${voided ? ' strike' : ''}` }, M.money(o.amountMinor, d.currency)),
          h('td', {}, voided ? h('span', { class: 'pill void' }, 'Voided') : h('span', { class: 'pill neutral' }, 'Live')),
          h('td', {}, decision));
      })))),
    h('div', { class: 'facts' },
      h('div', {}, h('small', {}, 'Paid by buyer'), h('b', {}, amount), h('em', {}, 'once')),
      h('div', {}, h('small', {}, 'Live orders now'), h('b', {}, String(live)), h('em', {}, 'should be 1')),
      h('div', {}, h('small', {}, extra ? 'Duplicated order value' : 'Duplicated order value'), h('b', {}, M.money(extra * (d.amountMinor ?? 0), d.currency)), h('em', {}, extra ? 'if every order ships' : 'nothing extra live'))));
}
function historyPanel(d: Detail, t: Timeline) {
  const items = t.events.filter(e => e.lane === 'ordertruth' || e.key.startsWith('void:'));
  return h('section', { class: 'panel ops', 'aria-labelledby': 'hist-h' },
    h('div', { class: 'ph' }, h('h2', { id: 'hist-h' }, 'Case history'), h('span', { class: 'sub' }, 'Kept forever, including refused attempts')),
    h('ol', { class: 'story' }, items.map(e => h('li', {}, h('time', { datetime: e.at, title: M.utc(e.at) }, M.clock(e.at)), h('p', {}, e.title, h('small', {}, e.detail)), e.tag ? evChip(e.tag.cls, M.EVIDENCE_LABEL[e.tag.cls]) : h('span', {})))),
    d.plans.length === 0 && d.kind === 'duplicate' ? h('p', { class: 'empty' }, 'No repair has been planned yet.') : null);
}
function contractPanel(d: Detail) {
  const o = d.view.opening, l = d.view.latest;
  const count = (n: number | null) => n === null ? 'Unavailable' : `${n} live order${n === 1 ? '' : 's'}`;
  return h('section', { class: 'panel eng', 'aria-labelledby': 'con-h' },
    h('div', { class: 'ph' }, h('h2', { id: 'con-h' }, 'Contract check'), h('span', { class: 'sub mono' }, d.view.contract), h('div', { class: 'r' }, evChip('DETERMINISTIC_EVALUATION', `#${o.seq}`))),
    h('div', { class: 'contract' },
      h('div', {}, h('h3', {}, 'Expected'), h('div', { class: 'big' }, '1 live order'), h('p', {}, 'per completed capture, after a 5 minute grace')),
      h('div', {}, h('h3', {}, `At detection · check #${o.seq}`), h('div', { class: 'big bad' }, count(o.count)), h('p', { title: M.utc(o.at) }, `${o.result} · ${M.utc(o.at)}`)),
      h('div', {}, h('h3', {}, `Latest · check #${l.seq || '–'}`), h('div', { class: `big ${l.result === 'HOLDS' ? 'ok' : l.result === 'VIOLATED' ? 'bad' : ''}` }, count(l.count)), h('p', {}, `${l.result} · ${M.utc(l.seq ? l.at : null)}`))),
    h('ul', { class: 'reasons', 'aria-label': 'Rule reasons at detection' }, o.reasons.map(r => h('li', {}, r))));
}
function summaryLine(e: M.EvidenceRow): string {
  const s = M.object(e.summary);
  if (e.cls === 'PAYPAL_API_READBACK') return `GET order ${String(s.orderId ?? '?')}: ${String(s.orderStatus ?? '?')}, capture ${String(s.captureId ?? '?')} ${String(s.captureStatus ?? '?')}, ${String(M.object(s.amount).currency ?? '')} ${String(M.object(s.amount).value ?? '')}`;
  if (e.cls === 'MERCHANT_DB_OBSERVED') { const snap = M.object(s.snapshot); return snap.id ? `Order ${String(snap.id)}, recorded ${STATUS_WORD[e.snapshotStatus ?? ''] ?? e.snapshotStatus ?? 'status unknown'}, created by the ${M.pathPhrase(String(snap.created_by_path ?? 'unknown path'))}` : `No store order for this payment (${e.refType}:${e.refId})`; }
  if (e.cls === 'CONTROLLED_FAULT_INJECTION') return `${String(s.kind ?? 'Fault')}: ${String(M.object(s.params).bug ?? '')}`;
  return `${e.refType}:${e.refId}`;
}
const STATUS_WORD: Record<string, string> = { placed: 'live', voided_duplicate: 'voided' };
function lineagePanel(d: Detail) {
  const rows = d.evidence.toSorted((a, b) => Date.parse(a.sourceAt ?? '') - Date.parse(b.sourceAt ?? '') || a.seq - b.seq);
  const o = d.view.opening;
  return h('section', { class: 'panel eng', 'aria-labelledby': 'lin-h' },
    h('div', { class: 'ph' }, h('h2', { id: 'lin-h' }, 'Evidence'), h('span', { class: 'sub' }, `${rows.length} linked record${rows.length === 1 ? '' : 's'}, UTC. Stored when observed, not re-read here.`)),
    rows.length === 0 ? h('p', { class: 'empty' }, 'No evidence records are linked to this incident.') :
    h('div', { class: 'table-wrap' }, h('table', { class: 'lineage' }, h('thead', {}, h('tr', {}, h('th', {}, 'Source time'), h('th', {}, 'Source'), h('th', {}, 'Record'))),
      h('tbody', {}, rows.map(e => {
        const scope = M.scopeOf(e.cls), changed = e.snapshotStatus && e.nowStatus && e.snapshotStatus !== e.nowStatus;
        return h('tr', {},
          h('td', { class: 't mono', title: M.utc(e.sourceAt) }, M.utc(e.sourceAt).slice(11, 23)),
          h('td', {}, evChip(e.cls)),
          h('td', {},
            h('span', { class: 'rec' }, summaryLine(e)),
            h('span', { class: 'rec-tags' },
              e.cited ? h('span', { class: 'tag cited', title: `Rule check #${o.seq} relied on this record` }, icon('check'), `Used by check #${o.seq}`) : null,
              changed ? h('span', { class: 'tag now' }, `Recorded ${STATUS_WORD[e.snapshotStatus!] ?? e.snapshotStatus}, now ${STATUS_WORD[e.nowStatus!] ?? e.nowStatus}`) : null),
            h('details', {}, h('summary', {}, 'Inspect record'),
              h('dl', { class: 'scope-kv' },
                h('dt', {}, 'Shows'), h('dd', {}, scope.shows),
                h('dt', {}, 'Does not show'), h('dd', {}, scope.not),
                h('dt', {}, 'Reference'), h('dd', { class: 'mono' }, `${e.refType}:${e.refId}`),
                h('dt', {}, 'Source time'), h('dd', { class: 'mono' }, M.utc(e.sourceAt))),
              h('pre', { 'aria-label': 'Stored summary' }, JSON.stringify(e.summary, null, 2) ?? 'null'))));
      })))));
}
function recordPanel(d: Detail) {
  const recs = d.records;
  const sub = recs.length ? `${recs.length} stored row${recs.length === 1 ? '' : 's'}, append-only, UTC` : 'Nothing stored';
  const empty = d.kind === 'missing' ? 'Repairs do not apply to missing orders, so nothing has been planned or changed.' : 'No repair has been planned, approved or run. The store has not been changed.';
  return h('section', { class: 'panel eng', 'aria-labelledby': 'rec-h' },
    h('div', { class: 'ph' }, h('h2', { id: 'rec-h' }, 'Repair record'), h('span', { class: 'sub' }, sub)),
    recs.length === 0 ? h('p', { class: 'empty' }, empty) :
    h('div', { class: 'table-wrap' }, h('table', { class: 'lineage' }, h('thead', {}, h('tr', {}, h('th', {}, 'Stored at'), h('th', {}, 'Row'), h('th', {}, 'What it says'))),
      h('tbody', {}, recs.map(r => h('tr', { class: r.kind === 'audit' ? 'quiet' : null },
        h('td', { class: 't mono', title: M.utc(r.at) }, M.utc(r.at).slice(11, 23)),
        h('td', {}, h('span', { class: `rk ${r.kind}` }, M.REPAIR_KIND_LABEL[r.kind])),
        h('td', {}, h('span', { class: 'rec' }, r.text),
          h('details', {}, h('summary', {}, 'Stored columns'), h('dl', { class: 'scope-kv cols' }, r.fields.flatMap(([k, v]) => [h('dt', { class: 'mono' }, k), h('dd', { class: 'mono' }, v)]))))))))),
    recs.length === 0 ? null : h('p', { class: 'foot-note' }, 'Shown exactly as stored. Names are declared, not signed in, and the latest rule check is not treated as proof of repair.'));
}
function guidancePanel(a: Advisory | Error, d: Detail) {
  const head = h('div', { class: 'ph' }, h('h2', { id: 'gd-h' }, 'Investigation guidance'), h('span', { class: 'sub' }, a instanceof Error ? 'Unavailable' : a.status === 'AI_UNAVAILABLE' ? 'Rules only. AI is not configured, so no model was called.' : `AI advisory · ${a.calls} call${a.calls === 1 ? '' : 's'}`));
  if (a instanceof Error) return h('section', { class: 'panel eng', 'aria-labelledby': 'gd-h' }, head, h('p', { class: 'empty' }, `Guidance could not be loaded: ${a.message}`));
  const ai = a.trust === 'AI_HYPOTHESIS' || a.status !== 'AI_UNAVAILABLE';
  const cite = new Map(a.citations.map(c => [c.id, c]));
  return h('section', { class: 'panel eng', 'aria-labelledby': 'gd-h' }, head,
    a.advice.map((x, n) => h('div', { class: `guide${ai ? ' ai' : ''}` },
      h('div', { class: 'guide-h' }, evChip(ai ? 'AI_HYPOTHESIS' : 'DETERMINISTIC_GUIDANCE', ai ? `H${n + 1}` : 'Rules'), h('b', {}, ai ? 'Hypothesis, not a finding' : 'No cause established'), h('span', { class: 'r' }, ai ? 'Unverified until tested' : a.reason === 'NOT_CONFIGURED' ? 'AI not configured' : a.reason)),
      h('p', { class: 'claim' }, x.hypothesis),
      h('div', { class: 'guide-cols' },
        h('div', {}, h('h3', {}, 'Cited evidence'), h('ul', {}, x.evidenceIds.map(id => { const c = cite.get(id); return h('li', {}, evChip(c?.trust ?? 'UNKNOWN', id), ' ', h('span', { class: 'mono' }, c?.ref ?? 'unknown')); }))),
        h('div', {}, h('h3', {}, 'Still uncertain'), h('p', {}, x.uncertainty)),
        h('div', {}, h('h3', {}, 'Next test'), h('p', {}, M.NEXT_TEST[x.nextTest] ?? x.nextTest))))),
    d.reproduction.mechanism ? h('div', { class: 'recipe' }, h('h3', {}, 'Recorded fault mechanism'), h('p', {}, d.reproduction.mechanism), h('p', { class: 'muted' }, 'Known because this incident came from a controlled fault injection, not from diagnosis.')) : null,
    d.reproduction.note ? h('div', { class: 'recipe' }, h('h3', {}, 'Recorded note'), h('p', {}, d.reproduction.note)) : null);
}
function identifiersPanel(d: Detail, c: Checkout | null) {
  const pairs: Array<[string, string]> = [['Incident', d.view.id], ['Checkout intent', d.view.intent], ['PayPal order', c?.paypalOrderId ?? 'Unavailable'], ['Capture', d.view.capture], ['Contract', d.view.contract], ['Opened', M.utc(d.view.opened)]];
  return h('section', { class: 'panel eng', 'aria-labelledby': 'ids-h' }, h('div', { class: 'ph' }, h('h2', { id: 'ids-h' }, 'Identifiers')),
    h('dl', { class: 'kv' }, pairs.flatMap(([k, v]) => [h('dt', {}, k), h('dd', { class: 'mono' }, v)])));
}
function opsNext(d: Detail, st: Stage, id: string, live: number) {
  const cmds = M.repairCommands(st, id, state.org);
  const steps = cmds.length ? h('ol', { class: 'steps' }, cmds.map(c => h('li', {}, h('div', {}, h('b', {}, c.label), h('p', {}, c.note), command(c.command))))) : null;
  const foot = h('div', { class: 'act-ft' }, icon('lock'), h('span', {}, d.separationOfDuties ? 'Approval requires a second person.' : 'Approval is a typed name in a terminal, not a login. Separation of duties is not enforced in this build.'));
  const card = (k: string, heading: string, p: string, ...rest: Array<Node | null>) => h('div', { class: 'act-card ops' }, h('div', { class: 'act-hd' }, h('span', { class: 'k' }, k), h('h2', {}, heading), h('p', {}, p)), ...rest);
  const diff = (keep: string | null, voids: string[]) => h('div', { class: 'diff', 'aria-label': 'Change this repair makes' },
    h('div', { class: 'keep' }, h('span', { class: 'sign', 'aria-hidden': 'true' }, '='), keep ? h('span', { class: 'mono', title: keep }, M.shortId(keep)) : '1 order', h('span', { class: 'r' }, 'stays live')),
    ...(voids.length ? voids : [null]).map(v => h('div', { class: 'void' }, h('span', { class: 'sign', 'aria-hidden': 'true' }, '−'), v ? h('span', { class: 'mono', title: v }, M.shortId(v)) : `${Math.max(live - 1, 1)} extra order${live - 1 > 1 ? 's' : ''}`, h('span', { class: 'r' }, 'voided in store'))),
    h('div', { class: 'same' }, h('span', { class: 'sign', 'aria-hidden': 'true' }, '·'), 'PayPal capture', h('span', { class: 'r' }, 'untouched')));
  switch (st.stage) {
    case 'unsupported': return card('Next step', 'Find out why no order was created', 'OrderTruth does not create orders automatically. A late order will not erase this incident, and recovery needs a separate, authorized decision.',
      h('ul', { class: 'checks' },
        h('li', {}, icon('check', 'ic ok'), 'Check the order path logs around the capture time.'),
        h('li', {}, icon('check', 'ic ok'), 'Confirm the buyer was not charged twice before contacting them.'),
        h('li', {}, icon('x', 'ic bad'), 'Do not use the duplicate-order repair for a missing order.')),
      h('div', { class: 'act-ft' }, icon('lock'), h('span', {}, d.missing?.nextAction ?? 'Recovery is not supported in this build.')));
    case 'resolved': {
      const ex = st.execution, same = ex?.before && ex.before === ex.after;
      return card('Receipt', 'Resolved and re-checked', `The extra order was voided in the store and the rule passed again at ${M.clock(st.resolution.postcondition?.at ?? st.resolution.at)}.`,
        st.plan ? diff(st.plan.keep, st.plan.voids) : null,
        h('ul', { class: 'checks' },
          h('li', {}, icon('check', 'ic ok'), `Re-check: ${st.resolution.postcondition?.result ?? 'unavailable'}, ${st.resolution.postcondition?.count ?? '?'} live order.`),
          h('li', {}, icon(same ? 'check' : 'alert', `ic ${same ? 'ok' : 'bad'}`), same ? 'Stored PayPal evidence is byte-identical before and after.' : 'Stored PayPal evidence hashes differ or are missing. Investigate.'),
          ...d.approvals.filter(a => a.planId === st.plan?.id).map(a => h('li', {}, icon('lock', 'ic lock'), `Approved by ${a.operator} (declared, ${a.mode === 'SIMULATED_TEST' ? 'simulated in a test' : 'interactive terminal'}).`))),
        steps, foot);
    }
    case 'awaiting_approval': return card('Next step', 'Approve the planned repair', `${st.plan.requester} planned this repair. The plan expires ${M.ago(st.plan.expiresAt, Date.now())}.`, diff(st.plan.keep, st.plan.voids), steps, foot);
    case 'approved': return card('Next step', 'Run the approved repair', 'The plan is approved. Running it voids the extra order and re-checks the rule.', diff(st.plan.keep, st.plan.voids), steps, foot);
    default: {
      const why = st.stage === 'expired' ? h('div', { class: 'notice warn' }, icon('clock'), h('span', {}, `The last plan expired at ${M.clock(st.plan.expiresAt)} without running. Create a new one.`))
        : st.stage === 'failed' ? h('div', { class: 'notice warn' }, icon('alert'), h('span', {}, `The last attempt was refused: ${st.execution.outcome}. ${st.execution.reasons.join(' ')} Nothing was changed.`)) : null;
      return card('Next step', 'Void the extra order before it ships', 'This changes the store’s records only. PayPal is not contacted: no refund, no capture.', diff(null, []),
        why ? h('div', { class: 'pb' }, why) : null,
        h('ul', { class: 'checks' },
          h('li', {}, icon('check', 'ic ok'), 'Afterwards OrderTruth re-checks: one live order for one capture.'),
          h('li', {}, icon('check', 'ic ok'), 'The plan records which order stays and hashes its evidence.')),
        steps, foot);
    }
  }
}
function engNext(d: Detail, c: Checkout | null) {
  const cards: HTMLElement[] = [];
  if (d.kind === 'missing') {
    cards.push(h('div', { class: 'act-card eng' }, h('div', { class: 'act-hd' }, h('span', { class: 'k' }, 'Next step'), h('h2', {}, 'Read the absence evidence'), h('p', {}, 'Pull the latest rule check for this checkout from the read-only API and compare it with the order path logs.')),
      h('ol', { class: 'steps' }, h('li', {}, h('div', {}, h('b', {}, 'Latest check for this checkout'), h('p', {}, 'Read-only. Uses the dev scope header.'), command(`curl -s -H "x-ordertruth-org: ${state.org}" "${location.origin}/api/evaluations?intentId=${d.view.intent}"`)))),
      h('div', { class: 'act-ft' }, icon('lock'), h('span', {}, 'No PayPal call is made. A fresh readback needs separate approval.'))));
  } else {
    const cmds = d.reproduction.reproduce;
    cards.push(h('div', { class: 'act-card eng' }, h('div', { class: 'act-hd' }, h('span', { class: 'k' }, 'Next step'), h('h2', {}, d.reproduction.cause === 'CONTROLLED_FAULT_INJECTION' ? 'Reproduce the race locally' : 'Reproduce before naming a cause'), h('p', {}, 'Run the recorded reproduction on an isolated copy. Two orders for one capture confirms the mechanism.')),
      cmds.length ? h('ol', { class: 'steps' }, cmds.map((x, n) => h('li', {}, h('div', {}, h('b', {}, n === 0 ? 'Replay on an isolated copy' : 'Run the regression test'), x.includes('<') ? h('p', {}, 'Replace the placeholder first. Runs on an isolated copy of the database.') : null, command(x))))) : h('p', { class: 'empty' }, 'No reproduction is recorded for this incident.'),
      h('div', { class: 'act-ft' }, icon('lock'), h('span', {}, 'Runs on local reference data. No Sandbox calls.'))));
  }
  if (c) cards.push(h('div', { class: 'act-card eng' }, h('div', { class: 'act-hd' }, h('span', { class: 'k' }, 'Checkout'), h('h2', {}, `${c.sku} · ${M.money(c.amountMinor, c.currency)}`), h('p', {}, `${M.OUTCOME[c.outcome].label}. Latest check #${c.seq}, ${M.ago(c.evaluatedAt, Date.now())}.`))));
  return h('div', { class: 'eng-stack' }, ...cards);
}

/* ---------------- search ---------------- */
const input = $('search-input') as HTMLInputElement;
const results = $('search-results');
let active = -1;
function closeResults() { results.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; }
function showResults() {
  const q = input.value;
  if (!q.trim()) { closeResults(); return; }
  const found = M.search(M.searchIndex(state.incidents, state.checkouts), q);
  active = found.length ? 0 : -1;
  clear(results, found.length === 0
    ? h('li', { class: 'none', role: 'option', 'aria-disabled': 'true' }, state.loadedAt ? `No incidents or checkouts match “${q}”.` : 'Records are not loaded yet.')
    : found.map((r, n) => h('li', { role: 'option', id: `sr-${n}`, 'aria-selected': String(n === active) }, h('a', { href: r.href, tabindex: '-1' }, h('span', { class: 'k' }, r.kind === 'incident' ? 'Incident' : 'Checkout'), h('span', {}, h('b', {}, r.title), h('small', {}, r.sub))))));
  results.hidden = false; input.setAttribute('aria-expanded', 'true');
  if (active >= 0) input.setAttribute('aria-activedescendant', 'sr-0');
}
function move(by: number) {
  const items = [...results.querySelectorAll<HTMLElement>('li[id]')];
  if (!items.length) return;
  active = (active + by + items.length) % items.length;
  items.forEach((li, n) => li.setAttribute('aria-selected', String(n === active)));
  input.setAttribute('aria-activedescendant', items[active]!.id);
  items[active]!.scrollIntoView({ block: 'nearest' });
}
input.addEventListener('input', showResults);
input.addEventListener('focus', showResults);
input.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if (e.key === 'Enter') { const a = results.querySelector<HTMLAnchorElement>(`#sr-${active} a`); if (a) { e.preventDefault(); input.value = ''; navigate(new URL(a.href).pathname + new URL(a.href).search); input.blur(); } }
  else if (e.key === 'Escape') { if (input.value) input.value = ''; closeResults(); }
});
results.addEventListener('mousedown', e => e.preventDefault());
results.addEventListener('click', () => { input.value = ''; closeResults(); });
input.addEventListener('blur', () => window.setTimeout(closeResults, 120));
document.addEventListener('keydown', e => {
  const tag = (e.target as HTMLElement).tagName;
  if ((e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); input.focus(); input.select(); }
});

/* ---------------- refresh, menu, ticking clocks ---------------- */
async function refresh() {
  const btn = $('refresh'); btn.setAttribute('aria-busy', 'true'); $('checked').textContent = 'Refreshing…';
  state.details.clear(); state.loadedAt = null; state.error = null;
  await loadAll(); btn.removeAttribute('aria-busy');
  if (state.error) toast('Could not reach the incident API', true); else toast('Records updated');
  await route();
}
$('refresh').addEventListener('click', () => void refresh());
$('menu-btn').addEventListener('click', () => { const open = $('rail').classList.toggle('open'); $('menu-btn').setAttribute('aria-expanded', String(open)); });
window.setInterval(() => {
  const now = Date.now();
  document.querySelectorAll<HTMLElement>('[data-ago]').forEach(el => { if (el.dataset.ago) el.textContent = M.ago(el.dataset.ago, now); });
}, 15_000);

renderShell();
void route();
