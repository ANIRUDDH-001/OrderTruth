import { syntheticIncident } from './synthetic.ts';
import { parseProviderValue,toProviderValue } from '../../src/domain/money.ts';

type Obj = Record<string, unknown>;
export type Moment = 'detection' | 'latest';
export type Entity = { id: string; title: string; trust: string; at: string; fields: [string, string][]; limit: string };
export type Evaluation = { seq: number; result: string; count: number | null; at: string; ids: string[]; readbacks: number[]; reasons: string[] };
export type Order = { id: string; original: string; effective: string; at: string; path: string; amount: string };
export type View = { id: string; org: string; title: string; kind: string; contract: string; state: string; opened: string; intent: string; capture: string; provider: Entity; opening: Evaluation; latest: Evaluation; orders: Order[]; observations: Entity[]; evidence: Entity[]; warnings: string[]; receipt: Entity[] };
export const object = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const text = (v: unknown, fallback = 'Unavailable'): string => typeof v === 'string' && v.length <= 2000 ? v : fallback;
const list = (v: unknown): unknown[] => Array.isArray(v) && v.length <= 500 ? v : [];
const strs = (v: unknown): string[] => list(v).filter((x): x is string => typeof x === 'string');
const timestamp = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : 'Timestamp unavailable';
const unavailable: Evaluation = { seq: 0, result: 'UNAVAILABLE', count: null, at: 'Timestamp unavailable', ids: [], readbacks: [], reasons: [] };
function evaluation(raw: unknown): Evaluation {
  const r = object(raw), f = object(r.facts);
  if (!Number.isSafeInteger(r.seq) || !['HOLDS', 'VIOLATED', 'NOT_ELIGIBLE', 'OUT_OF_SCOPE'].includes(String(r.result)) || !Number.isSafeInteger(r.activeOrderCount) || Number(r.activeOrderCount) < 0 || timestamp(r.evaluatedAt) === 'Timestamp unavailable') return { ...unavailable };
  return { seq: Number(r.seq), result: String(r.result), count: Number(r.activeOrderCount), at: timestamp(r.evaluatedAt), ids: strs(f.matchingOrderIds), readbacks: list(f.confirmingReadbackSeqs).filter((x): x is number => Number.isSafeInteger(x)), reasons: strs(r.reasons) };
}
const short = (v: unknown) => JSON.stringify(v, null, 2)?.slice(0, 12000) ?? 'Unavailable';
export function mapIncident(raw: unknown, org: string): View {
  const r = object(raw), p = object(r.payment);
  if (r.organizationId !== org) throw Error('Unexpected organization response; refusing to display records.');
  if (typeof r.id !== 'string' || !/^inc_[0-9a-f-]{36}$/.test(r.id) || typeof r.class !== 'string' || typeof p.intentId !== 'string' || !Array.isArray(r.evidence) || r.evidence.length > 500 || !Array.isArray(r.affectedOrders) || r.affectedOrders.length > 500) throw Error('Malformed incident response.');
  const opening = evaluation(r.openingEvaluation), latest = evaluation(r.latestEvaluation), warnings: string[] = [];
  const evidence = list(r.evidence).map(object);
  const providerRows = evidence.filter(e => e.evidenceClass === 'PAYPAL_API_READBACK' && object(e.ref).type === 'evidence' && opening.readbacks.includes(Number(object(e.ref).id)));
  const readbackMoney = (e: Obj): string | null => {
    const a=object(object(e.summary).amount);
    const parsed=parseProviderValue(a.value,String(a.currency));
    return parsed ? `${parsed.currency} ${toProviderValue(parsed)}` : null;
  };
  const money=providerRows.map(readbackMoney);
  const valid = providerRows.length > 0 && new Set(providerRows.map(e => Number(object(e.ref).id))).size === new Set(opening.readbacks).size && providerRows.every(e => {
    const s = object(e.summary); return s.httpStatus === 200 && s.captureId === p.captureId && s.orderId === p.paypalOrderId && s.captureStatus === 'COMPLETED' && typeof p.captureId === 'string' && timestamp(e.sourceAt) !== 'Timestamp unavailable' && Date.parse(String(e.sourceAt)) <= Date.parse(opening.at);
  }) && money.every(value=>value!==null&&value===money[0]);
  const latestProvider = providerRows.toSorted((a,b) => Date.parse(String(a.sourceAt)) - Date.parse(String(b.sourceAt))).at(-1);
  const provider: Entity = {
    id: valid ? `evidence:${text(object(latestProvider?.ref).id)}` : 'provider:unavailable', title: valid ? 'Persisted completed capture' : 'Provider evidence unavailable',
    trust: valid ? 'PAYPAL_API_READBACK · recorded, not refreshed' : 'UNVERIFIED', at: valid ? timestamp(latestProvider?.sourceAt) : 'Timestamp unavailable',
    fields: [['Capture', text(p.captureId)], ['Provider order', text(p.paypalOrderId)], ['Amount', valid ? money[0]! : 'Unavailable'], ['Status', valid ? 'COMPLETED' : 'Unverified']],
    limit: 'Persisted readback, not a fresh provider check or webhook. Does not prove fulfillment, a second charge or financial loss.',
  };
  if (!valid) warnings.push('Opening provider evidence is missing or contradictory. Capture is unverified in this view.');
  const orders = list(r.affectedOrders).map(raw => {
    const o = object(raw), a = object(o.amount);
    if (typeof o.id !== 'string' || typeof o.status !== 'string' || typeof o.effectiveStatus !== 'string') throw Error('Malformed merchant record.');
    return { id: o.id, original: o.status, effective: o.effectiveStatus, at: timestamp(o.createdAt), path: text(o.createdByPath), amount: Number.isSafeInteger(a.minor) && Number(a.minor)>=0 && a.currency==='USD' ? `USD ${toProviderValue({currency:'USD',minor:Number(a.minor)})}` : 'Unavailable' };
  });
  if (new Set(orders.map(o=>o.id)).size !== orders.length) throw Error('Duplicate merchant identity in response.');
  const observations: Entity[] = evidence.filter(e => e.evidenceClass === 'MERCHANT_DB_OBSERVED').flatMap(e => {
    const snap = object(object(e.summary).snapshot), ref = object(e.ref);
    if (ref.type !== 'merchant_order' || snap.id !== ref.id || snap.organization_id !== org || snap.intent_id !== p.intentId || snap.capture_id !== p.captureId || snap.paypal_order_id !== p.paypalOrderId || !opening.ids.includes(String(snap.id)) || timestamp(e.sourceAt) === 'Timestamp unavailable' || Date.parse(String(e.sourceAt)) > Date.parse(opening.at)) return [];
    return [{ id: String(snap.id), title: String(snap.id), trust: 'MERCHANT_DB_OBSERVED · opening snapshot', at: timestamp(e.sourceAt), fields: [['Record ID', String(snap.id)], ['Effective status', text(snap.status)], ['Creation path', text(snap.created_by_path)], ['Evidence reference', text(ref.id)]], limit: 'Merchant observation only. Not provider evidence or proof of shipment.' }];
  });
  if (opening.ids.some(id=>!observations.some(o=>o.id===id))) warnings.push('Opening merchant snapshots are incomplete; do not infer historical status from current rows.');
  if (latest.seq && (latest.seq < opening.seq || Date.parse(latest.at) < Date.parse(opening.at))) { warnings.push('Latest evaluation predates detection; ignored.'); Object.assign(latest, unavailable); }
  if (latest.result === 'HOLDS' && (latest.count !== 1 || latest.ids.length !== 1)) { warnings.push('Contradictory latest evaluation; ignored.'); Object.assign(latest, unavailable); }
  const effective = orders.filter(o=>o.effective==='placed').map(o=>o.id);
  if (latest.result==='HOLDS' && (effective.length !== 1 || effective[0] !== latest.ids[0])) warnings.push('Latest evaluation disagrees with current effective merchant rows; snapshots may be stale.');
  const records: Entity[] = evidence.map(e=>({ id: `source:${String(e.seq)}`, title: `${text(e.evidenceClass)} / ${text(object(e.ref).id)}`, trust: text(e.evidenceClass), at: timestamp(e.sourceAt), fields: [['Source type', text(object(e.ref).type)], ['Reference', text(object(e.ref).id)], ['Recorded summary', short(e.summary)]], limit: e.evidenceClass==='PAYPAL_API_READBACK' ? 'Provider readback snapshot only; not independently refreshed by this screen.' : e.evidenceClass==='CONTROLLED_FAULT_INJECTION' ? 'Controlled test metadata, not provider truth or proof of causation.' : 'Local observation or verified event; does not establish a current provider balance or fulfillment.' }));
  const history = object(r.repairHistory);
  const receipt: Entity[] = ['plans', 'approvals', 'executions', 'voids', 'resolutions', 'audit'].flatMap(group => list(history[group]).map((raw,n) => {
    const row = object(raw);
    // Receipt shows stored records, not inferred success from latest evaluation.
    return { id: `${group}:${n}`, title: `${group} / ${text(row.id ?? row.execution_id ?? row.plan_id ?? String(row.seq))}`, trust: 'LOCAL_REPAIR_RECORD · declared identity, not authentication', at: timestamp(row.completed_at ?? row.approved_at ?? row.created_at), fields: Object.entries(row).filter(([key])=>!['facts_json','cause_at_plan'].includes(key)).map(([key,value]):[string,string]=>[key, typeof value==='string' ? value : short(value)]), limit: 'Recorded local reference-merchant action only. Equal before/after hashes establish preservation of the stored provider snapshot, not a new provider readback. Approval identity is unauthenticated. Fulfillment unverified.' };
  }));
  return { id: r.id, org, title: text(r.title), kind: r.class, contract: text(r.contract), state: text(r.state), opened: timestamp(r.openedAt), intent: text(p.intentId), capture: text(p.captureId), provider, opening, latest, orders, observations, evidence: records, warnings, receipt };
}
export function snapshotFor(v: View, moment: Moment): Evaluation { return moment === 'detection' ? v.opening : v.latest; }
/** Match the diagram's solid retained branch and dashed ineffective branch to actual state. */
export function visibleOrderIds(v: View, moment: Moment): string[] {
  return moment==='latest'
    ? v.orders.toSorted((a,b)=>Number(b.effective==='placed')-Number(a.effective==='placed')).map(o=>o.id)
    : [...new Set([...v.opening.ids,...v.observations.map(o=>o.id)])];
}
export function selectEntity(v: View, moment: Moment, id: string): Entity {
  const e = snapshotFor(v,moment);
  if(id==='capture') return v.provider;
  if(id==='contract') return { id: `evaluation:${e.seq}`, title: 'Reference merchant invariant', trust: 'DETERMINISTIC_EVALUATION', at: e.at, fields: [['Contract',v.contract],['Expected effective orders','1'],['Observed effective orders',e.count===null?'Unavailable':String(e.count)],['Result',e.result],['Matching order IDs',e.ids.join(', ') || 'None recorded'],['Reasons',e.reasons.join('; ') || 'Unavailable']], limit: moment==='latest' ? 'Latest recorded check of this intent. Does not automatically resolve this incident. Not a current provider check.' : 'Historical opening evaluation. Establishes the rule finding, not its cause.' };
  if(id.startsWith('order:')) {
    const key=id.slice(6), o=v.orders.find(o=>o.id===key);
    if(moment==='detection') return v.observations.find(o=>o.id===key) ?? { id:key,title:key,trust:'UNVERIFIED',at:e.at,fields:[['Effective status','Unavailable at detection']],limit:'No matching opening snapshot. Current state cannot prove historical state.' };
    if(o) return { id:key,title:key,trust:'MERCHANT_DB_OBSERVED · current API projection',at:o.at,fields:[['Record ID',key],['Original row status',o.original],['Effective status',o.effective],['Creation path',o.path],['Amount',o.amount],['Timestamp meaning','Order created at; effective-status transition time unavailable here']],limit:'Original row and effective status are distinct. Current projection is separate from the latest evaluation; does not prove fulfillment.' };
  }
  return v.evidence.find(e=>e.id===id) ?? {id,title:'Record unavailable',trust:'UNVERIFIED',at:e.at,fields:[],limit:'No record supports this selection.'};
}
export type Source = {mode:'demo'|'local';id?:string;org?:string};
export async function loadIncident(source: Source, fetcher: typeof fetch = fetch): Promise<View> {
  if(source.mode==='demo') return mapIncident(syntheticIncident(),'org_reference');
  if(!source.id || !/^inc_[0-9a-f-]{36}$/.test(source.id) || !source.org || !/^org_[a-z0-9_]{1,40}$/.test(source.org)) throw Error('Local mode requires an incident ID and developer organization scope.');
  const response=await fetcher(`/api/incidents/${encodeURIComponent(source.id)}`,{method:'GET',headers:{'x-ordertruth-org':source.org},cache:'no-store',signal:AbortSignal.timeout(8000)});
  if(!response.ok) throw Error(`Incident API HTTP ${response.status}. Check local service, incident ID and organization scope. Synthetic fallback is disabled.`);
  const body=await response.text(); if(body.length>1000000) throw Error('Incident response exceeds the presentation limit.');
  const view=mapIncident(JSON.parse(body),source.org);
  if(view.id!==source.id)throw Error('Incident identity mismatch in API response.');
  return view;
}
