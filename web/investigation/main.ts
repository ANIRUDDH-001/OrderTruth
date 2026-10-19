import { loadIncident, selectEntity, snapshotFor, visibleOrderIds, type View, type Moment, type Entity, type Source } from './model.ts';

const $ = (id: string) => document.getElementById(id)!;
const set = (id: string, value: string) => { $(id).textContent = value; };
function el<K extends keyof HTMLElementTagNameMap>(tag: K, value = '', cls = '') { const e=document.createElement(tag); e.textContent=value; if(cls)e.className=cls; return e; }
function fields(target: HTMLElement, pairs: [string,string][]) { target.replaceChildren(); for(const [key,value] of pairs) target.append(el('dt',key),el('dd',value)); }
function details(target: HTMLElement, entity: Entity) {
  const dl=el('dl'); fields(dl,[['Source / trust',entity.trust],['Recorded at (UTC)',entity.at],...entity.fields]);
  target.replaceChildren(el('h3',entity.title),dl,el('p',entity.limit,'boundary'));
}
let view:View, moment:Moment='detection', selected='capture', hypothesis='race';
const dialog=$('dialog') as HTMLDialogElement;
let trigger:HTMLElement|null=null;
function open(title:string, content:HTMLElement, origin:HTMLElement) { trigger=origin; set('dialog-title',title); $('dialog-body').replaceChildren(content); dialog.showModal(); }
$('close-dialog').onclick=()=>dialog.close();
dialog.addEventListener('close',()=>trigger?.focus());
function inspect(id:string, origin?:HTMLElement) {
  selected=id; const entity=selectEntity(view,moment,id);
  set('inspect-id',entity.id);set('inspect-title',entity.title);set('inspect-trust',entity.trust);fields($('inspect-fields'),[['Recorded at (UTC)',entity.at],...entity.fields]);set('inspect-limit',entity.limit);
  details($('sourcedetail'),entity);
  document.querySelectorAll<HTMLElement>('[data-entity]').forEach(b=>{const on=b.dataset.entity===id;b.classList.toggle('selected',on);b.setAttribute('aria-pressed',String(on));});
  document.querySelectorAll<HTMLElement>('[data-evidence]').forEach(b=>{const on=b.dataset.evidence===id;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});
  if(origin && matchMedia('(max-width:700px)').matches) {const content=el('div'); details(content,entity);open(entity.title,content,origin);}
}
function bindEntities(root:ParentNode=document) {root.querySelectorAll<HTMLButtonElement>('[data-entity]').forEach(b=>b.onclick=()=>inspect(b.dataset.entity!,b));}
function renderMoment() {
  const e=snapshotFor(view,moment), latest=moment==='latest';
  // Keep geometry, node state and rule result synchronized. HOLDS styling requires a matching current projection.
  const consistent=e.result==='HOLDS' && e.count===1 && !view.warnings.some(w=>w.includes('disagrees'));
  $('canvas').classList.toggle('latest',latest&&consistent);
  document.querySelectorAll<HTMLElement>('[data-state]').forEach(b=>{const on=b.dataset.state===moment;b.classList.toggle('on',on);b.setAttribute('aria-pressed',String(on));});
  set('contract-title',`1 expected. ${e.count===null?'?':e.count} observed.`);set('contract-result',`${e.result==='HOLDS'?'1:1':e.count===null?'?':`1:${e.count}`} ${e.result}`);
  set('state-caption',`${latest?'Latest recorded intent check':'Historical detection'} · ${e.at} · ${e.count??'Unknown'} effective orders`);
  $('graph-orders').replaceChildren();
  const ids=visibleOrderIds(view,moment);
  $('graph').classList.toggle('many-orders',ids.length>2);
  $('graph').classList.toggle('no-orders',ids.length===0);
  for(const [n,id] of ids.entries()) {
    const entity=selectEntity(view,moment,`order:${id}`), status=entity.fields.find(([k])=>k==='Effective status')?.[1]??'Unavailable';
    const b=el('button','','node order '+(n===0?'keeper':'duplicate'));b.dataset.entity=`order:${id}`;b.setAttribute('aria-label',`Inspect merchant order ${id}`);
    b.append(el('span',status==='voided_duplicate'?'Voided locally · row retained':status==='placed'?'Effective local order':status,'nodelabel'),el('strong',id),el('span',latest?'Current merchant projection':'Opening merchant snapshot','nodefoot'));
    b.classList.toggle('voided',status==='voided_duplicate'); $('graph-orders').append(b);
  }
  if(!ids.length) $('graph-orders').append(el('p','No supported merchant-order records in this snapshot.','empty-orders'));
  bindEntities($('graph-orders')); inspect(selected);
}
function renderHypothesis() {
  const race=hypothesis==='race';
  document.querySelectorAll<HTMLElement>('[data-hyp]').forEach(b=>{const on=b.dataset.hyp===hypothesis;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});
  const supports=view.evidence.filter(e=>race?e.trust==='MERCHANT_DB_OBSERVED'||e.trust==='CONTROLLED_FAULT_INJECTION':e.trust==='PAYPAL_VERIFIED_WEBHOOK');
  fields($('hypbody'),[['Status','HYPOTHESIS · not established'],['Supporting context',supports.map(e=>e.id).join(', ')||'No supporting source available'],['What it supports',race?'Separate local order effects; not overlapping transactions.':'Event handling context; not repeated application.'],['Missing proof',race?'Worker transaction overlap and uniqueness outcomes.':'Verified event identity, delivery attempts and application dedup outcomes.']]);
  set('test-description',race?'Read transaction timestamps and logical checkout keys for the two merchant records. Do not replay or create orders.':'Read verified delivery and dedup lineage. Compare event identity with local effects; do not redeliver events.');
}
function receiptContent() {
  const body=el('div');body.append(el('p','Append-only local recovery history. Records are displayed as stored; this screen has not executed or approved anything.'));
  if(!view.receipt.length) body.append(el('p','Recovery receipt unavailable. No recorded repair history supports a correction claim.'));
  for(const entity of view.receipt) {const section=el('section','','receipt-record');details(section,entity);body.append(section);}
  body.append(el('p','Postcondition evidence: inspect the incident-specific resolution record and its linked evaluation when present. The latest intent check is separate; a latest HOLDS check alone is not proof of this incident’s resolution. Missing references remain unverified.'));
  return body;
}
function render(v:View, source:Source) {
  view=v;set('incident-id',v.id);set('incident-state',`Incident: ${v.state}`);
  set('case-title',v.kind==='DUPLICATE_MERCHANT_ORDER'&&v.opening.count===2?'One payment. Two merchant orders.':v.title);
  set('case-summary','Inspect the historical finding, the latest recorded check and the evidence behind each.');
  set('latest-condition',`Latest recorded: ${v.latest.result}`);set('latest-time',v.latest.at);
  set('current-condition',`${v.latest.count??'Unknown'} effective order(s) in latest check`);
  set('warnings',v.warnings.join(' '));$('warnings').hidden=!v.warnings.length;
  set('capture-amount',v.provider.fields.find(([k])=>k==='Amount')?.[1]??'Unavailable');
  set('capture-status',v.provider.title);set('footer-source',source.mode==='demo'?'SYNTHETIC DEMO · illustrative records only':`LOCAL INCIDENT API · ${v.org} · NOT authentication`);
  const list=$('evidence-list');list.replaceChildren();
  const records=[{...selectEntity(v,'detection','contract'),id:'contract'},...v.evidence];
  for(const r of records){const b=el('button');b.dataset.evidence=r.id;b.append(el('time',r.at.replace('T',' ').replace('Z',' UTC')),el('strong',r.title));b.onclick=()=>inspect(r.id,b);list.append(b);}
  set('receipt-count',`${v.receipt.length} stored recovery record(s)`);
  const summary=$('receipt-summary');summary.replaceChildren();
  for(const [title,copy] of [['Incident state',v.state],['Local recovery history',v.receipt.length?`${v.receipt.length} records available for inspection`:'Unavailable · no repair history'],['Independent boundary','No fulfillment proof or fresh provider readback']]){const block=el('div');block.append(el('h3',title),el('p',copy));summary.append(block);}
  $('receipt-open').onclick=()=>open('Recovery receipt',receiptContent(),$('receipt-open'));
  $('outstanding').onclick=()=>{const body=el('div');body.append(el('p','Safe read-only next check: inspect existing fulfillment records for the retained and locally voided order IDs. No fulfillment service is connected; shipment and cancellation remain unverified.'));open('Outstanding fulfillment check',body,$('outstanding'));};
  $('diagnostic').onclick=()=>{const body=el('div');body.append(el('p',$('test-description').textContent!),el('p','This is a read-only investigation specification. It does not execute a checker, replay, provider request or repair.'));open('Read-only diagnostic specification',body,$('diagnostic'));};
  $('source-link').onclick=event=>{event.preventDefault();const body=el('div');details(body,selectEntity(view,moment,selected));open('Source record',body,$('source-link'));};
  document.querySelectorAll<HTMLElement>('[data-state]').forEach(b=>b.onclick=()=>{moment=b.dataset.state as Moment;renderMoment();});
  document.querySelectorAll<HTMLElement>('[data-hyp]').forEach(b=>b.onclick=()=>{hypothesis=b.dataset.hyp!;renderHypothesis();});
  bindEntities();renderMoment();renderHypothesis();$('workspace').hidden=false;$('load-status').hidden=true;
}
const params=new URLSearchParams(location.search), mode=params.get('mode');
const pathId=location.pathname.split('/').filter(Boolean)[1];
const id=pathId??params.get('incident')??undefined, org=params.get('org')??undefined;
$('local-form').onsubmit=event=>{event.preventDefault();const data=new FormData(event.currentTarget as HTMLFormElement);location.href=`/investigation/${encodeURIComponent(String(data.get('incident')))}/?mode=local&org=${encodeURIComponent(String(data.get('org')))}`;};
if(mode!=='demo'&&mode!=='local') {$('source-choice').hidden=false;$('load-status').hidden=true;}
else {
  const source:Source=mode==='demo'?{mode:'demo'}:{mode:'local',...(id?{id}:{}),...(org?{org}:{})};
  set('mode-label',mode==='demo'?'SYNTHETIC DEMO · deterministic illustrative records · no provider or database':'LOCAL INCIDENT API · read-only · developer organization scope is NOT authentication');
  try {render(await loadIncident(source),source);} catch(error) {set('load-status',error instanceof Error?error.message:'Investigation unavailable.');$('load-status').setAttribute('role','alert');$('load-status').append(el('p','Check your local source configuration or choose a different incident.'),Object.assign(el('a','Change data source'),{href:'/investigation/'}));}
}
