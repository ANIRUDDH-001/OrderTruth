import { afterEach,describe,expect,it,vi } from "vitest";
import { mountJudge,scenario } from "./helpers/judge-dom.ts";
import { validateHistory } from "../web/judge/recovery.ts";

const session = { authenticated: true,userId: "fixture_user",owner: false };
const plan = (approved: boolean,expires_at: string) => ({ id: "plan_fixture",plan_sha256: "hash",keep_order_id: "keeper",void_order_ids_json: '["duplicate"]',expires_at,approved,has_receipt: false });
const duplicate = () => { const s = scenario("run_owned"); s.orders.push({ ...s.orders[0]!,id: "duplicate" }); return { ...s,latestCheck: { seq: 1,result: "VIOLATED",activeOrderCount: 2,evaluatedAt: "2026-11-07T00:00:00Z",incidentId: "incident_fixture" } }; };
const unavailable = { status: "UNAVAILABLE",freshModelExecution: false,reason: "SESSION_DAILY_BUDGET",evidence: [],baseline: { summary: "Compare the merchant writes.",nextDiagnostic: "IDEMPOTENCY_KEYS" } };
afterEach(async () => { if (vi.isFakeTimers()) await vi.runAllTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

describe("Phase 1 recovery and evidence UX",() => {
  it("shows expired approval as a status and offers renewal without execution",async () => {
    const ui = await mountJudge(c => c.path === "/api/session" ? session : c.path.endsWith("/investigation") ? null : { ...duplicate(),latestPlan: plan(true,"2020-01-01T00:00:00Z") },"run_owned");
    expect(ui.doc.root.textContent).toContain("Plan expired");
    expect(ui.button("Renew expired plan").disabled).toBe(false);
    expect(ui.doc.root.querySelectorAll("button").some(b => /Approve this|Exact plan approved|Execute approved/.test(b.textContent))).toBe(false);
    expect(ui.calls.every(c => c.method === "GET")).toBe(true);
  });
  it("never presents an approved exact plan as an approval button",async () => {
    const ui = await mountJudge(c => c.path === "/api/session" ? session : c.path.endsWith("/investigation") ? null : { ...duplicate(),latestPlan: plan(true,"2099-01-01T00:00:00Z") },"run_owned");
    expect(ui.doc.root.textContent).toContain("Exact plan approved");
    expect(ui.doc.root.querySelectorAll("button").some(b => /Approve this|Exact plan approved/.test(b.textContent))).toBe(false);
    expect(ui.button("Execute approved local repair").disabled).toBe(false);
  });
  it("updates a plan that expires while it is on screen without submitting execution",async () => {
    const expires = new Date(Date.now()+5000).toISOString();
    const ui = await mountJudge(c => c.path === "/api/session" ? session : c.path.endsWith("/investigation") ? null : { ...duplicate(),latestPlan: plan(true,expires) },"run_owned");
    expect(ui.button("Execute approved local repair").disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(5001);
    expect(ui.doc.root.textContent).toContain("Plan expired");expect(ui.button("Renew expired plan").disabled).toBe(false);
    expect(ui.calls.every(c => c.method === "GET")).toBe(true);
  });
  it("keeps planning and optional AI behind deterministic discrepancy confirmation",async () => {
    const ui = await mountJudge(c => c.path === "/api/session" ? session : c.path.endsWith("/investigation") ? null : scenario("run_owned"),"run_owned");
    expect(ui.doc.root.querySelectorAll("button").some(b => b.textContent === "Review exact repair plan")).toBe(false);
    expect(ui.button("Investigate with AI").disabled).toBe(true);
    expect(ui.doc.root.textContent).toContain("Check the merchant outcome first");
  });
  it("does not describe an incomplete zero-order response as one surviving order",async () => {
    const ui = await mountJudge(c => c.path === "/api/session" ? session : c.path.endsWith("/investigation") ? null : { ...scenario("run_owned"),orders: [] },"run_owned");
    expect(ui.doc.root.textContent).toContain("No active merchant orders");
    expect(ui.doc.root.textContent).not.toContain("One active order remains");
    expect(ui.button("Resume/Recheck Case").disabled).toBe(false);
  });
  it("rejects malformed fresh AI and preserves the valid panel and recovery controls",async () => {
    const ui = await mountJudge(c => c.path === "/api/session" ? session : c.path.endsWith("/investigation") ? unavailable : c.path.endsWith("/check") ? { result: "VIOLATED" } : c.path.endsWith("/investigate") ? { ...unavailable,investigation: { hypotheses: [{}] } } : duplicate(),"run_owned");
    await ui.click("Detect anomaly"); await ui.click("Investigate with AI");
    expect(ui.doc.root.textContent).toMatch(/invalid data/i);
    expect(ui.doc.root.textContent).toContain("Compare the merchant writes.");
    expect(ui.button("Resume/Recheck Case").disabled).toBe(false);
    expect(ui.calls.filter(c => c.path.endsWith("/investigate"))).toHaveLength(1);
  });
  it("rejects malformed diagnostics without losing the case",async () => {
    const ui = await mountJudge(c => c.path === "/api/session" ? session : c.path.endsWith("/investigation") ? unavailable : c.path.endsWith("/check") ? { result: "VIOLATED" } : c.path.endsWith("/diagnostics") ? { id: "broken" } : duplicate(),"run_owned");
    await ui.click("Detect anomaly"); await ui.click("Run idempotency-key comparison");
    expect(ui.doc.root.textContent).toMatch(/invalid.*diagnostic/i);
    expect(ui.button("Resume/Recheck Case").disabled).toBe(false);
  });
  it("keeps the active trigger mounted throughout a slow operation",async () => {
    let release!: (v: unknown) => void;
    const pending = new Promise(resolve => { release = resolve; });
    const ui = await mountJudge(c => c.path === "/api/session" ? session : c.path.endsWith("/investigation") ? null : c.path.endsWith("/duplicate") ? pending : scenario("run_owned"),"run_owned");
    const control = ui.button("Introduce duplicate"); control.focus(); control.fire("click");
    await vi.advanceTimersByTimeAsync(5000);
    expect(ui.button("Introduce duplicate")).toBe(control); expect(ui.doc.activeElement).toBe(control);
    expect(control.getAttribute("aria-disabled")).toBe("true");
    release({}); await ui.idle();
  });
  it("removes old analysis and diagnostics when the authenticated identity changes",async () => {
    let current = session;
    const ui = await mountJudge(c => c.path === "/api/session" ? current : c.path.endsWith("/investigation") ? unavailable : current.userId === session.userId ? duplicate() : new Response('{}',{ status: 404 }),"run_owned");
    expect(ui.doc.root.textContent).toContain("Compare the merchant writes.");
    current = { ...session,userId: "other_user" }; await ui.click("Resume/Recheck Case");
    expect(ui.doc.root.textContent).not.toContain("Compare the merchant writes.");
    expect(ui.doc.root.querySelectorAll("button").some(b => b.textContent === "Export receipt and evidence")).toBe(false);
  });
});

describe("analysis trust boundary",() => {
  it("rejects contradictory model execution flags and unsupported evidence",() => {
    for (const value of [{ ...unavailable,status: "FRESH" },{ ...unavailable,freshModelExecution: true },{ ...unavailable,evidence: [{ id: "e1",source: "INVENTED",observedAt: "today",facts: {} }] }]) expect(() => validateHistory(value)).toThrow("invalid data");
  });
  it("rejects invalid confidence, invented citations and oversized summaries",() => {
    const base = { ...unavailable,status: "CACHED",investigation: { summary: "Summary",diagnosticReason: "Compare",nextDiagnostic: "HANDLER_TIMING",hypotheses: [{ explanation: "Maybe",confidence: "HIGH",status: "HYPOTHESIS",evidenceIds: ["invented"] }] } };
    for (const value of [base,{ ...unavailable,baseline: { ...unavailable.baseline,summary: "x".repeat(2001) } }]) expect(() => validateHistory(value)).toThrow("invalid data");
  });
});

it("preserves historical receipt but withdraws current verification after a failed read",async () => {
  let invalid=false;
  const receipt={verifiedCurrent:true,receipt:{execution_id:"execution",outcome:"SUCCEEDED",completed_at:"2026-11-07T00:00:00Z",provider_before_sha256:"hash",provider_after_sha256:"hash"},current:{activeOrders:1,matchingKeeper:1,providerUnchanged:true}};
  const saved={...scenario("run_owned"),latestPlan:{...plan(true,"2026-11-07T00:15:00Z"),has_receipt:true}};
  const ui=await mountJudge(c=>c.path==="/api/session"?session:c.path.endsWith("/investigation")?null:c.path.includes("/receipts/")?(invalid?{}:receipt):saved,"run_owned");
  expect(ui.doc.root.textContent).toContain("Current merchant state verified");
  invalid=true;await ui.click("Recheck committed receipt");
  expect(ui.doc.root.textContent).toContain("Persisted receipt: SUCCEEDED");
  expect(ui.doc.root.textContent).toContain("Outcome needs review");
  expect(ui.doc.root.textContent).not.toContain("Current merchant state verified");
  expect(ui.doc.root.textContent).toContain("Last verified active orders");
  expect(ui.doc.root.textContent).toContain("current merchant postconditions are not verified");
  expect(ui.calls.every(c=>c.method==="GET")).toBe(true);
});

it("moves keyboard focus to visible investigation heading after advanced diagnostic rerender",async () => {
  const diagnostic={id:"D_focus",source:"MERCHANT_DIAGNOSTIC",observedAt:"2026-11-07T00:00:00Z",facts:{diagnostic:"IDEMPOTENCY_KEYS",distinctKeys:2,entries:[]}};
  const ui=await mountJudge(c=>c.path==="/api/session"?session:c.path.endsWith("/investigation")?null:c.path.endsWith("/diagnostics")?diagnostic:duplicate(),"run_owned");
  await ui.click("Engineering view");await ui.click("idempotency-key comparison");
  expect(ui.doc.activeElement?.id).toBe("investigation-heading");
});
