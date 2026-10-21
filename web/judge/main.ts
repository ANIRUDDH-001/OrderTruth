import type { Investigation,InvestigationEvidence,DiagnosticKind } from "../../src/ai/investigation.ts";

type Session = { authenticated: boolean; userId?: string; owner?: boolean };
type Scenario = { run: { id: string; label: string }; orders: Array<{ id: string; effective_status: string; amount_minor: number; currency: string }>;
  paymentReference: { attemptId: string; evidenceSeq: number; observedAt: string; provenance: string; note: string };latestPlan?: Plan & { approved: boolean; has_receipt: boolean } };
type Plan = { id: string; plan_sha256: string; keep_order_id: string; void_order_ids_json: string; expires_at: string };
type Analysis = { status: "FRESH"|"CACHED"|"UNAVAILABLE"; freshModelExecution: boolean; reason: string|null; generatedAt?: string; model?: string;
  investigation?: Investigation; snapshotSha256?: string; evidence: InvestigationEvidence[]; baseline: { summary: string; nextDiagnostic: DiagnosticKind } };
type Receipt = { receipt: { execution_id: string; outcome: string; completed_at: string; provider_before_sha256: string; provider_after_sha256: string }; verifiedCurrent: boolean; current: { activeOrders: number; matchingKeeper: number; providerUnchanged: boolean } };
const root = document.querySelector<HTMLElement>("#app")!;
const state = { session: { authenticated: false } as Session,scenario: null as Scenario|null,analysis: null as Analysis|null,plan: null as Plan|null,receipt: null as Receipt|null,
  approved: false,detected: false,busy: "",error: "",role: "operations",ownerForm: false,diagnostics: [] as InvestigationEvidence[] };
function el<K extends keyof HTMLElementTagNameMap>(tag: K,text = "",className = ""): HTMLElementTagNameMap[K] { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; }
function section(title: string,description: string) { const node = el("section","","panel"); node.append(el("h2",title),el("p",description,"muted")); return node; }
function button(text: string,action: () => Promise<void>|void,secondary = false) {
  const node = el("button",text,secondary ? "button secondary" : "button"); node.type = "button"; node.disabled = !!state.busy;
  node.addEventListener("click",() => void run(text,action)); return node;
}
async function api<T>(path: string,body?: unknown): Promise<T> {
  const response = await fetch(path,{ credentials: "same-origin",...(body !== undefined ? { method: "POST",headers: { "content-type": "application/json" },body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(data.message ?? data.error ?? `Request unavailable (${response.status})`); return data;
}
async function run(label: string,action: () => Promise<void>|void) {
  state.busy = label; state.error = ""; render();
  try { await action(); } catch (error) { state.error = error instanceof Error ? error.message : "Request unavailable. Your committed case is preserved."; }
  finally { state.busy = ""; render(); const target = [...root.querySelectorAll("button")].find(b => b.textContent === label); target?.focus({ preventScroll: true }); }
}
function path(action = "") { return `/api/scenarios/${encodeURIComponent(state.scenario!.run.id)}${action ? `/${action}` : ""}`; }
async function refresh() { state.scenario = await api<Scenario>(path()); }
async function createCase() {
  if (!state.session.authenticated) { await api("/api/auth/sign-in/anonymous",{}); state.session = await api<Session>("/api/session"); }
  const scenario = await api<Scenario>("/api/scenarios",{});
  state.scenario = scenario; state.analysis = null; state.plan = null; state.approved = false; state.receipt = null; state.detected = false; state.diagnostics = [];
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
  const identity = el("span",state.session.owner ? "Owner session" : state.session.authenticated ? "Private judge session" : "Interactive Sandbox investigation","muted");
  header.append(brand,identity,button(state.ownerForm ? "Close owner sign-in" : "Owner access",() => { state.ownerForm = !state.ownerForm; },true)); root.append(header);
  const main = el("main"); main.id = "workspace"; main.tabIndex = -1;
  const intro = el("div","","intro"); intro.append(el("p","Investigate merchant outcomes. Verify recovery.","kicker"),el("h1",state.scenario ? "Follow the evidence to recovery." : "A payment can succeed. Its order can still be wrong."),
    el("p","Explore a controlled merchant anomaly against an original PayPal Sandbox observation. Investigate, approve a merchant-only repair, and independently check the result.","lead"));
  main.append(intro);
  if (state.ownerForm) main.append(ownerForm());
  if (state.busy) { const progress = el("p",`${state.busy}…`,"notice"); progress.setAttribute("role","status"); progress.setAttribute("aria-live","polite"); main.append(progress); }
  if (state.error) { const error = el("p",state.error,"error"); error.setAttribute("role","alert"); main.append(error); }
  const toolbar = el("div","","toolbar");
  for (const role of ["operations","engineering"]) {
    const tab = button(role === "operations" ? "Operations" : "Engineering",() => { state.role = role; },true); tab.setAttribute("aria-pressed",String(state.role === role)); toolbar.append(tab);
  }
  toolbar.append(button(state.scenario ? "Start a new isolated case" : "Start judge experience",createCase)); main.append(toolbar);
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
  const active = scenario.orders.filter(o => o.effective_status === "placed");
  merchant.append(record("Active merchant orders",String(active.length)),record("Case",scenario.run.id));
  if (state.detected) { const verdict = el("p",state.receipt?.verifiedCurrent ? "Verified recovery: one active merchant order." : active.length > 1 ? "Duplicate merchant orders detected." : "Recheck the current merchant outcome.","result-label"); verdict.setAttribute("role","status"); merchant.append(verdict); }
  for (const order of scenario.orders) merchant.append(record(order.id,order.effective_status === "placed" ? "Active" : "Voided duplicate"));
  const actions = el("div","","actions");
  if (scenario.orders.length === 1) actions.append(button("Introduce duplicate",async () => { state.scenario = await api<Scenario>(path("duplicate"),{}); state.plan = null; state.approved = false; state.receipt = null; }));
  if (!state.receipt?.verifiedCurrent) actions.append(button("Detect anomaly",async () => { const checked = await api<{ result: string }>(path("check"),{}); state.detected = checked.result === "VIOLATED"; if (!state.detected) state.error = "The current order state does not contain an actionable duplicate."; },true));
  else actions.append(el("p","This case is recovered. Start a new isolated case to explore again; this receipt is preserved.","muted"));
  merchant.append(actions); grid.append(merchant);
  const investigation = section("Evidence-grounded investigation","AI proposes hypotheses. Read-only diagnostics supply new evidence; the model cannot execute repairs.");
  investigation.append(button("Investigate with AI",async () => { state.analysis = await api<Analysis>(path("investigate"),{}); }));
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
    investigation.append(button(`Run ${diagnosticName(next)}`,() => diagnostic(next),true));
    investigation.append(json("Evidence snapshot used for this investigation",analysis.evidence));
    if (state.receipt) investigation.append(el("p","This investigation describes its recorded snapshot before recovery. The receipt independently checks the current merchant outcome.","muted"));
  }
  for (const evidence of state.diagnostics) {
    const facts = evidence.facts;
    const summary = facts.diagnostic === "IDEMPOTENCY_KEYS" ? `${String(facts.distinctKeys)} distinct merchant write keys observed. Separate keys can allow duplicate writes.`
      : facts.diagnostic === "HANDLER_TIMING" ? `${Array.isArray(facts.entries) ? facts.entries.length : 0} recorded handler intervals available. Timing alone does not establish a PayPal failure.`
      : `${String(facts.committedWrites)} committed controlled merchant writes observed.`;
    investigation.append(el("p",summary),json(`${String(facts.diagnostic)} · ${evidence.id}`,evidence));
  }
  if (state.role === "engineering") for (const kind of ["HANDLER_TIMING","IDEMPOTENCY_KEYS","MERCHANT_WRITE_OUTCOMES"] as const) investigation.append(button(diagnosticName(kind),() => diagnostic(kind),true));
  grid.append(investigation);
  const recovery = section("Approve, repair, verify","The plan preserves one merchant order and appends a local void for each duplicate. PayPal records remain unchanged.");
  if (!state.approved || (state.receipt && !state.receipt.verifiedCurrent)) recovery.append(button("Review exact repair plan",async () => { state.plan = await api<Plan>(path("plan"),{}); state.detected = true; state.approved = false; state.receipt = null; }));
  if (state.plan) {
    const plan = state.plan;
    recovery.append(record("Keep",plan.keep_order_id),record("Void locally",(JSON.parse(plan.void_order_ids_json) as string[]).join(", ")),record("Exact plan hash",plan.plan_sha256),el("p",`Approval expires ${new Date(plan.expires_at).toLocaleTimeString()}`,"muted"));
    recovery.append(button(state.approved ? "Exact plan approved" : "Approve this exact merchant-only plan",async () => { await api(path("approve"),{ planId: plan.id,planSha256: plan.plan_sha256 }); state.approved = true; }));
    if (state.approved) recovery.append(button("Execute approved local repair",async () => {
      await api(path("execute"),{ planId: plan.id }); state.receipt = await api<Receipt>(path(`receipts/${plan.id}`)); await refresh();
    }));
  }
  if (state.receipt) {
    const receipt = state.receipt;
    recovery.append(el("h3",receipt.verifiedCurrent ? "Recovery independently verified" : "Outcome needs review"),record("Terminal outcome",receipt.receipt.outcome),record("Active orders",String(receipt.current.activeOrders)),record("Expected surviving order",String(receipt.current.matchingKeeper)),record("Provider evidence unchanged",receipt.current.providerUnchanged ? "Verified" : "Not established"));
    recovery.append(button("Recheck committed receipt",async () => { state.receipt = await api<Receipt>(path(`receipts/${state.plan!.id}`)); await refresh(); },true),button("Export receipt and evidence",() => {
      const blob = new Blob([JSON.stringify({ scenario,receipt: state.receipt,investigation: state.analysis,diagnostics: state.diagnostics },null,2)],{ type: "application/json" });
      const url = URL.createObjectURL(blob); const link = el("a"); link.href = url; link.download = `ordertruth-${scenario.run.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
    },true));
  }
  grid.append(recovery); container.append(grid); return container;
}
function diagnosticName(kind: DiagnosticKind) { return ({ HANDLER_TIMING: "handler timing check",IDEMPOTENCY_KEYS: "idempotency-key comparison",MERCHANT_WRITE_OUTCOMES: "merchant write-outcome check" })[kind]; }
function ownerForm() {
  const sectionNode = section("Owner access","Owner sign-in enables genuine Sandbox checkout. Judges need no payment permissions.");
  if (state.session.owner) { const link = el("a","Open owner Sandbox checkout","button"); link.href = "/owner/"; sectionNode.append(link); return sectionNode; }
  const form = el("form"); const email = el("input"); email.type = "email"; email.autocomplete = "username"; email.required = true; email.id = "owner-email";
  const password = el("input"); password.type = "password"; password.autocomplete = "current-password"; password.required = true; password.id = "owner-password";
  const emailLabel = el("label","Owner account"); emailLabel.htmlFor = email.id; const passwordLabel = el("label","Password"); passwordLabel.htmlFor = password.id;
  const submit = el("button","Sign in","button"); submit.type = "submit"; submit.disabled = !!state.busy;
  form.append(emailLabel,email,passwordLabel,password,submit);
  form.addEventListener("submit",event => { event.preventDefault(); const credentials = { email: email.value,password: password.value }; password.value = "";
    void run("Signing in",async () => { await api("/api/auth/sign-in/email",credentials); state.session = await api<Session>("/api/session"); state.scenario = null; }); });
  sectionNode.append(form); return sectionNode;
}
async function boot() {
  state.session = await api<Session>("/api/session");
  let saved = new URL(location.href).searchParams.get("run"); try { saved ||= localStorage.getItem("ordertruth.judge.run"); } catch { /* Optional persistence. */ }
  if (saved && /^[a-zA-Z0-9_-]{1,100}$/.test(saved) && state.session.authenticated) {
    state.scenario = await api<Scenario>(`/api/scenarios/${saved}`);
    state.analysis = await api<Analysis|null>(path("investigation"));
    state.diagnostics = state.analysis?.evidence.filter(e => e.source === "MERCHANT_DIAGNOSTIC") ?? [];
    const latest = state.scenario.latestPlan;
    if (latest) { state.plan = latest; state.approved = latest.approved; state.detected = true;
      if (latest.has_receipt) state.receipt = await api<Receipt>(path(`receipts/${latest.id}`));
    }
  }
}
void run("Loading your session",boot);
