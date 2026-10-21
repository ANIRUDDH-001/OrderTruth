/** Pure console model: parsing, derivation and formatting. No DOM and no network here, so it is unit-tested directly. */
import { mapIncident, object, type View } from './evidence.ts';
import { INCIDENT_PATTERN, ORG_PATTERN } from './api.ts';

type Obj = Record<string, unknown>;
const list = (v: unknown): unknown[] => Array.isArray(v) && v.length <= 1000 ? v : [];
const str = (v: unknown): string | null => typeof v === 'string' && v.length <= 4000 ? v : null;
const strs = (v: unknown): string[] => list(v).filter((x): x is string => typeof x === 'string');
const int = (v: unknown): number | null => Number.isSafeInteger(v) ? Number(v) : null;
export const validTime = (v: unknown): string | null => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;
const RESULTS = ['HOLDS', 'VIOLATED', 'NOT_ELIGIBLE', 'OUT_OF_SCOPE'] as const;
export type Result = typeof RESULTS[number];

/* ---------------- formatting ---------------- */
export function money(minor: number | null, currency = 'USD'): string {
  if (minor === null || !Number.isSafeInteger(minor)) return 'Amount unavailable';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100); } catch { return `${currency} ${(minor / 100).toFixed(2)}`; }
}
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export function clock(iso: string | null): string {
  if (!iso) return '--:--:--';
  const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function day(iso: string | null): string {
  if (!iso) return 'Date unavailable';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
export function utc(iso: string | null): string {
  if (!iso) return 'Timestamp unavailable';
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)} UTC`;
}
export function duration(ms: number): string {
  const a = Math.abs(ms);
  if (a < 1000) return `${Math.round(a)} ms`;
  if (a < 60_000) return `${(a / 1000).toFixed(a < 10_000 ? 1 : 0).replace(/\.0$/, '')} s`;
  if (a < 3_600_000) return `${Math.round(a / 60_000)} min`;
  if (a < 86_400_000) return `${(a / 3_600_000).toFixed(1).replace(/\.0$/, '')} h`;
  return `${Math.round(a / 86_400_000)} d`;
}
export function ago(iso: string | null, now: number): string {
  if (!iso) return 'time unavailable';
  const d = now - Date.parse(iso);
  if (d < 0) return `in ${duration(-d)}`;
  if (d < 45_000) return 'just now';
  return `${duration(d)} ago`;
}
/** Short, scannable reference for an incident. The full ID stays available to engineers. */
export const incidentRef = (id: string) => `INC-${id.slice(4, 10).toUpperCase()}`;
export const shortId = (id: string) => id.length > 14 ? `${id.slice(0, 11)}…` : id;
export const pathLabel = (p: string) => p === 'capture_return' ? 'Checkout return page' : p === 'webhook_capture_completed' ? 'PayPal webhook handler' : p;
/** Mid-sentence form: keeps the PayPal brand capitalised. */
export const pathPhrase = (p: string) => p === 'capture_return' ? 'checkout return page' : p === 'webhook_capture_completed' ? 'PayPal webhook handler' : p;

/* ---------------- checkouts (latest evaluation per intent) ---------------- */
export type Outcome = 'matched' | 'duplicate' | 'missing' | 'waiting' | 'unpaid' | 'unclear';
export type Tone = 'hold' | 'break' | 'wait' | 'neutral';
export const OUTCOME: Record<Outcome, { label: string; tone: Tone; plain: string }> = {
  matched: { label: 'Matched', tone: 'hold', plain: 'One paid capture, one store order.' },
  duplicate: { label: 'Duplicate orders', tone: 'break', plain: 'One paid capture, more than one live store order.' },
  missing: { label: 'Missing order', tone: 'break', plain: 'Paid capture, no store order after the grace period.' },
  waiting: { label: 'Waiting for order', tone: 'wait', plain: 'Paid capture, store order still inside the grace period.' },
  unpaid: { label: 'Not captured', tone: 'neutral', plain: 'The buyer has not completed payment, so no order is expected.' },
  unclear: { label: 'Needs review', tone: 'neutral', plain: 'The rule could not decide; read the reasons.' },
};
export type Checkout = {
  intentId: string; seq: number; sku: string; amountMinor: number | null; currency: string; createdAt: string | null;
  result: Result; outcome: Outcome; orders: number; orderIds: string[]; paypalOrderId: string | null; captureId: string | null;
  attemptState: string | null; evaluatedAt: string; dueAt: string | null; confirmedAt: string | null; reasons: string[]; incidentId: string | null;
  /** Grace the checker actually applied, from the stored evaluation facts. Null when none was stored. */
  graceMs: number | null;
  /** True only when the stored rule check relied on a persisted PayPal readback confirming this capture. */
  readbackConfirmed: boolean;
};
export function outcomeOf(result: Result, orders: number, attemptState: string | null, dueAt: string | null): Outcome {
  if (result === 'HOLDS') return 'matched';
  if (result === 'VIOLATED') return orders >= 2 ? 'duplicate' : orders === 0 ? 'missing' : 'unclear';
  if (result === 'OUT_OF_SCOPE') return orders === 0 && dueAt ? 'waiting' : 'unclear';
  return attemptState !== null && attemptState !== 'captured' ? 'unpaid' : 'unclear';
}
export function parseCheckouts(raw: unknown, org: string): Checkout[] {
  const r = object(raw);
  if (r.organizationId !== org) throw Error('The API answered for a different organization; nothing is shown.');
  if (!Array.isArray(r.evaluations)) throw Error('The evaluations response is malformed.');
  return list(r.evaluations).flatMap(x => {
    const e = object(x), f = object(e.facts), c = object(e.checkout), mo = object(f.missingOrder), amount = object(c.amount);
    // Violation facts nest the payment attempt under repairFacts; other results carry it flat.
    const att = object(object(f.repairFacts).attempt);
    const seq = int(e.seq), orders = int(e.activeOrderCount), evaluatedAt = validTime(e.evaluatedAt), intentId = str(e.intentId);
    if (seq === null || orders === null || orders < 0 || !evaluatedAt || !intentId || !/^ci_[0-9a-f-]{36}$/.test(intentId) || !RESULTS.includes(e.result as Result)) return [];
    const result = e.result as Result, attemptState = str(f.attemptState) ?? str(att.state), dueAt = validTime(mo.dueAt), graceMs = int(mo.graceMs);
    // HOLDS and VIOLATED are only reachable when the newest readback confirms the capture; a waiting check lists its confirming readbacks.
    const readbackConfirmed = result === 'HOLDS' || result === 'VIOLATED' || list(f.confirmingReadbackSeqs).length > 0;
    return [{ intentId, seq, sku: str(c.sku) ?? 'Unknown item', amountMinor: int(amount.minor), currency: str(amount.currency) ?? 'USD', createdAt: validTime(c.createdAt),
      result, outcome: outcomeOf(result, orders, attemptState, dueAt), orders, orderIds: strs(f.matchingOrderIds), paypalOrderId: str(f.paypalOrderId) ?? str(att.paypal_order_id), captureId: str(f.captureId) ?? str(att.capture_id),
      attemptState, evaluatedAt, dueAt, confirmedAt: validTime(mo.confirmedAt), reasons: strs(e.reasons), incidentId: null, graceMs: graceMs !== null && graceMs > 0 ? graceMs : null, readbackConfirmed }];
  });
}

/* ---------------- incident list ---------------- */
export type IncidentKind = 'duplicate' | 'missing' | 'other';
export type IncidentSummary = { id: string; kind: IncidentKind; title: string; state: 'open' | 'resolved'; openedAt: string; intentId: string; paypalOrderId: string | null; captureId: string | null; orderCount: number };
export const kindOf = (c: unknown): IncidentKind => c === 'DUPLICATE_MERCHANT_ORDER' ? 'duplicate' : c === 'MISSING_MERCHANT_ORDER' ? 'missing' : 'other';
export const KIND_LABEL: Record<IncidentKind, string> = { duplicate: 'Duplicate orders', missing: 'Missing order', other: 'Contract violation' };
export function parseIncidents(raw: unknown, org: string): IncidentSummary[] {
  const r = object(raw);
  if (r.organizationId !== org) throw Error('The API answered for a different organization; nothing is shown.');
  if (!Array.isArray(r.incidents)) throw Error('The incidents response is malformed.');
  return list(r.incidents).flatMap(x => {
    const i = object(x), id = str(i.id), openedAt = validTime(i.openedAt), intentId = str(i.intentId);
    if (!id || !INCIDENT_PATTERN.test(id) || !openedAt || !intentId) return [];
    return [{ id, kind: kindOf(i.class), title: str(i.title) ?? 'Untitled incident', state: i.state === 'resolved_verified' ? 'resolved' as const : 'open' as const, openedAt, intentId,
      paypalOrderId: str(i.paypalOrderId), captureId: str(i.captureId), orderCount: int(i.affectedOrderCount) ?? 0 }];
  });
}
/** Link each checkout to its open incident, or to the most recent resolved one. */
export function linkIncidents(checkouts: Checkout[], incidents: IncidentSummary[]): Checkout[] {
  return checkouts.map(c => {
    const mine = incidents.filter(i => i.intentId === c.intentId).toSorted((a, b) => Number(b.state === 'open') - Number(a.state === 'open') || Date.parse(b.openedAt) - Date.parse(a.openedAt));
    return { ...c, incidentId: mine[0]?.id ?? null };
  });
}

/* ---------------- grace ---------------- */
/** "5 min grace period", from the grace the checker stored. Never assumes the default. */
export const graceLabel = (ms: number | null) => ms === null ? 'grace period' : `${duration(ms)} grace period`;
export type GracePhase = 'inside' | 'overdue_unchecked' | 'rechecked_after_deadline';
export type Grace = { phase: GracePhase; dueAt: string; graceMs: number | null; label: string; note: string };
/** Where a paid checkout stands against its persisted deadline, judged from the latest stored check. Never runs a check. */
export function graceStatus(c: Checkout, now: number): Grace | null {
  if (!c.dueAt) return null;
  const due = Date.parse(c.dueAt), grace = graceLabel(c.graceMs);
  if (c.outcome === 'waiting') return now < due
    ? { phase: 'inside', dueAt: c.dueAt, graceMs: c.graceMs, label: `Inside the ${grace}`, note: 'No order yet. The last recorded check was inside the grace period.' }
    : { phase: 'overdue_unchecked', dueAt: c.dueAt, graceMs: c.graceMs, label: 'Deadline passed, not re-checked', note: 'The deadline passed after the last recorded check. Nothing is known about the order until the checker runs again.' };
  if (Date.parse(c.evaluatedAt) >= due) return { phase: 'rechecked_after_deadline', dueAt: c.dueAt, graceMs: c.graceMs, label: 'Re-checked after the deadline', note: c.outcome === 'missing' ? 'Checked after the deadline: still no order.' : 'Checked after the deadline.' };
  return null;
}

/* ---------------- overview ---------------- */
export type Overview = {
  checked: number; capturedMinor: number; capturedConfirmed: number; capturedUnconfirmed: number; matched: number; open: IncidentSummary[]; resolved: number; atRiskMinor: number;
  waiting: Checkout[]; insideGrace: Checkout[]; overdue: Checkout[]; unpaid: number; unclear: number; contradictory: Checkout[]; lastCheckedAt: string | null;
  strip: Array<{ intentId: string; outcome: Outcome; label: string; href: string | null }>;
};
export function overview(checkouts: Checkout[], incidents: IncidentSummary[], now = Date.now()): Overview {
  const byIntent = new Map(checkouts.map(c => [c.intentId, c]));
  const open = incidents.filter(i => i.state === 'open').toSorted((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
  const openIntents = new Set(open.map(i => i.intentId));
  const waiting = checkouts.filter(c => c.outcome === 'waiting').toSorted((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!));
  const overdue = waiting.filter(c => graceStatus(c, now)?.phase === 'overdue_unchecked');
  const confirmed = checkouts.filter(c => c.readbackConfirmed);
  return {
    checked: checkouts.length,
    // Only captures that a stored PayPal readback confirmed. Local attempt state alone is not counted.
    capturedMinor: confirmed.reduce((n, c) => n + (c.amountMinor ?? 0), 0),
    capturedConfirmed: confirmed.length,
    capturedUnconfirmed: checkouts.filter(c => c.attemptState === 'captured' && !c.readbackConfirmed).length,
    matched: checkouts.filter(c => c.outcome === 'matched').length,
    open, resolved: incidents.filter(i => i.state === 'resolved').length,
    atRiskMinor: open.reduce((n, i) => n + (byIntent.get(i.intentId)?.amountMinor ?? 0), 0),
    waiting, overdue, insideGrace: waiting.filter(c => !overdue.includes(c)),
    unpaid: checkouts.filter(c => c.outcome === 'unpaid').length,
    unclear: checkouts.filter(c => c.outcome === 'unclear').length,
    // The latest check says the rule is broken, yet no open incident exists for it: the two records disagree.
    contradictory: checkouts.filter(c => (c.outcome === 'duplicate' || c.outcome === 'missing') && !openIntents.has(c.intentId)),
    lastCheckedAt: checkouts.map(c => c.evaluatedAt).toSorted().at(-1) ?? null,
    strip: checkouts.toSorted((a, b) => Date.parse(a.createdAt ?? a.evaluatedAt) - Date.parse(b.createdAt ?? b.evaluatedAt))
      .map(c => ({ intentId: c.intentId, outcome: c.outcome, label: `${c.sku}, ${money(c.amountMinor, c.currency)}: ${overdue.includes(c) ? 'Deadline passed, not re-checked' : OUTCOME[c.outcome].label}`, href: c.incidentId ? `/console/incidents/${c.incidentId}` : null })),
  };
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const be = (n: number) => n === 1 ? 'is' : 'are';
export type Verdict = { tone: Tone; headline: string; notes: string[] };
/** The Overview headline. An all-clear is only claimed when every checked checkout matched. */
export function verdict(o: Overview): Verdict {
  const notes: string[] = [];
  const n = o.open.length;
  if (o.contradictory.length) notes.push(`${plural(o.contradictory.length, 'checkout')} ${o.contradictory.length === 1 ? 'fails' : 'fail'} the rule but ${o.contradictory.length === 1 ? 'has' : 'have'} no open incident. The records disagree; investigate before trusting this page.`);
  if (o.overdue.length) notes.push(`${plural(o.overdue.length, 'payment')} passed the grace deadline after the last check. Whether an order arrived is unknown until the checker runs again.`);
  if (o.insideGrace.length) notes.push(`${plural(o.insideGrace.length, 'payment')} ${be(o.insideGrace.length)} still inside the grace period with no order yet.`);
  if (o.unclear) notes.push(`${plural(o.unclear, 'check')} could not decide. Read the reasons under Checkouts.`);
  if (o.unpaid) notes.push(`${plural(o.unpaid, 'checkout')} ${o.unpaid === 1 ? 'was' : 'were'} not captured, so no order is expected.`);
  if (o.capturedUnconfirmed) notes.push(`${plural(o.capturedUnconfirmed, 'capture')} ${be(o.capturedUnconfirmed)} recorded locally without a confirming PayPal readback and ${be(o.capturedUnconfirmed)} not counted as checked value.`);
  if (o.resolved) notes.push(`${plural(o.resolved, 'incident')} resolved earlier ${o.resolved === 1 ? 'stays' : 'stay'} on record under Incidents.`);
  if (n) return { tone: 'break', headline: `${plural(n, 'payment')} need${n === 1 ? 's' : ''} attention.`, notes };
  if (o.contradictory.length) return { tone: 'break', headline: 'Rule checks and incidents disagree.', notes };
  if (o.overdue.length) return { tone: 'wait', headline: `No open incidents, but ${plural(o.overdue.length, 'payment')} ${be(o.overdue.length)} overdue for a re-check.`, notes };
  if (o.insideGrace.length) return { tone: 'wait', headline: `No open incidents. ${plural(o.insideGrace.length, 'payment')} ${be(o.insideGrace.length)} still waiting for an order.`, notes };
  if (o.unclear) return { tone: 'neutral', headline: `No open incidents, but ${plural(o.unclear, 'check')} could not decide.`, notes };
  if (o.matched === 0) return { tone: 'neutral', headline: 'No captured payments to match yet.', notes };
  if (o.matched === o.checked) return { tone: 'hold', headline: 'Every checked payment matches its order.', notes };
  return { tone: 'hold', headline: `Every captured payment matches its order (${o.matched} of ${o.checked} checkouts).`, notes };
}

/* ---------------- incident detail ---------------- */
export type OrderRow = { id: string; path: string; createdAt: string | null; original: string; effective: string; faultInjection: string | null; amountMinor: number | null; voidedAt: string | null };
/** cited: the opening rule check relied on this record. snapshotStatus/nowStatus: a store row as recorded vs its effective status today. */
export type EvidenceRow = { seq: number; cls: string; refType: string; refId: string; sourceAt: string | null; summary: unknown; cited: boolean; snapshotStatus: string | null; nowStatus: string | null };
export type Plan = { id: string; createdAt: string; expiresAt: string; sha: string; keep: string; voids: string[]; requester: string };
export type Approval = { planId: string; operator: string; mode: string; at: string };
export type Execution = { planId: string; id: string; startedAt: string | null; outcome: string | null; reasons: string[]; before: string | null; after: string | null; completedAt: string | null };
export type Resolution = { executionId: string; at: string; postcondition: { result: string; count: number | null; at: string | null } | null };
export type Detail = {
  view: View; kind: IncidentKind; state: 'open' | 'resolved'; amountMinor: number | null; currency: string; orders: OrderRow[]; evidence: EvidenceRow[];
  plans: Plan[]; approvals: Approval[]; executions: Execution[]; resolutions: Resolution[]; records: RepairRecord[];
  missing: { dueAt: string | null; confirmedAt: string | null; graceMs: number | null; impact: string; nextAction: string; lastChecked: string } | null;
  reproduction: { cause: string; mechanism: string | null; reproduce: string[]; note: string | null };
  separationOfDuties: boolean;
};
const parseJson = (v: unknown): unknown => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };
export function parseDetail(raw: unknown, org: string): Detail {
  const view = mapIncident(raw, org), r = object(raw), history = object(r.repairHistory), mo = r.missingOrder === undefined ? null : object(r.missingOrder);
  const voids = list(history.voids).map(object);
  const orders: OrderRow[] = list(r.affectedOrders).map(object).map(o => ({
    id: String(o.id), path: str(o.createdByPath) ?? 'unknown', createdAt: validTime(o.createdAt), original: str(o.status) ?? 'unknown', effective: str(o.effectiveStatus) ?? 'unknown',
    faultInjection: str(o.faultInjectionId), amountMinor: int(object(o.amount).minor), voidedAt: validTime(voids.find(v => v.order_id === o.id)?.created_at),
  }));
  const evidence: EvidenceRow[] = list(r.evidence).map(object).map(e => {
    const refType = str(object(e.ref).type) ?? '', refId = str(object(e.ref).id) ?? '', cls = str(e.evidenceClass) ?? 'UNKNOWN', snap = object(object(e.summary).snapshot);
    const cited = (cls === 'PAYPAL_API_READBACK' && refType === 'evidence' && view.opening.readbacks.includes(Number(refId))) || (cls === 'MERCHANT_DB_OBSERVED' && refType === 'merchant_order' && view.opening.ids.includes(refId));
    const snapshotStatus = cls === 'MERCHANT_DB_OBSERVED' ? str(snap.effective_status) ?? str(snap.status) : null;
    return { seq: int(e.seq) ?? 0, cls, refType, refId, sourceAt: validTime(e.sourceAt), summary: e.summary, cited, snapshotStatus, nowStatus: snapshotStatus ? orders.find(o => o.id === refId)?.effective ?? null : null };
  });
  const readbackAmount = evidence.filter(e => e.cls === 'PAYPAL_API_READBACK').map(e => object(object(e.summary).amount)).find(a => typeof a.value === 'string');
  const amountMinor = view.provider.trust.startsWith('PAYPAL_API_READBACK') && readbackAmount ? Math.round(Number(readbackAmount.value) * 100) : int(object(mo?.impact).minor) ?? orders[0]?.amountMinor ?? null;
  const plans: Plan[] = list(history.plans).map(object).flatMap(p => {
    const id = str(p.id), createdAt = validTime(p.created_at), expiresAt = validTime(p.expires_at), sha = str(p.plan_sha256), keep = str(p.keep_order_id);
    return id && createdAt && expiresAt && sha && keep ? [{ id, createdAt, expiresAt, sha, keep, voids: strs(parseJson(p.void_order_ids_json)), requester: str(p.requester_name) ?? 'unknown' }] : [];
  }).toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const approvals: Approval[] = list(history.approvals).map(object).flatMap(a => { const planId = str(a.plan_id), at = validTime(a.approved_at); return planId && at ? [{ planId, operator: str(a.operator_name) ?? 'unknown', mode: str(a.approval_mode) ?? 'unknown', at }] : []; });
  const executions: Execution[] = list(history.executions).map(object).flatMap(e => {
    const planId = str(e.plan_id), id = str(e.execution_id) ?? str(e.id);
    return planId && id ? [{ planId, id, startedAt: validTime(e.started_at), outcome: str(e.outcome), reasons: strs(parseJson(e.reasons_json)), before: str(e.provider_before_sha256), after: str(e.provider_after_sha256), completedAt: validTime(e.completed_at) }] : [];
  });
  const resolutions: Resolution[] = list(history.resolutions).map(object).flatMap(x => {
    const executionId = str(x.execution_id), at = validTime(x.created_at), pc = x.postcondition ? object(x.postcondition) : null;
    return executionId && at ? [{ executionId, at, postcondition: pc ? { result: str(pc.result) ?? 'UNAVAILABLE', count: int(pc.activeOrderCount), at: validTime(pc.evaluatedAt) } : null }] : [];
  });
  const opening = object(object(object(r.openingEvaluation).facts).missingOrder), rep = object(r.reproduction);
  const reproduce = str(rep.reproduce);
  return {
    view, kind: kindOf(r.class), state: r.state === 'resolved_verified' && resolutions.length > 0 ? 'resolved' : 'open', amountMinor, currency: 'USD', orders, evidence, plans, approvals, executions, resolutions, records: repairRecords(history),
    missing: mo ? { dueAt: validTime(opening.dueAt), confirmedAt: validTime(opening.confirmedAt), graceMs: (int(opening.graceMs) ?? 0) > 0 ? int(opening.graceMs) : null, impact: str(object(mo.impact).description) ?? '', nextAction: str(mo.nextAction) ?? '', lastChecked: str(mo.lastCheckedCondition) ?? 'RECHECK_REQUIRED' } : null,
    reproduction: { cause: str(rep.cause) ?? 'UNKNOWN', mechanism: str(rep.mechanism), reproduce: reproduce ? reproduce.split(/\s+or\s+/).map(x => x.replace(/\s*\([^)]*\)\s*$/, '').trim()).filter(Boolean) : [], note: str(rep.note) },
    separationOfDuties: history.separationOfDutiesEnforced === true,
  };
}

/** For a missing-order incident: what the latest stored check says now. The incident itself stays open either way. */
export type MissingNow = 'late_order' | 'still_missing' | 'recheck';
export const missingNow = (d: Detail): MissingNow | null => !d.missing ? null : d.missing.lastChecked === 'ORDER_PRESENT' ? 'late_order' : d.missing.lastChecked === 'MISSING_AFTER_GRACE' ? 'still_missing' : 'recheck';

/* ---------------- evidence scope and stored repair records ---------------- */
/** What each evidence class can and cannot establish. Shown beside every record so nobody over-reads it. */
export const EVIDENCE_SCOPE: Record<string, { shows: string; not: string }> = {
  PAYPAL_API_READBACK: { shows: 'What PayPal’s API returned for this order when OrderTruth read it.', not: 'A fresh check: it is not re-read here. It does not prove shipment, a second charge or a loss.' },
  PAYPAL_VERIFIED_WEBHOOK: { shows: 'A PayPal webhook whose signature was verified when it arrived.', not: 'That the store applied it exactly once.' },
  MERCHANT_DB_OBSERVED: { shows: 'A store database row as OrderTruth read it at that moment.', not: 'The row’s status today, PayPal’s view of the payment, or whether anything shipped.' },
  CONTROLLED_FAULT_INJECTION: { shows: 'A fault that a local test injected on purpose.', not: 'Provider truth, or the cause of any incident outside that test.' },
};
export const scopeOf = (cls: string) => EVIDENCE_SCOPE[cls] ?? { shows: 'A stored record linked to this incident.', not: 'Anything beyond its own contents.' };
export type RepairKind = 'plan' | 'approval' | 'run' | 'void' | 'resolution' | 'audit';
export const REPAIR_KIND_LABEL: Record<RepairKind, string> = { plan: 'Plan', approval: 'Approval', run: 'Run', void: 'Void', resolution: 'Resolution', audit: 'Audit' };
export type RepairRecord = { key: string; kind: RepairKind; at: string | null; text: string; fields: Array<[string, string]> };
const field = (v: unknown): string => { const t = typeof v === 'string' ? v : JSON.stringify(v) ?? 'null'; return t.length > 280 ? `${t.slice(0, 280)}… (${t.length} characters)` : t; };
const ORDER: RepairKind[] = ['plan', 'approval', 'run', 'void', 'resolution', 'audit'];
/** Every stored repair row, in time order, with a plain sentence and its raw columns. Nothing is inferred from the latest check. */
export function repairRecords(history: Obj): RepairRecord[] {
  const rows = (k: string) => list(history[k]).map(object);
  const out: RepairRecord[] = [];
  const add = (kind: RepairKind, n: number, row: Obj, at: unknown, text: string) => out.push({ key: `${kind}:${n}`, kind, at: validTime(at), text, fields: Object.entries(row).map(([k, v]): [string, string] => [k, field(v)]) });
  rows('plans').forEach((p, n) => add('plan', n, p, p.created_at, `${str(p.requester_name) ?? 'Someone'} planned to keep ${shortId(str(p.keep_order_id) ?? '?')} and void ${strs(parseJson(p.void_order_ids_json)).map(shortId).join(', ') || 'nothing'}. Valid until ${clock(validTime(p.expires_at))}.`));
  rows('approvals').forEach((a, n) => add('approval', n, a, a.approved_at, `${str(a.operator_name) ?? 'Someone'} approved plan ${shortId(str(a.plan_id) ?? '?')} (${a.approval_mode === 'SIMULATED_TEST' ? 'simulated in a test' : a.approval_mode === 'INTERACTIVE_TTY' ? 'typed in a terminal' : str(a.approval_mode) ?? 'mode unknown'}). The name is declared, not authenticated.`));
  rows('executions').forEach((x, n) => {
    const before = str(x.provider_before_sha256), after = str(x.provider_after_sha256), reasons = strs(parseJson(x.reasons_json));
    add('run', n, x, x.completed_at ?? x.started_at, `Run ${shortId(str(x.execution_id) ?? str(x.id) ?? '?')} ended ${str(x.outcome) ?? 'without an outcome'}.${before && after ? before === after ? ' Stored PayPal evidence hash unchanged.' : ' Stored PayPal evidence hash changed.' : ''}${reasons.length ? ` ${reasons.join(' ')}` : ''}`);
  });
  rows('voids').forEach((v, n) => add('void', n, v, v.created_at, `Order ${shortId(str(v.order_id) ?? '?')} marked void (${str(v.reason) ?? 'no reason'}). The row is kept.`));
  rows('resolutions').forEach((x, n) => { const pc = object(x.postcondition); add('resolution', n, x, x.created_at, `Resolved by check #${int(x.evaluation_seq) ?? '?'}: ${str(pc.result) ?? 'result unavailable'}, ${int(pc.activeOrderCount) ?? '?'} live order${int(pc.activeOrderCount) === 1 ? '' : 's'}.`); });
  rows('audit').forEach((a, n) => add('audit', n, a, a.created_at, `Audit entry ${int(a.seq) ?? n + 1}: ${str(a.event) ?? 'event unknown'}.`));
  return out.toSorted((a, b) => (Date.parse(a.at ?? '') || 0) - (Date.parse(b.at ?? '') || 0) || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

/* ---------------- repair stage (what the operator can do next) ---------------- */
export type Stage =
  | { stage: 'unsupported' }
  | { stage: 'needs_plan' }
  | { stage: 'awaiting_approval'; plan: Plan }
  | { stage: 'approved'; plan: Plan; approval: Approval }
  | { stage: 'expired'; plan: Plan }
  | { stage: 'failed'; plan: Plan; execution: Execution }
  | { stage: 'resolved'; plan: Plan | null; execution: Execution | null; resolution: Resolution };
export function repairStage(d: Detail, now: number): Stage {
  if (d.resolutions.length > 0) {
    const resolution = d.resolutions[0]!, execution = d.executions.find(e => e.id === resolution.executionId) ?? null;
    return { stage: 'resolved', resolution, execution, plan: d.plans.find(p => p.id === execution?.planId) ?? null };
  }
  if (d.kind !== 'duplicate') return { stage: 'unsupported' };
  const plan = d.plans.at(-1);
  if (!plan) return { stage: 'needs_plan' };
  const execution = d.executions.find(e => e.planId === plan.id);
  if (execution && execution.outcome !== 'SUCCEEDED') return { stage: 'failed', plan, execution };
  if (Date.parse(plan.expiresAt) <= now && !execution) return { stage: 'expired', plan };
  const approval = d.approvals.find(a => a.planId === plan.id);
  return approval ? { stage: 'approved', plan, approval } : { stage: 'awaiting_approval', plan };
}
export type Command = { label: string; command: string; note: string };
export const DB_PLACEHOLDER = '<isolated.sqlite>';
export function repairCommands(st: Stage, incidentId: string, org: string): Command[] {
  const cmd = (c: string, rest: string) => `pnpm repair ${c} --db ${DB_PLACEHOLDER} --org ${org} ${rest}`;
  const plan = { label: 'Create a repair plan', command: cmd('plan', `--incident ${incidentId} --requester "<your name>"`), note: 'Records which order stays live and which is voided. Expires after 15 minutes.' };
  switch (st.stage) {
    case 'needs_plan': case 'expired': case 'failed': return [plan,
      { label: 'Approve it in a terminal', command: cmd('approve', `--plan <plan id> --plan-sha256 <plan hash> --operator "<your name>"`), note: 'Needs an interactive terminal and the typed confirmation.' },
      { label: 'Run it', command: cmd('execute', '--plan <plan id>'), note: 'Voids the extra order in the store, then re-checks the rule.' }];
    case 'awaiting_approval': return [
      { label: 'Approve it in a terminal', command: cmd('approve', `--plan ${st.plan.id} --plan-sha256 ${st.plan.sha} --operator "<your name>"`), note: 'Needs an interactive terminal and the typed confirmation.' },
      { label: 'Run it', command: cmd('execute', `--plan ${st.plan.id}`), note: 'Voids the extra order in the store, then re-checks the rule.' }];
    case 'approved': return [{ label: 'Run it', command: cmd('execute', `--plan ${st.plan.id}`), note: 'Voids the extra order in the store, then re-checks the rule.' }];
    case 'resolved': return [{ label: 'Read the full receipt', command: cmd('history', `--incident ${incidentId}`), note: 'Prints every plan, approval, outcome and audit record.' }];
    case 'unsupported': return [];
  }
}

/* ---------------- reconciliation timeline ---------------- */
export type Lane = 'buyer' | 'paypal' | 'store' | 'ordertruth';
export const LANES: Array<{ id: Lane; name: string; sub: string }> = [
  { id: 'buyer', name: 'Buyer', sub: 'Checkout' },
  { id: 'paypal', name: 'PayPal', sub: 'API readback' },
  { id: 'store', name: 'Store', sub: 'Merchant database' },
  { id: 'ordertruth', name: 'OrderTruth', sub: 'Rule and repair' },
];
export type Mark = 'provider' | 'merchant' | 'rule' | 'break' | 'hold' | 'action' | 'neutral' | 'test';
export type EvidenceTag = { cls: string; label: string };
export type TimelineEvent = { key: string; at: string; lane: Lane; title: string; detail: string; mark: Mark; tag: EvidenceTag | null; story: string };
export type Timeline = { events: TimelineEvent[]; columns: Array<{ at: string; delta: number | null }>; breaks: Array<{ from: number; to: number | null; label: string }>; healedAt: number | null; start: string | null; end: string | null };
export const EVIDENCE_LABEL: Record<string, string> = {
  PAYPAL_API_READBACK: 'PayPal readback', PAYPAL_VERIFIED_WEBHOOK: 'Verified webhook', MERCHANT_DB_OBSERVED: 'Store record', CONTROLLED_FAULT_INJECTION: 'Controlled test',
  AI_HYPOTHESIS: 'AI hypothesis', OPERATOR_STATEMENT: 'Operator statement', DETERMINISTIC_EVALUATION: 'Rule check', LOCAL_REPAIR_RECORD: 'Repair record',
};
const tag = (cls: string, ref = ''): EvidenceTag => ({ cls, label: ref ? `${EVIDENCE_LABEL[cls] ?? cls} ${ref}` : EVIDENCE_LABEL[cls] ?? cls });
export function buildTimeline(d: Detail, checkout: Checkout | null): Timeline {
  const ev: TimelineEvent[] = [], amount = money(d.amountMinor, d.currency);
  const push = (e: TimelineEvent | false | null) => { if (e && validTime(e.at)) ev.push(e); };
  if (checkout?.createdAt) push({ key: 'checkout', at: checkout.createdAt, lane: 'buyer', title: 'Checkout started', detail: `${checkout.sku} · ${money(checkout.amountMinor, checkout.currency)}`, mark: 'neutral', tag: null, story: `The buyer started checkout for ${checkout.sku}.` });
  for (const e of d.evidence) {
    if (e.cls === 'PAYPAL_API_READBACK') push({ key: `rb${e.seq}`, at: e.sourceAt ?? '', lane: 'paypal', title: `Capture confirmed`, detail: `${amount} · completed`, mark: 'provider', tag: tag(e.cls, `#${e.refId}`), story: `PayPal confirmed one completed capture of ${amount}.` });
    if (e.cls === 'CONTROLLED_FAULT_INJECTION') push({ key: `fi${e.seq}`, at: e.sourceAt ?? '', lane: 'store', title: 'Test fault injected', detail: 'Race between two order paths', mark: 'test', tag: tag(e.cls), story: 'A controlled test made two order paths race each other. This is a lab fault, not a customer event.' });
  }
  d.orders.forEach((o, n) => {
    const extra = d.kind === 'duplicate' && n > 0;
    push({ key: `o${o.id}`, at: o.createdAt ?? '', lane: 'store', title: extra ? 'Extra order created' : 'Order created', detail: `${shortId(o.id)} · ${pathLabel(o.path)}`, mark: extra ? 'break' : 'merchant', tag: tag('MERCHANT_DB_OBSERVED'),
      story: extra ? `The store created a second order, ${shortId(o.id)}, for the same payment via the ${pathPhrase(o.path)}.` : `The store created order ${shortId(o.id)} via the ${pathPhrase(o.path)}.` });
    if (o.voidedAt) push({ key: `void:${o.id}`, at: o.voidedAt, lane: 'store', title: 'Extra order voided', detail: shortId(o.id), mark: 'hold', tag: tag('LOCAL_REPAIR_RECORD'), story: `Order ${shortId(o.id)} was voided in the store. PayPal was not contacted.` });
  });
  if (d.missing?.dueAt) push({ key: 'due', at: d.missing.dueAt, lane: 'store', title: 'Grace period ended', detail: 'Still no order', mark: 'break', tag: null, story: `The ${graceLabel(d.missing.graceMs)} ended and the store still had no order for this payment.` });
  const o = d.view.opening;
  push(o.seq > 0 && { key: 'open', at: o.at, lane: 'ordertruth', title: d.kind === 'missing' ? 'Rule broken: paid, no order' : `Rule broken: 1 capture, ${o.count ?? '?'} orders`, detail: `Incident opened · check #${o.seq}`, mark: 'break', tag: tag('DETERMINISTIC_EVALUATION', `#${o.seq}`),
    story: d.kind === 'missing' ? 'OrderTruth opened an incident: the payment was captured but no order exists.' : `OrderTruth opened an incident: the store allows one order per payment and found ${o.count ?? 'several'}.` });
  for (const p of d.plans) push({ key: `p${p.id}`, at: p.createdAt, lane: 'ordertruth', title: 'Repair planned', detail: `by ${p.requester} · keep ${shortId(p.keep)}`, mark: 'action', tag: tag('LOCAL_REPAIR_RECORD'), story: `${p.requester} planned a repair: keep ${shortId(p.keep)}, void ${p.voids.map(shortId).join(', ')}.` });
  for (const a of d.approvals) push({ key: `a${a.planId}`, at: a.at, lane: 'ordertruth', title: 'Repair approved', detail: `by ${a.operator} (declared)`, mark: 'action', tag: tag('OPERATOR_STATEMENT'), story: `${a.operator} approved the plan. The name is declared, not verified by a login.` });
  for (const x of d.executions) if (x.completedAt && x.outcome !== 'SUCCEEDED') push({ key: `x${x.id}`, at: x.completedAt, lane: 'ordertruth', title: 'Repair refused', detail: x.outcome ?? 'No outcome', mark: 'break', tag: tag('LOCAL_REPAIR_RECORD'), story: `The repair did not run: ${x.outcome ?? 'no outcome recorded'}. Nothing was changed.` });
  for (const r of d.resolutions) push({ key: `res:${r.executionId}`, at: r.at, lane: 'ordertruth', title: r.postcondition?.result === 'HOLDS' ? 'Re-checked: rule holds' : 'Re-checked', detail: 'Incident resolved', mark: 'hold', tag: tag('DETERMINISTIC_EVALUATION'), story: 'OrderTruth re-checked the payment after the repair. One capture, one live order. The incident is resolved.' });
  const l = d.view.latest;
  if (l.seq > 0 && l.seq !== o.seq && !d.resolutions.some(r => r.postcondition?.at === l.at)) push({ key: 'latest', at: l.at, lane: 'ordertruth', title: `Latest check: ${l.result === 'HOLDS' ? 'holds' : l.result === 'VIOLATED' ? 'still broken' : l.result.toLowerCase().replace('_', ' ')}`, detail: `check #${l.seq}`, mark: l.result === 'HOLDS' ? 'hold' : l.result === 'VIOLATED' ? 'break' : 'rule', tag: tag('DETERMINISTIC_EVALUATION', `#${l.seq}`), story: `The most recent check (#${l.seq}) found: ${l.reasons.join('; ') || l.result}.` });

  const order: Lane[] = ['buyer', 'paypal', 'store', 'ordertruth'];
  ev.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || order.indexOf(a.lane) - order.indexOf(b.lane));
  const columns = ev.map((e, n) => ({ at: e.at, delta: n === 0 ? null : Date.parse(e.at) - Date.parse(ev[n - 1]!.at) }));
  const breaks: Timeline['breaks'] = [];
  const healIdx = ev.findIndex(e => e.key.startsWith('void:') || e.key.startsWith('res:'));
  if (d.kind === 'duplicate') {
    const first = ev.findIndex(e => e.mark === 'break' && e.lane === 'store');
    if (first >= 0) breaks.push({ from: first, to: healIdx >= 0 ? healIdx : null, label: 'More than one live order' });
  }
  if (d.kind === 'missing') {
    const from = ev.findIndex(e => e.lane === 'paypal');
    // A late order ends the gap in the store lane; the incident itself stays open.
    const late = ev.findIndex((e, i) => i > from && e.lane === 'store' && e.key.startsWith('o'));
    if (from >= 0) breaks.push({ from, to: late >= 0 ? late : null, label: 'No store order' });
  }
  return { events: ev, columns, breaks, healedAt: healIdx >= 0 ? healIdx : null, start: ev[0]?.at ?? null, end: ev.at(-1)?.at ?? null };
}

/* ---------------- search ---------------- */
export type SearchEntry = { kind: 'incident' | 'checkout'; title: string; sub: string; href: string; hay: string };
export function searchIndex(incidents: IncidentSummary[], checkouts: Checkout[]): SearchEntry[] {
  const sku = new Map(checkouts.map(c => [c.intentId, c]));
  return [
    ...incidents.map(i => ({ kind: 'incident' as const, title: `${incidentRef(i.id)} · ${KIND_LABEL[i.kind]}`, sub: `${sku.get(i.intentId)?.sku ?? 'Checkout'} · ${i.state === 'open' ? 'Open' : 'Resolved'}`, href: `/console/incidents/${i.id}`,
      hay: [i.id, incidentRef(i.id), i.title, KIND_LABEL[i.kind], i.intentId, i.paypalOrderId, i.captureId, sku.get(i.intentId)?.sku, i.state].join(' ').toLowerCase() })),
    ...checkouts.map(c => ({ kind: 'checkout' as const, title: `${c.sku} · ${money(c.amountMinor, c.currency)}`, sub: `${OUTCOME[c.outcome].label} · ${shortId(c.intentId)}`, href: c.incidentId ? `/console/incidents/${c.incidentId}` : `/console/checkouts?q=${encodeURIComponent(c.intentId)}`,
      hay: [c.intentId, c.sku, c.paypalOrderId, c.captureId, ...c.orderIds, OUTCOME[c.outcome].label].join(' ').toLowerCase() })),
  ];
}
export function search(entries: SearchEntry[], query: string, limit = 8): SearchEntry[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return entries.filter(e => terms.every(t => e.hay.includes(t)))
    .map(e => ({ e, score: terms.reduce((n, t) => n + (e.hay.split(' ').some(w => w.startsWith(t)) ? 2 : 1), 0) + (e.kind === 'incident' ? 0.5 : 0) }))
    .sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.e);
}
export function matchesQuery(c: Checkout, q: string): boolean {
  const terms = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const hay = [c.intentId, c.sku, c.paypalOrderId, c.captureId, ...c.orderIds, OUTCOME[c.outcome].label].join(' ').toLowerCase();
  return terms.every(t => hay.includes(t));
}
export const NEXT_TEST: Record<string, string> = {
  QUERY_MERCHANT_ORDERS: 'Query the store’s orders for this checkout',
  REPLAY_CONCURRENT_HANDLERS: 'Replay both order paths concurrently on a local copy',
  REQUEST_MORE_EVIDENCE: 'Collect more evidence before naming a cause',
  QUERY_PROVIDER_READBACK: 'Take a fresh PayPal readback (needs separate approval)',
  WAIT_FOR_GRACE_PERIOD: 'Wait for the grace period to end, then re-check',
  NONE: 'No test needed',
};
export type Advisory = { status: string; trust: string; reason: string; advice: Array<{ hypothesis: string; uncertainty: string; evidenceIds: string[]; nextTest: string }>; citations: Array<{ id: string; trust: string; ref: string }>; calls: number };
export function parseAdvisory(raw: unknown, incidentId: string, org: string): Advisory {
  const r = object(raw), a = object(r.analysis);
  if (r.incidentId !== incidentId || r.organizationId !== org) throw Error('Advisory answered for a different incident; ignored.');
  return {
    status: str(a.status) ?? 'UNKNOWN', trust: str(a.trust) ?? 'UNKNOWN', reason: str(a.reason) ?? '',
    advice: list(a.advice).map(object).map(x => ({ hypothesis: str(x.hypothesis) ?? '', uncertainty: str(x.uncertainty) ?? '', evidenceIds: strs(x.evidenceIds), nextTest: str(x.nextTest) ?? 'NONE' })),
    citations: list(r.citations).map(object).map(c => ({ id: str(c.id) ?? '?', trust: str(c.trust) ?? 'UNKNOWN', ref: `${str(c.sourceRefType) ?? ''}:${str(c.sourceRefId) ?? ''}` })),
    calls: int(object(a.metrics).calls) ?? 0,
  };
}
export type Lens = 'ops' | 'eng';
export const lensFrom = (search: string): Lens => new URLSearchParams(search).get('lens') === 'eng' ? 'eng' : 'ops';
export type UrlScope = { kind: 'none' } | { kind: 'valid'; org: string } | { kind: 'invalid'; reason: string };
/** The organization a link asks for. Malformed or repeated values are rejected, never replaced by a default. */
export function scopeFromUrl(search: string): UrlScope {
  const all = new URLSearchParams(search).getAll('org');
  if (all.length === 0) return { kind: 'none' };
  if (all.length > 1) return { kind: 'invalid', reason: 'The link names more than one organization.' };
  return ORG_PATTERN.test(all[0]!) ? { kind: 'valid', org: all[0]! } : { kind: 'invalid', reason: 'The organization in the link is not a valid scope. Expected org_ followed by lowercase letters, digits or underscores.' };
}
export { type View, object, type Obj };
