import type { InvestigationEvidence,DiagnosticKind } from "../../src/ai/investigation.ts";
import { RequestError,requestJson,slowNotice,REQUEST_BUDGET_MS } from "./request.ts";
import { readCase,readSession,parseCreation,parsePendingCreation,parseOperation,detectedFromCase,validateHistory,parseDiagnostic,planExpired,aiAvailability,type PendingCreation,type Analysis,type Scenario,type Plan,type Receipt,type Session,type SessionStatus } from "./recovery.ts";
import { describeHandlerTiming,type TimingRow } from "./diagnostics.ts";

const root = document.querySelector<HTMLElement>("#app")!;
const state = { session: { authenticated: false } as Session,sessionStatus: "UNKNOWN" as SessionStatus,scenario: null as Scenario|null,analysis: null as Analysis|null,plan: null as Plan|null,receipt: null as Receipt|null,
  approved: false,detected: false,needsRecheck: false,pendingMutationRun: null as string|null,unidentifiedCreation: null as string|null,creationOperation: null as PendingCreation|null,busy: "",error: "",notice: "",historyNotice: "",role: "operations",ownerForm: false,diagnostics: [] as InvestigationEvidence[] };
const CREATION_MARKER = "ordertruth.judge.unidentifiedCreation";
const MUTATION_MARKER = "ordertruth.judge.pendingMutation";
const CREATION_LIMITATION = "Creation outcome remains uncertain. This UI cannot locate or reconcile that creation without a validated case ID. Existing case reads do not establish rollback; no POST was repeated.";
let historyRevision = 0;
let planExpiryTimer: ReturnType<typeof setTimeout>|undefined;
function el<K extends keyof HTMLElementTagNameMap>(tag: K,text = "",className = ""): HTMLElementTagNameMap[K] { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; }
function section(title: string,description: string) { const node = el("section","","panel"); node.append(el("h2",title),el("p",description,"muted")); return node; }
function button(text: string,action: () => Promise<void>|void,secondary = false,mutation = false) {
  const node = el("button",text,secondary ? "button secondary" : "button"); node.type = "button"; node.disabled = !!state.busy || (mutation && (state.needsRecheck || state.sessionStatus !== "AUTHENTICATED"));
  node.addEventListener("click",() => { if (!state.busy && !node.disabled && node.getAttribute("aria-disabled") !== "true") void run(text,action); }); return node;
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
    if (signingIn || (error instanceof RequestError && error.status === 401)) { state.sessionStatus = "UNKNOWN"; state.needsRecheck = true; clearCase(); }
    throw error;
  }
}
// These run only boot()/resumeCase(), which send GET requests alone. Any other label keeps the write warning.
const READ_ONLY_ACTIONS = new Set(["Loading your session","Resume/Recheck Case","Recheck committed receipt"]);
async function run(label: string,action: () => Promise<void>|void) {
  if (state.busy) return;
  state.busy = label; state.error = ""; state.notice = "";
  // Keep the trigger and any typed form values mounted while waiting.
  if (!root.querySelector("#workspace")) render();
  const workspace = root.querySelector<HTMLElement>("#workspace"); workspace?.setAttribute("aria-busy","true");
  for (const control of root.querySelectorAll("button")) control.setAttribute("aria-disabled","true");
  const progress = root.querySelector<HTMLElement>("#request-status"); if (progress) { progress.hidden = false; progress.textContent = `${label}…`; }
  const kind = READ_ONLY_ACTIONS.has(label) ? "read" : "write";
  const started = Date.now(); const timer = setInterval(() => {
    // Announce bounded milestones, rather than speaking every elapsed second.
    const elapsed = Date.now()-started;
    if (elapsed === 2000 || elapsed % 15000 === 0) { const status = root.querySelector<HTMLElement>("#request-status"); if (status) status.textContent = `${label}… ${slowNotice(elapsed,kind)}`.trim(); }
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
    "Inspect a payment outcome": root.querySelector<HTMLElement>("#case-heading"),
    "Start a new isolated case": root.querySelector<HTMLElement>("#case-heading"),
    "Introduce duplicate": named("Detect anomaly"),
    "Detect anomaly": named("Review exact repair plan"),
    "Review exact repair plan": root.querySelector<HTMLElement>("#review-heading"),
    "Renew expired plan": root.querySelector<HTMLElement>("#review-heading"),
    "Approve this exact merchant-only plan": named("Execute approved local repair"),
    "Execute approved local repair": root.querySelector<HTMLElement>("#receipt-heading"),
    "Owner access": root.querySelector<HTMLElement>("#owner-email") ?? root.querySelector<HTMLElement>("#owner-toggle"),
    "Close owner sign-in": root.querySelector<HTMLElement>("#owner-toggle")
  };
  const diagnosticTarget = ["HANDLER_TIMING","IDEMPOTENCY_KEYS","MERCHANT_WRITE_OUTCOMES"].some(kind => diagnosticName(kind as DiagnosticKind) === label || `Run ${diagnosticName(kind as DiagnosticKind)}` === label)
    ? root.querySelector<HTMLElement>("#investigation-heading") : null;
  const target = root.querySelector<HTMLElement>("#action-error") ?? diagnosticTarget ?? next[label] ?? named(label) ?? root.querySelector<HTMLElement>("#workspace");
  target?.focus();
}
function path(action = "") { return `/api/scenarios/${encodeURIComponent(state.scenario!.run.id)}${action ? `/${action}` : ""}`; }
function savedRun() {
  if (new URL(location.href).searchParams.get("view") === "overview") return null;
  let saved = new URL(location.href).searchParams.get("run"); try { saved ||= localStorage.getItem("ordertruth.judge.run"); } catch { /* URL is sufficient. */ }
  return saved && /^[a-zA-Z0-9_-]{1,100}$/.test(saved) ? saved : null;
}
function recentRuns(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem("ordertruth.judge.recent") ?? "null");
    if (!saved || typeof saved !== "object") return [];
    const record = saved as { userId?: unknown; runs?: unknown };
    return record.userId === state.session.userId && Array.isArray(record.runs) ? record.runs.filter((id): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id)).slice(0,5) : [];
  } catch { return []; }
}
function rememberRun(id: string) {
  try { localStorage.setItem("ordertruth.judge.recent",JSON.stringify({ userId: state.session.userId,runs: [id,...recentRuns().filter(run => run !== id)].slice(0,5) })); } catch { /* Case URL is the durable fallback when local storage is unavailable. */ }
}
async function discoverSession() {
  state.sessionStatus = "CHECKING";
  try {
    const session = await readSession(api);
    if (state.session.userId !== session.userId || state.session.authenticated !== session.authenticated) clearCase();
    state.session = session; state.sessionStatus = state.session.authenticated ? "AUTHENTICATED" : "SIGNED_OUT";
    try { const saved = localStorage.getItem(CREATION_MARKER); if (saved && !state.unidentifiedCreation) { state.creationOperation = parsePendingCreation(saved); state.unidentifiedCreation = state.creationOperation?.userId ?? saved; } } catch { /* In-memory uncertainty still blocks writes. */ }
    try { const pending = localStorage.getItem(MUTATION_MARKER); if (pending && /^[a-zA-Z0-9_-]{1,100}$/.test(pending)) state.pendingMutationRun ||= pending; } catch { /* In-memory uncertainty still blocks writes. */ }
    if (state.unidentifiedCreation || state.pendingMutationRun) state.needsRecheck = true;
  }
  catch (error) { state.sessionStatus = "UNKNOWN"; clearCase(); throw error; }
}
function clearAdvisory() { historyRevision++; state.analysis = null; state.diagnostics = []; state.historyNotice = ""; }
function clearCase() { clearAdvisory(); state.scenario = null; state.plan = null; state.receipt = null; state.approved = false; state.detected = false; }
async function restoreCase(runId: string) {
  const restored = await readCase(api,runId).catch(error => { state.needsRecheck = true; throw error; });
  // A changed merchant snapshot invalidates advisory panels, even within one run.
  const same = state.scenario?.run.id === runId;
  if (!same || JSON.stringify(state.scenario?.orders) !== JSON.stringify(restored.scenario.orders)) clearAdvisory();
  state.scenario = restored.scenario; state.plan = restored.plan; state.receipt = restored.receipt;
  state.approved = restored.plan?.approved ?? false; state.detected = detectedFromCase(restored.scenario);
  rememberRun(runId);
}
async function mutateCase(action: string,body: unknown = {}) {
  if (state.needsRecheck || state.sessionStatus !== "AUTHENTICATED") throw new Error("Resume/Recheck Case before another mutation.");
  const runId = state.scenario!.run.id;
  markMutation(runId); // Survives reload while the POST or subsequent read is interrupted.
  await api(path(action),body);
  state.needsRecheck = true; state.pendingMutationRun = runId;
  await restoreCase(runId);
  markMutation(null); state.needsRecheck = false;
  if (action === "plan") state.notice = "Review the exact order changes below. A new plan always requires its own approval.";
}
async function resumeCase() {
  const restored = await boot();
  if (state.unidentifiedCreation) {
    state.notice = creationNotice();
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
  if (!userId) state.creationOperation = null;
  try { if (userId) localStorage.setItem(CREATION_MARKER,userId); else localStorage.removeItem(CREATION_MARKER); } catch { /* Never infer rollback from unavailable browser storage. */ }
}
function creationNotice() {
  if (!state.creationOperation) return CREATION_LIMITATION;
  return state.session.userId !== state.creationOperation.userId ? "Restore the original session to reconcile this creation. A new guest session cannot take ownership or retry it." : "Creation outcome is not yet confirmed. Recheck it using read-only lookup, or explicitly retry the same operation. A missing mapping does not prove rollback; the operation identity is preserved.";
}
function persistCreation(operation: PendingCreation) {
  const encoded = JSON.stringify(operation);
  try { localStorage.setItem(CREATION_MARKER,encoded); if (localStorage.getItem(CREATION_MARKER) !== encoded) throw new Error("Storage readback failed"); }
  catch { throw new Error("Browser storage is unavailable. Case creation was not sent because its operation identity could not be saved safely. Enable site storage and recheck the connection."); }
  state.creationOperation = operation; state.unidentifiedCreation = operation.userId;
}
function saveCaseLocation(runId: string) {
  rememberRun(runId);
  const url = new URL(location.href); url.searchParams.delete("view"); url.searchParams.set("run",runId); history.replaceState(null,"",url);
  try { localStorage.setItem("ordertruth.judge.run",runId); } catch { /* URL preserves the known case identity. */ }
}
async function reconcileCreation(): Promise<boolean> {
  const operation = state.creationOperation;
  if (!operation || !state.session.authenticated || state.session.userId !== operation.userId) { state.notice = creationNotice(); return false; }
  const scenario = parseOperation(await api<unknown>(`/api/scenario-operations/${operation.operationId}`),operation.operationId);
  if (!scenario) { state.notice = creationNotice(); return false; }
  await restoreCase(scenario.run.id);saveCaseLocation(scenario.run.id);markCreation(null);
  state.needsRecheck = !!state.pendingMutationRun;state.notice = "The original case was recovered by its saved operation identity. No creation request was repeated.";
  return true;
}
async function sendCreation(operation: PendingCreation) {
  if (!state.session.authenticated || state.session.userId !== operation.userId || state.pendingMutationRun) throw new Error("Restore the original session and reconcile any pending case mutation first.");
  try {
    // The only intentional write while creation is uncertain: the same durable, owner-scoped idempotency key.
    const scenario = parseCreation(await requestJson<unknown>("/api/scenarios",{ operationId: operation.operationId }),operation.operationId);
    await restoreCase(scenario.run.id);saveCaseLocation(scenario.run.id);markCreation(null);state.needsRecheck = false;
  } catch (error) {
    state.needsRecheck = true;
    if (error instanceof RequestError && [401,403].includes(error.status)) { state.sessionStatus = "UNKNOWN";clearCase(); }
    throw new Error(`Case creation outcome remains uncertain. ${error instanceof Error ? error.message : "No validated case received."} Recheck or retry the same saved operation; no automatic POST retry was made.`);
  }
}
async function retryCreation() {
  await discoverSession();
  if (!state.creationOperation || state.session.userId !== state.creationOperation.userId) throw new Error(creationNotice());
  if (await reconcileCreation()) return;
  await sendCreation(state.creationOperation!);
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
  const operation = { operationId: crypto.randomUUID(),userId: state.session.userId! };
  persistCreation(operation);
  await sendCreation(operation);
}
async function diagnostic(kind: DiagnosticKind) {
  let evidence: InvestigationEvidence;
  try { evidence = parseDiagnostic(await api<unknown>(path("diagnostics"),{ kind }),kind); }
  catch (error) { state.needsRecheck = true; throw error; }
  historyRevision++; state.historyNotice = "";
  state.diagnostics = [...state.diagnostics.filter(e => e.id !== evidence.id),evidence];
}
function record(title: string,value: string) { const row = el("div","","record"); row.append(el("span",title,"muted"),el("strong",value)); return row; }
function json(title: string,data: unknown) { const detail = el("details"); detail.append(el("summary",title),el("pre",JSON.stringify(data,null,2))); return detail; }
function render() {
  clearTimeout(planExpiryTimer);
  root.replaceChildren();
  const header = el("header"); const brand = el("a","OrderTruth","brand"); brand.href = "/?view=overview"; brand.setAttribute("aria-label","OrderTruth overview");
  const identity = el("span",state.sessionStatus === "AUTHENTICATED" ? (state.session.owner ? "Owner session" : "Private workspace") : state.sessionStatus === "SIGNED_OUT" ? "Sandbox workspace" : state.busy ? "Connecting to workspace" : "Session unconfirmed","session-label");
  const ownerToggle = button(state.ownerForm ? "Close owner sign-in" : "Owner access",() => { state.ownerForm = !state.ownerForm; },true);
  ownerToggle.id = "owner-toggle"; ownerToggle.setAttribute("aria-expanded",String(state.ownerForm));
  const labLink = el("a","Integration Lab"); labLink.href = "/lab/";
  header.append(brand,identity,labLink,ownerToggle); root.append(header);
  if(state.sessionStatus === "AUTHENTICATED") {
    const signOut=button("Sign out",async()=>{
      if(state.pendingMutationRun || state.unidentifiedCreation || state.creationOperation) throw new Error("Reconcile the pending operation before signing out.");
      await api("/api/auth/sign-out",{}); await discoverSession();
      if(state.session.authenticated) throw new Error("Sign-out could not be confirmed; no new session was started.");
      clearCase(); history.replaceState({},"","/?view=overview");
      state.notice="Signed out. Existing cases and receipts remain stored under their original session.";
    },true,true);
    signOut.disabled ||= !!state.pendingMutationRun || !!state.unidentifiedCreation || !!state.creationOperation;
    header.append(signOut);
  }
  const main = el("main"); main.id = "workspace"; main.tabIndex = -1;
  main.setAttribute("aria-busy",String(!!state.busy));
  const intro = el("div","",state.scenario ? "intro case-intro" : "intro");
  intro.append(el("p","Payment integrity, beyond the payment.","kicker"),el("h1",state.scenario ? state.receipt?.verifiedCurrent && !state.needsRecheck ? "Correction made. Outcome verified." : "One payment. Follow every order." : "A successful payment doesn’t guarantee the merchant order is correct."),
    el("p",state.scenario ? "Inspect the recorded evidence, compare the merchant outcome, and make a correction you can verify." : "OrderTruth connects payment evidence to the merchant outcome. Find a discrepancy, understand it, and verify an exact, human-approved correction.","lead"));
  main.append(intro);
  if (state.ownerForm) main.append(ownerForm());
  const progress = el("p",state.busy ? `${state.busy}…` : "","notice"); progress.id = "request-status"; progress.hidden = !state.busy; progress.setAttribute("role","status"); progress.setAttribute("aria-live","polite"); progress.setAttribute("aria-atomic","true"); root.append(progress);
  if (state.error) { const error = el("p",state.error,"error"); error.id = "action-error"; error.tabIndex = -1; error.setAttribute("role","alert"); main.append(error); }
  else if (state.notice && !state.busy) { const notice = el("p",state.notice,"notice"); notice.setAttribute("role","status"); main.append(notice); }
  const toolbar = el("div","","toolbar");
  const start = button(state.scenario || savedRun() ? "Start a new isolated case" : "Inspect a payment outcome",createCase);
  start.disabled = !!state.busy || ["UNKNOWN","CHECKING"].includes(state.sessionStatus) || state.needsRecheck;
  if (!state.scenario) {
    const connection = el("section","","connection"); connection.setAttribute("aria-label","Workspace connection");
    connection.append(el("strong",state.busy ? "Confirming your session" : state.sessionStatus === "UNKNOWN" ? "Connection needs attention" : state.needsRecheck ? "Recover the previous request first" : "Connection confirmed"),el("p",state.busy ? "You can read the workflow while we connect. This can take up to 90 seconds if the server is waking from idle." : state.sessionStatus === "UNKNOWN" ? "The server could not confirm your session. Recheck the connection to try a read-only request. No payment or repair will be submitted." : state.needsRecheck ? "Recheck the saved operation before starting another case. A timeout or incomplete response does not establish rollback." : "A private case needs an owner-approved stored PayPal Sandbox observation. Availability is checked when you begin. The case creates controlled merchant state; it does not charge a buyer.","muted"));
    toolbar.append(start,button("Resume/Recheck Case",resumeCase,!state.needsRecheck)); connection.append(toolbar); main.append(connection);
  } else {
    toolbar.append(button("Resume/Recheck Case",resumeCase,true));
    const views = el("div","","view-switch"); views.setAttribute("aria-label","Investigation view");
    for (const role of ["operations","engineering"]) { const tab = button(role === "operations" ? "Operations view" : "Engineering view",() => { state.role = role; },true); tab.setAttribute("aria-pressed",String(state.role === role)); views.append(tab); }
    toolbar.append(views); main.append(toolbar);
    main.append(el("p","Views change the detail shown, not your permissions. Approval is bound to this session and the exact plan.","view-note"));
  }
  if (state.needsRecheck) main.append(el("p","The last request may have committed. Resume/Recheck Case before any further changes; a timeout does not mean rollback.","notice"));
  if (state.creationOperation) {
    const pending = section("Recover the original case",creationNotice());
    const retry = button("Retry same case creation",retryCreation,true);
    retry.disabled ||= state.sessionStatus !== "AUTHENTICATED" || state.session.userId !== state.creationOperation.userId || !!state.pendingMutationRun;
    pending.append(retry,el("p","Retry first looks up the original operation. If it is still unknown, it submits the same identity, which the server serializes to prevent an extra case.","muted"));main.append(pending);
  }
  if (!state.scenario) {
    const welcome = section("From payment to a trustworthy outcome","One connected workflow. Evidence at every decision."); welcome.className = "workflow-preview";
    const steps = el("ol","","welcome-steps");
    for (const [title,description] of [["Payment","Inspect a stored observation."],["Detect discrepancy","Compare payment and merchant state."],["Investigate","Start with deterministic findings."],["Resolve","Review and approve exact changes."],["Verify","Re-read the persisted receipt."]]) { const item = el("li"); item.append(el("strong",title),el("p",description!,"muted")); steps.append(item); }
    welcome.append(steps,el("p","The controlled scenario creates duplicate merchant orders on purpose. It does not reproduce natural PayPal webhook delivery. No case action captures or refunds a payment.","scope-note")); main.append(welcome);
  } else main.append(caseView());
  if (state.scenario) {
    const continueCase = el("details","","continue-case"); continueCase.append(el("summary","Continue with another case"),el("p","Starting another isolated case preserves this case and its receipt. Save this page’s link to return directly.","muted"),start); main.append(continueCase);
  }
  const recent = recentRuns().filter(id => id !== state.scenario?.run.id);
  if (recent.length) {
    const navigation = el("details","","recent-cases"); navigation.append(el("summary","Reopen a recent case on this device"),el("p","Only cases opened in this browser session are listed here. Access is checked again by the server.","muted"));
    const list = el("ul"); for (const id of recent) { const item = el("li"),link = el("a",`Open case ${id}`); link.href = `/?run=${encodeURIComponent(id)}`; item.append(link); list.append(item); } navigation.append(list); main.append(navigation);
  }
  root.append(main);
  const footer = el("footer","Independent OrderTruth prototype. PayPal Sandbox observations and controlled merchant state are labelled separately. Not affiliated with or endorsed by PayPal."); root.append(footer);
  const plan = state.plan;
  if (plan && !state.receipt && !planExpired(plan) && Date.parse(plan.expires_at)-Date.now() < 86400_000) {
    planExpiryTimer = setTimeout(() => {
      if (state.busy || state.plan?.id !== plan.id) return; // The action's final render rechecks expiry.
      const recovery = root.querySelector<HTMLElement>("#recovery-panel");
      const status = root.querySelector<HTMLElement>("#plan-expiry");
      if (!recovery || !status) return;
      status.textContent = `Plan expired: ${dateTime(plan.expires_at)}. Renew to review a new exact plan and approve it again.`; status.className = "error"; status.setAttribute("role","status");
      let focused = false;
      for (const control of recovery.querySelectorAll("button")) if (["Approve this exact merchant-only plan","Execute approved local repair"].includes(control.textContent ?? "")) { focused ||= document.activeElement === control; control.disabled = true; control.hidden = true; }
      const renew = button("Renew expired plan",() => mutateCase("plan"),false,true);recovery.append(renew);if (focused) renew.focus();
    },Math.max(1,Date.parse(plan.expires_at)-Date.now()));
  }
}
function caseView() {
  const currentVerified = state.receipt?.verifiedCurrent === true && !state.needsRecheck;
  const scenario = state.scenario!; const container = el("div");
  const provenance = el("aside","","provenance");
  provenance.append(el("strong",scenario.paymentReference.provenance === "PAYPAL_SANDBOX_GET" ? "Original PayPal Sandbox observation" : "Synthetic qualification observation"),
    el("span",`Observed ${dateTime(scenario.paymentReference.observedAt)} · Evidence E${scenario.paymentReference.evidenceSeq}`),el("p",scenario.paymentReference.note)); container.append(provenance);
  const flow = el("ol","","flow");
  const stages: Array<[string,boolean]> = [["Payment",true],["Detect",!!scenario.latestCheck],["Investigate (optional)",!!state.analysis],["Resolve",state.receipt?.receipt.outcome === "SUCCEEDED"],["Verify",!!state.receipt?.verifiedCurrent && !state.needsRecheck]];
  const current = state.receipt?.verifiedCurrent && !state.needsRecheck ? -1 : state.receipt ? 4 : state.plan || state.detected ? 3 : 1;
  stages.forEach(([label,done],i) => { const item = el("li","",done ? "done" : current === i ? "current" : ""); item.append(el("strong",label),el("span",done ? "Complete" : i === 2 ? "Optional" : i === current ? "Current step" : "Upcoming")); if (current === i) item.setAttribute("aria-current","step"); flow.append(item); }); container.append(flow);
  const grid = el("div","","case-grid");
  const merchant = section("Does the merchant outcome match?","A stored payment observation and the merchant orders linked to it are different sources of evidence."); merchant.className += " merchant-panel";
  const caseHeading = merchant.querySelector("h2")!; caseHeading.id = "case-heading"; caseHeading.tabIndex = -1;
  const active = scenario.orders.filter(o => o.effective_status === "placed");
  const comparison = el("div","","comparison"); const payment = el("div","","payment-fact"),orders = el("div","","merchant-fact");
  const capture=scenario.paymentReference.recordedCapture;
  payment.append(el("span","Payment evidence","muted"),el("strong","1 recorded observation"),el("p",scenario.paymentReference.provenance === "PAYPAL_SANDBOX_GET" ? "PayPal Sandbox GET readback" : "Synthetic qualification input"),
    el("p",capture ? `Recorded capture: ${capture.status} · ${capture.currency} ${capture.value}. Historical provider observation; no fresh PayPal call.` : "Capture amount and status are unavailable in this observation.","muted"));
  orders.append(el("span","Controlled merchant outcome","muted"),el("strong",`${active.length} active ${active.length === 1 ? "order" : "orders"}`),el("p",active.length > 1 ? "One observation is linked to multiple active orders." : active.length === 1 ? "One active order remains linked to the observation." : "No active merchant orders are present in this response. Recheck the case before proceeding.")); comparison.append(payment,orders); merchant.append(comparison);
  const verdict = el("p",currentVerified ? "Current merchant state verified: one active order." : state.detected && active.length > 1 ? "Deterministic finding: duplicate active merchant orders." : "Check the merchant outcome first. Deterministic checks establish whether a duplicate is actionable.",state.detected ? "result-label" : "scope-note"); merchant.append(verdict);
  const orderList = el("div","","order-list");
  scenario.orders.forEach((order,index) => { const row = el("div","","order-row"); const description = el("div"); description.append(el("strong",`Merchant order ${index+1}`),el("span",`${formatMoney(order.amount_minor,order.currency)} · Merchant amount`,"muted")); row.append(description,el("span",order.effective_status === "placed" ? "Active" : "Voided duplicate",order.effective_status === "placed" ? "badge" : "badge neutral")); orderList.append(row); }); merchant.append(orderList);
  merchant.append(json("Case identity and full order records",{ caseId: scenario.run.id,orders: scenario.orders }));
  const actions = el("div","","actions");
  if (scenario.orders.length === 1 && !state.plan) { merchant.append(el("p","Controlled fault injection: introduce one additional merchant order linked to the same observation. This is a deliberate local write, not a new payment or natural webhook delivery.","scope-note")); actions.append(button("Introduce duplicate",() => mutateCase("duplicate"),false,true)); }
  if (!state.receipt?.verifiedCurrent && (active.length > 1 || state.detected)) actions.append(button("Detect anomaly",async () => {
    markMutation(scenario.run.id);
    const checked = await api<{ result?: unknown }>(path("check"),{});
    if (!checked || !["VIOLATED","HOLDS","NOT_ELIGIBLE","OUT_OF_SCOPE"].includes(String(checked.result))) { state.needsRecheck = true; throw new Error("Invalid check response. Recheck the persisted case; the check was not replayed."); }
    await restoreCase(scenario.run.id); // Only the persisted explicit check controls progression.
    markMutation(null); state.needsRecheck = false;
    if (!state.detected) state.notice = "The current order state does not establish an actionable duplicate. Recheck the evidence before planning a correction.";
  },state.detected,true));
  else if (currentVerified) actions.append(el("p","This case is recovered. You can recheck the receipt or continue with another isolated case below.","muted"));
  merchant.append(actions); grid.append(merchant);
  if (!state.receipt) grid.append(investigationView());

  const recovery = section("Review the correction","An exact plan keeps one merchant order and locally voids the duplicates. Approval and execution are separate decisions."); recovery.className += " recovery-panel";
  recovery.id = "recovery-panel";
  const reviewHeading = recovery.querySelector("h2")!; reviewHeading.id = "review-heading"; reviewHeading.tabIndex = -1;
  const completed = state.receipt?.verifiedCurrent === true && state.receipt.receipt.outcome === "SUCCEEDED";
  const expired = state.plan ? planExpired(state.plan) : false;
  if (!state.detected && !state.plan) recovery.append(el("p","Check the merchant outcome first. A confirmed, actionable duplicate is required to prepare a correction.","scope-note"));
  if (!completed && (state.detected || state.plan) && (!state.plan || expired || state.receipt)) recovery.append(button(expired && !state.receipt ? "Renew expired plan" : "Review exact repair plan",() => mutateCase("plan"),false,true));
  if (state.plan) {
    const plan = state.plan;
    const voids = JSON.parse(plan.void_order_ids_json) as string[];
    const changes = el("div","","change-preview");
    changes.append(record(state.receipt ? "Approved plan scope" : "Before → proposed after",state.receipt ? `${voids.length} duplicate ${voids.length === 1 ? "order" : "orders"} targeted; 1 keeper` : `${active.length} active orders → 1 active order`),record("Keep active",orderName(plan.keep_order_id)),record("Void in the merchant database",voids.map(orderName).join(", ")),record("PayPal effects","No capture, refund or provider record change")); recovery.append(changes);
    recovery.append(json("Exact plan identity and order changes",{ planId: plan.id,planSha256: plan.plan_sha256,keepOrderId: plan.keep_order_id,voidOrderIds: voids }));
    if (!state.receipt) { const expiry = el("p",`${expired ? "Plan expired" : "Approval expires"}: ${dateTime(plan.expires_at)}. ${expired ? "Renew to review a new exact plan and approve it again." : "The server rechecks expiry and merchant state before execution."}`,expired ? "error" : "muted"); expiry.id = "plan-expiry";recovery.append(expiry); }
    if (!completed && !expired && !state.receipt) {
      if (state.approved) recovery.append(el("p","Exact plan approved for this session. Approval does not execute the correction.","approval-status"));
      else recovery.append(button("Approve this exact merchant-only plan",async () => { if (planExpired(plan)) throw new Error("Plan expired. Recheck the case and renew the exact plan before approval."); await mutateCase("approve",{ planId: plan.id,planSha256: plan.plan_sha256 }); },false,true));
      if (state.approved) recovery.append(button("Execute approved local repair",async () => { if (planExpired(plan)) throw new Error("Plan expired. Recheck the case and renew before execution."); await mutateCase("execute",{ planId: plan.id }); },false,true));
    }
  }
  if (state.receipt) {
    const receipt = state.receipt;
    const heading = el("h3",receipt.verifiedCurrent && !state.needsRecheck ? "Merchant correction verified" : "Outcome needs review"); heading.id = "receipt-heading"; heading.tabIndex = -1;
    recovery.append(heading,el("p",`Persisted receipt: ${receipt.receipt.outcome}. Recorded ${dateTime(receipt.receipt.completed_at)}.`),el("p","Independent database verification re-reads the merchant outcome and compares stored provider evidence. It does not make a fresh PayPal API call.","scope-note"),record(state.needsRecheck ? "Last verified active orders" : "Current active orders",String(receipt.current.activeOrders)),record("Expected surviving order",`${receipt.current.matchingKeeper} matching keeper`),record(state.needsRecheck ? "Stored provider evidence at last check" : "Stored provider evidence",receipt.current.providerUnchanged ? "Unchanged" : "Unchanged state not established"));
    if (!currentVerified) recovery.append(el("p","The historical receipt is preserved, but the current merchant postconditions are not verified. Recheck before preparing another correction.","error"));
    recovery.append(button("Recheck committed receipt",resumeCase,true),button("Export receipt and evidence",() => {
      const blob = new Blob([JSON.stringify({ scenario,receipt: { ...state.receipt,verifiedCurrent: currentVerified },verificationStatus: state.needsRecheck ? "RECHECK_REQUIRED" : "READ_COMPLETED",investigation: state.analysis,diagnostics: state.diagnostics },null,2)],{ type: "application/json" });
      const url = URL.createObjectURL(blob); const link = el("a"); link.href = url; link.download = `ordertruth-${scenario.run.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
    },true));
  }
  grid.append(recovery); if (state.receipt) grid.append(investigationView());container.append(grid); return container;
}
function dateTime(value: string) { return new Date(value).toLocaleString(undefined,{ dateStyle: "medium",timeStyle: "long" }); }
function formatMoney(minor: number,currency: string) { try { return new Intl.NumberFormat(undefined,{ style: "currency",currency }).format(minor/100); } catch { return `${minor} minor units ${currency}`; } }
function orderName(id: string) { const index = state.scenario!.orders.findIndex(o => o.id === id); return index >= 0 ? `Merchant order ${index+1}` : id; }
function investigationView() {
  const investigation = section("Understand the discrepancy","Deterministic evidence comes first. AI is an optional advisory tool and cannot authorize or execute a correction.");
  investigation.id = "investigation-panel";
  const heading = investigation.querySelector("h2")!; heading.id = "investigation-heading"; heading.tabIndex = -1;
  const notice = el("p",state.historyNotice,"muted"); notice.id = "saved-history-status"; notice.setAttribute("role","status"); investigation.append(notice);
  investigation.append(el("p",state.receipt ? "Review the receipt for the current merchant outcome. Any saved advisory below describes its historical evidence snapshot." : state.detected ? "Confirmed finding: multiple active merchant orders reference the same recorded payment observation. This establishes a merchant discrepancy, not its cause." : "Check the merchant outcome first. Optional investigation becomes available after an actionable discrepancy is confirmed.","baseline"));
  const ai = button("Investigate with AI",async () => {
    historyRevision++; state.historyNotice = "";
    const analysis = await api<unknown>(path("investigate"),{});
    try { validateHistory(analysis); if (!analysis) throw new Error("AI response returned invalid data"); }
    catch (error) { state.needsRecheck = true; throw error; }
    state.analysis = analysis;
  },true,true); ai.disabled ||= !state.detected; if (!state.receipt) investigation.append(ai);
  const analysis = state.analysis;
  if (analysis) {
    investigation.append(el("p",analysis.status === "FRESH" ? "Fresh AI inference" : analysis.status === "CACHED" ? "Cached AI result — no new model execution" : "AI unavailable — rules-based guidance","result-label"));
    investigation.append(el("p",analysis.baseline.summary,"baseline"));
    if (analysis.generatedAt) investigation.append(el("p",`${analysis.model ?? "Model"} · Generated ${dateTime(analysis.generatedAt)}`,"muted"));
    if (analysis.snapshotSha256) investigation.append(json("Analysis snapshot identity",{ sha256: analysis.snapshotSha256 }));
    if (analysis.investigation) {
      investigation.append(el("p",analysis.investigation.summary));
      for (const hypothesis of analysis.investigation.hypotheses) { const article = el("article","","hypothesis"); article.append(el("strong",`Hypothesis · ${hypothesis.confidence.toLowerCase()} confidence`),el("p",hypothesis.explanation),el("p",`Evidence: ${hypothesis.evidenceIds.join(", ")}`,"evidence-ids")); investigation.append(article); }
      investigation.append(el("p",analysis.investigation.diagnosticReason));
    } else investigation.append(el("p",aiAvailability(analysis.reason,analysis.retryAt),"scope-note"));
    const next = analysis.investigation?.nextDiagnostic ?? analysis.baseline.nextDiagnostic;
    if (state.detected && !state.receipt) investigation.append(button(`Run ${diagnosticName(next)}`,() => diagnostic(next),true,true));
    investigation.append(json("Evidence snapshot used for this investigation",analysis.evidence));
    investigation.append(el("p","This analysis describes its recorded evidence snapshot. Rechecking the case does not rerun AI or turn a hypothesis into a fact.","muted"));
  }
  if (!analysis && state.detected && !state.receipt) investigation.append(button("Run idempotency-key comparison",() => diagnostic("IDEMPOTENCY_KEYS"),true,true));
  for (const evidence of state.diagnostics) {
    const facts = evidence.facts;
    if (facts.diagnostic === "HANDLER_TIMING") investigation.append(timingView(evidence));
    else investigation.append(el("p",facts.diagnostic === "IDEMPOTENCY_KEYS" ? `${String(facts.distinctKeys)} distinct merchant write keys observed. Separate keys can allow duplicate writes.`
      : `${String(facts.committedWrites)} committed controlled merchant writes observed.`));
    investigation.append(json(`${String(facts.diagnostic)} · ${evidence.id}`,evidence));
  }
  if (state.role === "engineering") {
    const advanced = el("details"); advanced.append(el("summary","Advanced merchant diagnostics"),el("p","These inspect controlled merchant writes and persist diagnostic evidence; they do not call PayPal.","muted"));
    for (const kind of ["HANDLER_TIMING","IDEMPOTENCY_KEYS","MERCHANT_WRITE_OUTCOMES"] as const) { const control = button(diagnosticName(kind),() => diagnostic(kind),true,true); control.disabled ||= !state.detected || !!state.receipt; advanced.append(control); } investigation.append(advanced);
  }
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
      ["Order",row => cell(row.orderId)],["Written by",row => cell(row.handler)],
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
    if (state.busy) return;
    void run("Signing in",async () => { await discoverSession(); await api("/api/auth/sign-in/email",credentials); await discoverSession(); clearCase(); }); });
  sectionNode.append(form); return sectionNode;
}
async function boot() {
  await discoverSession();
  if (state.creationOperation && await reconcileCreation()) { restoreHistory(state.scenario!.run.id); return true; }
  const saved = state.pendingMutationRun ?? savedRun();
  if (!state.session.authenticated) {
    if (!state.pendingMutationRun && !state.unidentifiedCreation) state.needsRecheck = false;
    state.notice = state.unidentifiedCreation ? creationNotice() : state.pendingMutationRun ? "This session is signed out or expired. The affected run link is preserved; its uncertain mutation must be reconciled before another case can be started." : saved ? "This session is signed out or expired. The run link and committed records are preserved. A new anonymous session cannot take ownership; start a new isolated case only if you choose to." : "Connection confirmed. Inspect a payment outcome to start your private session.";
    return false;
  }
  if (saved) {
    try { await restoreCase(saved); } catch (error) {
      if (!(error instanceof RequestError) || ![400,404].includes(error.status)) throw error;
      clearCase();
      state.notice = "This case cannot be opened with the current session. The run link is preserved; no ownership or approval was transferred.";
      state.needsRecheck = !!state.pendingMutationRun || !!state.unidentifiedCreation; return false;
    }
    restoreHistory(saved);
  }
  if (state.unidentifiedCreation) state.notice = creationNotice();
  return true;
}
void run("Loading your session",async () => { await boot(); });
