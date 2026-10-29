import type { Investigation,InvestigationEvidence,DiagnosticKind } from "../../src/ai/investigation.ts";
import { RequestError,requestJson,slowNotice,REQUEST_BUDGET_MS } from "./request.ts";
import { readCase,readSession,parseScenario,validateHistory,type Scenario,type Plan,type Receipt,type Session,type SessionStatus } from "./recovery.ts";
import { describeHandlerTiming,type TimingRow } from "./diagnostics.ts";

type Analysis = { status: "FRESH"|"CACHED"|"UNAVAILABLE"; freshModelExecution: boolean; reason: string|null; generatedAt?: string; model?: string;
  investigation?: Investigation; snapshotSha256?: string; evidence: InvestigationEvidence[]; baseline: { summary: string; nextDiagnostic: DiagnosticKind } };
const root = document.querySelector<HTMLElement>("#app")!;
const state = { session: { authenticated: false } as Session,sessionStatus: "UNKNOWN" as SessionStatus,scenario: null as Scenario|null,analysis: null as Analysis|null,plan: null as Plan|null,receipt: null as Receipt|null,
  approved: false,detected: false,needsRecheck: false,pendingMutationRun: null as string|null,unidentifiedCreation: null as string|null,busy: "",error: "",notice: "",historyNotice: "",role: "operations",ownerForm: false,diagnostics: [] as InvestigationEvidence[] };
const CREATION_MARKER = "ordertruth.judge.unidentifiedCreation";
const MUTATION_MARKER = "ordertruth.judge.pendingMutation";
const CREATION_LIMITATION = "Creation outcome remains uncertain. This UI cannot locate or reconcile that creation without a validated case ID. Existing case reads do not establish rollback; no POST was repeated.";
let historyRevision = 0;
function el<K extends keyof HTMLElementTagNameMap>(tag: K,text = "",className = ""): HTMLElementTagNameMap[K] { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; }
function section(title: string,description: string) { const node = el("section","","panel"); node.append(el("h2",title),el("p",description,"muted")); return node; }
function button(text: string,action: () => Promise<void>|void,secondary = false,mutation = false) {
  const node = el("button",text,secondary ? "button secondary" : "button"); node.type = "button"; node.disabled = !!state.busy || (mutation && (state.needsRecheck || state.sessionStatus !== "AUTHENTICATED"));
  node.addEventListener("click",() => void run(text,action)); return node;
}
async function api<T>(path: string,body?: unknown): Promise<T> {
  const signingIn = path.startsWith("/api/auth/sign-in/");
  if (body !== undefined && ((!signingIn && (state.needsRecheck || state.sessionStatus !== "AUTHENTICATED")) || ["UNKNOWN","CHECKING"].includes(state.sessionStatus))) throw new Error("Resume/Recheck Case before another action. The previous request may have committed.");
  try { return await requestJson<T>(path,body); }
  catch (error) {
    if (body !== undefined) state.needsRecheck = true;
    const run = /^\/api\/scenarios\/([a-zA-Z0-9_-]{1,100})\//.exec(path)?.[1];
    const refused = error instanceof RequestError && error.kind === "HTTP" && error.status >= 400 && error.status < 500;
    if (body !== undefined && run && !refused) markMutation(run);
    if (body !== undefined && run && refused && state.pendingMutationRun === run) markMutation(null);
    if (signingIn || (error instanceof RequestError && error.status === 401)) { state.sessionStatus = "UNKNOWN"; state.needsRecheck = true; }
    throw error;
  }
}
// These run only boot()/resumeCase(), which send GET requests alone. Any other label keeps the write warning.
const READ_ONLY_ACTIONS = new Set(["Loading your session","Resume/Recheck Case","Recheck committed receipt"]);
async function run(label: string,action: () => Promise<void>|void) {
  state.busy = label; state.error = ""; state.notice = ""; render();
  // Update only the status text, so a slow cold start does not re-render the page or move focus.
  const kind = READ_ONLY_ACTIONS.has(label) ? "read" : "write";
  const started = Date.now(); const timer = setInterval(() => {
    const status = root.querySelector<HTMLElement>("p.notice[role=status]"); if (status) status.textContent = `${label}… ${slowNotice(Date.now()-started,kind)}`.trim();
  },1000);
  try { await action(); } catch (error) { state.error = error instanceof Error ? error.message : "Request unavailable. Your committed case is preserved."; }
  finally { clearInterval(timer); state.busy = ""; render(); restoreActionFocus(label); }
}
function restoreActionFocus(label: string) {
  if (label === "Loading your session") return; // Keep the initial skip link first in keyboard order.
  const controls = [...root.querySelectorAll("button")];
  const named = (name: string) => controls.find(b => b.textContent === name && !b.disabled);
  // Actions can remove or rename their trigger. Move to the next meaningful step.
  const next: Record<string,HTMLElement|null|undefined> = {
    "Start judge experience": root.querySelector<HTMLElement>("#case-heading"),
    "Start a new isolated case": root.querySelector<HTMLElement>("#case-heading"),
    "Introduce duplicate": named("Detect anomaly"),
    "Approve this exact merchant-only plan": named("Execute approved local repair"),
    "Execute approved local repair": root.querySelector<HTMLElement>("#receipt-heading"),
    "Owner access": root.querySelector<HTMLElement>("#owner-email") ?? root.querySelector<HTMLElement>("#owner-toggle"),
    "Close owner sign-in": root.querySelector<HTMLElement>("#owner-toggle")
  };
  const target = root.querySelector<HTMLElement>("#action-error") ?? next[label] ?? named(label) ?? root.querySelector<HTMLElement>("#workspace");
  target?.focus();
}
function path(action = "") { return `/api/scenarios/${encodeURIComponent(state.scenario!.run.id)}${action ? `/${action}` : ""}`; }
function savedRun() {
  let saved = new URL(location.href).searchParams.get("run"); try { saved ||= localStorage.getItem("ordertruth.judge.run"); } catch { /* URL is sufficient. */ }
  return saved && /^[a-zA-Z0-9_-]{1,100}$/.test(saved) ? saved : null;
}
async function discoverSession() {
  state.sessionStatus = "CHECKING";
  try {
    state.session = await readSession(api); state.sessionStatus = state.session.authenticated ? "AUTHENTICATED" : "SIGNED_OUT";
    try { state.unidentifiedCreation ||= localStorage.getItem(CREATION_MARKER); } catch { /* In-memory uncertainty still blocks writes. */ }
    try { const pending = localStorage.getItem(MUTATION_MARKER); if (pending && /^[a-zA-Z0-9_-]{1,100}$/.test(pending)) state.pendingMutationRun ||= pending; } catch { /* In-memory uncertainty still blocks writes. */ }
    if (state.unidentifiedCreation || state.pendingMutationRun) state.needsRecheck = true;
  }
  catch (error) { state.sessionStatus = "UNKNOWN"; throw error; }
}
async function restoreCase(runId: string) {
  const restored = await readCase(api,runId).catch(error => { state.needsRecheck = true; throw error; });
  state.scenario = restored.scenario; state.plan = restored.plan; state.receipt = restored.receipt;
  state.approved = restored.plan?.approved ?? false; state.detected = !!restored.plan;
}
async function mutateCase(action: string,body: unknown = {}) {
  if (state.needsRecheck || state.sessionStatus !== "AUTHENTICATED") throw new Error("Resume/Recheck Case before another mutation.");
  const runId = state.scenario!.run.id;
  markMutation(runId); // Survives reload while the POST or subsequent read is interrupted.
  await api(path(action),body);
  state.needsRecheck = true; state.pendingMutationRun = runId;
  await restoreCase(runId);
  markMutation(null); state.needsRecheck = false;
}
async function resumeCase() {
  const restored = await boot();
  if (state.unidentifiedCreation) {
    state.notice = CREATION_LIMITATION;
    return;
  }
  if (!restored) return;
  if (state.pendingMutationRun && state.scenario?.run.id !== state.pendingMutationRun) {
    state.notice = `Recheck the original affected case ${state.pendingMutationRun} before further changes.`; return;
  }
  markMutation(null);
  state.needsRecheck = false;
  state.notice = "Persisted case state rechecked using read-only requests. No approval or repair was replayed.";
}
function restoreHistory(runId: string) {
  const revision = ++historyRevision;
  state.historyNotice = "Loading saved AI history. Case and receipt recovery are independent.";
  void requestJson<Analysis|null>(`/api/scenarios/${encodeURIComponent(runId)}/investigation`,undefined,{ deadlineMs: REQUEST_BUDGET_MS.history }).then(analysis => {
    if (revision !== historyRevision || state.scenario?.run.id !== runId) return;
    validateHistory(analysis);
    state.analysis = analysis; state.diagnostics = analysis?.evidence.filter(e => e.source === "MERCHANT_DIAGNOSTIC") ?? []; state.historyNotice = "";
  }).catch(() => {
    if (revision === historyRevision && state.scenario?.run.id === runId) state.historyNotice = "Saved AI history is unavailable. Your case and receipt can still be rechecked without AI.";
  }).finally(() => { if (revision === historyRevision && state.scenario?.run.id === runId) refreshHistoryPanel(); });
}
function markCreation(userId: string|null) {
  state.unidentifiedCreation = userId;
  try { if (userId) localStorage.setItem(CREATION_MARKER,userId); else localStorage.removeItem(CREATION_MARKER); } catch { /* Never infer rollback from unavailable browser storage. */ }
}
function markMutation(runId: string|null) {
  state.pendingMutationRun = runId;
  try { if (runId) localStorage.setItem(MUTATION_MARKER,runId); else localStorage.removeItem(MUTATION_MARKER); } catch { /* Never clear the in-memory obligation because storage failed. */ }
}
async function createCase() {
  // A click is never evidence that a previous sign-in failed. Discover first.
  await discoverSession();
  if (state.needsRecheck) throw new Error("Resume/Recheck Case before creating another case. The previous outcome has not been reconciled.");
  if (!state.session.authenticated) {
    await api("/api/auth/sign-in/anonymous",{}); await discoverSession();
    if (!state.session.authenticated) throw new Error("Session could not be confirmed. Resume/Recheck Case before trying again.");
  }
  let scenario: Scenario;
  markCreation(state.session.userId!);
  try { scenario = parseScenario(await api<unknown>("/api/scenarios",{})); }
  catch (error) {
    state.needsRecheck = true;
    if (error instanceof RequestError && error.kind === "HTTP" && error.status >= 400 && error.status < 500) { markCreation(null); throw error; }
    throw new Error("Case creation outcome is uncertain: no complete validated case was received. This UI cannot locate it without a validated case ID. Further writes are blocked; no creation POST will be repeated automatically.");
  }
  markCreation(null);
  state.scenario = scenario; state.analysis = null; state.plan = null; state.approved = false; state.receipt = null; state.detected = false; state.diagnostics = [];
  historyRevision++; state.historyNotice = "";
  const url = new URL(location.href); url.searchParams.set("run",scenario.run.id); history.replaceState(null,"",url);
  try { localStorage.setItem("ordertruth.judge.run",scenario.run.id); } catch { /* URL still preserves case identity. */ }
}
async function diagnostic(kind: DiagnosticKind) {
  const evidence = await api<InvestigationEvidence>(path("diagnostics"),{ kind });
  state.diagnostics = [...state.diagnostics.filter(e => e.id !== evidence.id),evidence];
}
function record(title: string,value: string) { const row = el("div","","record"); row.append(el("span",title,"muted"),el("strong",value)); return row; }
function json(title: string,data: unknown) { const detail = el("details"); detail.append(el("summary",title),el("pre",JSON.stringify(data,null,2))); return detail; }
function render() {
  root.replaceChildren();
  const header = el("header"); const brand = el("a","OrderTruth","brand"); brand.href = "/";
  const identity = el("span",state.sessionStatus === "AUTHENTICATED" ? (state.session.owner ? "Owner session" : "Private judge session") : state.sessionStatus === "SIGNED_OUT" ? "Signed out" : "Session access not yet confirmed","muted");
  const ownerToggle = button(state.ownerForm ? "Close owner sign-in" : "Owner access",() => { state.ownerForm = !state.ownerForm; },true);
  ownerToggle.id = "owner-toggle"; ownerToggle.setAttribute("aria-expanded",String(state.ownerForm));
  header.append(brand,identity,ownerToggle); root.append(header);
  const main = el("main"); main.id = "workspace"; main.tabIndex = -1;
  const intro = el("div","","intro"); intro.append(el("p","Investigate merchant outcomes. Verify recovery.","kicker"),el("h1",state.scenario ? "Follow the evidence to recovery." : "A payment can succeed. Its order can still be wrong."),
    el("p","Explore a controlled merchant anomaly against an original PayPal Sandbox observation. Investigate, approve a merchant-only repair, and independently check the result.","lead"));
  main.append(intro);
  if (state.ownerForm) main.append(ownerForm());
  if (state.busy) { const progress = el("p",`${state.busy}…`,"notice"); progress.setAttribute("role","status"); progress.setAttribute("aria-live","polite"); main.append(progress); }
  if (state.error) { const error = el("p",state.error,"error"); error.id = "action-error"; error.tabIndex = -1; error.setAttribute("role","alert"); main.append(error); }
  else if (state.notice && !state.busy) { const notice = el("p",state.notice,"notice"); notice.setAttribute("role","status"); main.append(notice); }
  const toolbar = el("div","","toolbar");
  for (const role of ["operations","engineering"]) {
    const tab = button(role === "operations" ? "Operations" : "Engineering",() => { state.role = role; },true); tab.setAttribute("aria-pressed",String(state.role === role)); toolbar.append(tab);
  }
  const start = button(state.scenario || savedRun() ? "Start a new isolated case" : "Start judge experience",createCase);
  start.disabled = !!state.busy || ["UNKNOWN","CHECKING"].includes(state.sessionStatus) || state.needsRecheck;
  toolbar.append(button("Resume/Recheck Case",resumeCase,true),start); main.append(toolbar);
  if (state.needsRecheck) main.append(el("p","The last request may have committed. Resume/Recheck Case before any further changes; a timeout does not mean rollback.","notice"));
  if (!state.scenario) {
    const welcome = section("Your own investigation, from evidence to receipt","Starting creates a private session and an isolated merchant run. An owner-approved genuine Sandbox observation must be available first.");
    const steps = el("ol","","welcome-steps");
    for (const text of ["Introduce a controlled duplicate merchant order.","Detect the mismatch and investigate with grounded AI.","Run a read-only diagnostic to test an explanation.","Approve the exact local repair and verify its durable receipt."]) steps.append(el("li",text));
    welcome.append(steps,el("p","No judge action captures, refunds, or changes PayPal financial records. Reset creates a new case and preserves the old one.","muted")); main.append(welcome);
  } else main.append(caseView());
  root.append(main);
  const footer = el("footer","Independent OrderTruth prototype. PayPal Sandbox observations and controlled merchant state are labelled separately. Not affiliated with or endorsed by PayPal."); root.append(footer);
}
function caseView() {
  const scenario = state.scenario!; const container = el("div");
  const provenance = el("aside","","provenance");
  provenance.append(el("strong",scenario.paymentReference.provenance === "PAYPAL_SANDBOX_GET" ? "Original PayPal Sandbox observation" : "Synthetic qualification observation"),
    el("span",`Observed ${new Date(scenario.paymentReference.observedAt).toLocaleString()} · Evidence E${scenario.paymentReference.evidenceSeq}`),el("p",scenario.paymentReference.note)); container.append(provenance);
  const flow = el("ol","","flow");
  const stages: Array<[string,boolean]> = [["Observe",true],["Detect",state.detected],["Investigate",!!state.analysis?.investigation],["Approve",state.approved],["Verify",!!state.receipt?.verifiedCurrent]];
  for (const [label,done] of stages) flow.append(el("li",label,done ? "done" : "")); container.append(flow);
  const grid = el("div","","case-grid");
  const merchant = section("Controlled merchant state","Each order below belongs to this run. The payment observation is shared by reference.");
  const caseHeading = merchant.querySelector("h2")!; caseHeading.id = "case-heading"; caseHeading.tabIndex = -1;
  const active = scenario.orders.filter(o => o.effective_status === "placed");
  merchant.append(record("Active merchant orders",String(active.length)),record("Case",scenario.run.id));
  if (state.detected) { const verdict = el("p",state.receipt?.verifiedCurrent ? "Verified recovery: one active merchant order." : active.length > 1 ? "Duplicate merchant orders detected." : "Recheck the current merchant outcome.","result-label"); verdict.setAttribute("role","status"); merchant.append(verdict); }
  for (const order of scenario.orders) merchant.append(record(order.id,order.effective_status === "placed" ? "Active" : "Voided duplicate"));
  const actions = el("div","","actions");
  if (scenario.orders.length === 1) actions.append(button("Introduce duplicate",() => mutateCase("duplicate"),false,true));
  if (!state.receipt?.verifiedCurrent) actions.append(button("Detect anomaly",async () => { const checked = await api<{ result: string }>(path("check"),{}); state.detected = checked.result === "VIOLATED"; if (!state.detected) state.error = "The current order state does not contain an actionable duplicate."; },true,true));
  else actions.append(el("p","This case is recovered. Start a new isolated case to explore again; this receipt is preserved.","muted"));
  merchant.append(actions); grid.append(merchant);
  grid.append(investigationView());

  const recovery = section("Approve, repair, verify","The plan preserves one merchant order and appends a local void for each duplicate. PayPal records remain unchanged.");
  const completed = state.receipt?.verifiedCurrent === true && state.receipt.receipt.outcome === "SUCCEEDED";
  if (!completed && (!state.approved || (state.receipt && !state.receipt.verifiedCurrent))) recovery.append(button("Review exact repair plan",() => mutateCase("plan"),false,true));
  if (state.plan) {
    const plan = state.plan;
    recovery.append(record("Keep",plan.keep_order_id),record("Void locally",(JSON.parse(plan.void_order_ids_json) as string[]).join(", ")),record("Exact plan hash",plan.plan_sha256),el("p",`Approval expires ${new Date(plan.expires_at).toLocaleTimeString()}`,"muted"));
    if (!completed) {
      recovery.append(button(state.approved ? "Exact plan approved" : "Approve this exact merchant-only plan",() => mutateCase("approve",{ planId: plan.id,planSha256: plan.plan_sha256 }),false,true));
      if (state.approved) recovery.append(button("Execute approved local repair",() => mutateCase("execute",{ planId: plan.id }),false,true));
    }
  }
  if (state.receipt) {
    const receipt = state.receipt;
    const heading = el("h3",receipt.verifiedCurrent ? "Recovery independently verified" : "Outcome needs review"); heading.id = "receipt-heading"; heading.tabIndex = -1;
    recovery.append(heading,record("Terminal outcome",receipt.receipt.outcome),record("Active orders",String(receipt.current.activeOrders)),record("Expected surviving order",String(receipt.current.matchingKeeper)),record("Provider evidence unchanged",receipt.current.providerUnchanged ? "Verified" : "Not established"));
    recovery.append(button("Recheck committed receipt",resumeCase,true),button("Export receipt and evidence",() => {
      const blob = new Blob([JSON.stringify({ scenario,receipt: state.receipt,investigation: state.analysis,diagnostics: state.diagnostics },null,2)],{ type: "application/json" });
      const url = URL.createObjectURL(blob); const link = el("a"); link.href = url; link.download = `ordertruth-${scenario.run.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
    },true));
  }
  grid.append(recovery); container.append(grid); return container;
}
function investigationView() {
  const investigation = section("Evidence-grounded investigation","AI proposes hypotheses. Read-only diagnostics supply new evidence; the model cannot execute repairs.");
  investigation.id = "investigation-panel";
  const notice = el("p",state.historyNotice,"muted"); notice.id = "saved-history-status"; notice.setAttribute("role","status"); investigation.append(notice);
  investigation.append(button("Investigate with AI",async () => { historyRevision++; state.historyNotice = ""; state.analysis = await api<Analysis>(path("investigate"),{}); },false,true));
  const analysis = state.analysis;
  if (analysis) {
    investigation.append(el("p",analysis.status === "FRESH" ? "Fresh AI inference" : analysis.status === "CACHED" ? "Cached AI result — no new model execution" : "AI unavailable — rules-based guidance","result-label"));
    if (analysis.generatedAt) investigation.append(el("p",`${analysis.model ?? "Model"} · Generated ${new Date(analysis.generatedAt).toLocaleString()}`,"muted"));
    if (analysis.investigation) {
      investigation.append(el("p",analysis.investigation.summary));
      for (const hypothesis of analysis.investigation.hypotheses) { const article = el("article","","hypothesis"); article.append(el("strong",`Hypothesis · ${hypothesis.confidence.toLowerCase()} confidence`),el("p",hypothesis.explanation),el("p",`Evidence: ${hypothesis.evidenceIds.join(", ")}`,"evidence-ids")); investigation.append(article); }
      investigation.append(el("p",analysis.investigation.diagnosticReason));
    } else investigation.append(el("p",`Availability: ${analysis.reason ?? "Provider unavailable"}. ${analysis.baseline.summary}`));
    const next = analysis.investigation?.nextDiagnostic ?? analysis.baseline.nextDiagnostic;
    investigation.append(button(`Run ${diagnosticName(next)}`,() => diagnostic(next),true,true));
    investigation.append(json("Evidence snapshot used for this investigation",analysis.evidence));
    if (state.receipt) investigation.append(el("p","This investigation describes its recorded snapshot before recovery. The receipt independently checks the current merchant outcome.","muted"));
  }
  for (const evidence of state.diagnostics) {
    const facts = evidence.facts;
    if (facts.diagnostic === "HANDLER_TIMING") investigation.append(timingView(evidence));
    else investigation.append(el("p",facts.diagnostic === "IDEMPOTENCY_KEYS" ? `${String(facts.distinctKeys)} distinct merchant write keys observed. Separate keys can allow duplicate writes.`
      : `${String(facts.committedWrites)} committed controlled merchant writes observed.`));
    investigation.append(json(`${String(facts.diagnostic)} · ${evidence.id}`,evidence));
  }
  if (state.role === "engineering") for (const kind of ["HANDLER_TIMING","IDEMPOTENCY_KEYS","MERCHANT_WRITE_OUTCOMES"] as const) investigation.append(button(diagnosticName(kind),() => diagnostic(kind),true,true));
  return investigation;
}
function refreshHistoryPanel() {
  const panel = root.querySelector<HTMLElement>("#investigation-panel");
  if (!panel) return;
  if (document.activeElement && panel.contains(document.activeElement)) {
    const notice = panel.querySelector<HTMLElement>("#saved-history-status");
    if (notice) notice.textContent = state.historyNotice || "Saved-history check completed; available results will appear on the next case-view update.";
    return;
  }
  panel.replaceWith(investigationView());
}
// Recorded intervals as a table; the summary lines come only from describeHandlerTiming.
function timingView(evidence: InvestigationEvidence) {
  const timing = describeHandlerTiming(evidence.facts,state.scenario?.run.label === "CONTROLLED_MERCHANT_SCENARIO");
  const view = el("div","","timing");
  view.append(el("strong","Handler timing check"),el("p",`Evidence ${evidence.id} · recorded ${new Date(evidence.observedAt).toLocaleString()}`,"muted"));
  if (timing.rows.length) {
    // One column per write keeps the table inside the narrow investigation panel.
    const wrap = el("div","","table-scroll"),table = el("table"),thead = el("thead"),head = el("tr"),body = el("tbody");
    head.append(el("td"));
    timing.rows.forEach((_,index) => { const th = el("th",`Write ${index+1}`); th.setAttribute("scope","col"); head.append(th); });
    const fields: Array<[string,(row: TimingRow) => HTMLTableCellElement]> = [
      ["Order",row => cell(row.orderId.length > 14 ? `${row.orderId.slice(0,11)}…` : row.orderId,row.orderId)],["Written by",row => cell(row.handler)],
      ["Started",row => cell(clock(row.startedAt),row.startedAt)],["Finished",row => cell(clock(row.finishedAt),row.finishedAt)],["Took",row => cell(`${row.durationMs} ms`)]];
    for (const [label,value] of fields) {
      const tr = el("tr"),th = el("th",label); th.setAttribute("scope","row");
      tr.append(th,...timing.rows.map(value)); body.append(tr);
    }
    thead.append(head); table.append(el("caption","When each recorded merchant write ran"),thead,body); wrap.append(table); view.append(wrap);
  }
  const observations = el("div","","timing-observations"),limitations = el("div","","timing-limitations");
  for (const line of timing.observations) observations.append(el("p",line));
  for (const line of timing.limitations) limitations.append(el("p",line));
  view.append(observations,limitations);
  return view;
}
function cell(text: string,title = "") { const node = el("td",text); if (title) node.setAttribute("title",title); return node; }
function clock(iso: string) { return new Date(iso).toLocaleTimeString(undefined,{ hour: "2-digit",minute: "2-digit",second: "2-digit",fractionalSecondDigits: 3 }); }
function diagnosticName(kind: DiagnosticKind) { return ({ HANDLER_TIMING: "handler timing check",IDEMPOTENCY_KEYS: "idempotency-key comparison",MERCHANT_WRITE_OUTCOMES: "merchant write-outcome check" })[kind]; }
function ownerForm() {
  const sectionNode = section("Owner access","Owner sign-in enables genuine Sandbox checkout. Judges need no payment permissions.");
  if (state.session.owner) { const link = el("a","Open owner Sandbox checkout","button"); link.href = "/owner/"; sectionNode.append(link); return sectionNode; }
  const form = el("form"); const email = el("input"); email.type = "email"; email.autocomplete = "username"; email.required = true; email.id = "owner-email";
  const password = el("input"); password.type = "password"; password.autocomplete = "current-password"; password.required = true; password.id = "owner-password";
  const emailLabel = el("label","Owner account"); emailLabel.htmlFor = email.id; const passwordLabel = el("label","Password"); passwordLabel.htmlFor = password.id;
  const submit = el("button","Sign in","button"); submit.type = "submit"; submit.disabled = !!state.busy || (state.needsRecheck && state.sessionStatus !== "SIGNED_OUT") || ["UNKNOWN","CHECKING"].includes(state.sessionStatus);
  form.append(emailLabel,email,passwordLabel,password,submit);
  form.addEventListener("submit",event => { event.preventDefault(); const credentials = { email: email.value,password: password.value }; password.value = "";
    void run("Signing in",async () => { await discoverSession(); await api("/api/auth/sign-in/email",credentials); await discoverSession(); state.scenario = null; }); });
  sectionNode.append(form); return sectionNode;
}
async function boot() {
  await discoverSession();
  const saved = savedRun();
  if (!state.session.authenticated) {
    if (!state.pendingMutationRun && !state.unidentifiedCreation) state.needsRecheck = false;
    state.notice = state.unidentifiedCreation ? CREATION_LIMITATION : state.pendingMutationRun ? "This session is signed out or expired. The affected run link is preserved; its uncertain mutation must be reconciled before another case can be started." : saved ? "This session is signed out or expired. The run link and committed records are preserved. A new anonymous session cannot take ownership; start a new isolated case only if you choose to." : "Session discovery confirmed you are signed out. Start judge experience to create a private session.";
    return false;
  }
  if (saved) {
    try { await restoreCase(saved); } catch (error) {
      if (!(error instanceof RequestError) || ![400,404].includes(error.status)) throw error;
      state.scenario = null; state.plan = null; state.receipt = null; state.approved = false;
      state.notice = "This case cannot be opened with the current session. The run link is preserved; no ownership or approval was transferred.";
      state.needsRecheck = !!state.pendingMutationRun || !!state.unidentifiedCreation; return false;
    }
    restoreHistory(saved);
  }
  if (state.unidentifiedCreation) state.notice = CREATION_LIMITATION;
  return true;
}
void run("Loading your session",async () => { await boot(); });
