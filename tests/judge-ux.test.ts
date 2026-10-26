import { afterEach,describe,expect,it,vi } from "vitest";
import { mountJudge,scenario } from "./helpers/judge-dom.ts";
import { readFileSync } from "node:fs";

afterEach(async () => { if (vi.isFakeTimers()) await vi.runAllTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });
const session = { authenticated: true,userId: "fixture_owner",owner: false };
const plan = { id: "rp_fixture",plan_sha256: "fixture_hash",keep_order_id: "keeper",void_order_ids_json: '["duplicate"]',expires_at: "2026-10-26T00:00:00Z",approved: true,has_receipt: true };
const receipt = (outcome: string,verifiedCurrent: boolean) => ({ receipt: { execution_id: "execution_fixture",outcome,completed_at: "2026-10-26T00:00:00Z",provider_before_sha256: "unchanged",provider_after_sha256: "unchanged" },verifiedCurrent,current: { activeOrders: 1,matchingKeeper: 1,providerUnchanged: true } });

describe("judge keyboard and completed-case UX",() => {
  for (const [state,selector,background] of [
    ["normal",/input\{[^}]*border:1px solid (#[0-9a-f]{6})/,"#ffffff"],
    ["focus",/input:focus\{border-color:(#[0-9a-f]{6})/,"#ffffff"],
    ["error",/input:user-invalid,input\[aria-invalid=true\]\{border-color:(#[0-9a-f]{6})/,"#ffffff"],
    ["disabled",/input:disabled\{border-color:(#[0-9a-f]{6})/,"#edf0f5"]
  ] as const) it(`retains a distinguishable ${state} input boundary`,() => {
    const css = readFileSync(new URL("../web/judge/style.css",import.meta.url),"utf8");
    const color = css.match(selector)?.[1];expect(color).toBeDefined();
    const luminance = (hex: string) => [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4).reduce((sum,v,i) => sum+v*[.2126,.7152,.0722][i]!,0);
    const a = luminance(color!),b = luminance(background);
    expect((Math.max(a,b)+.05)/(Math.min(a,b)+.05)).toBeGreaterThanOrEqual(3);
  });
  it("focuses the owned case heading after creation, detection after duplicate, and owner fields/toggle",async () => {
    const owned = scenario("run_owned");
    const ui = await mountJudge(call => {
      if (call.path === "/api/session") return session;
      if (call.path.endsWith("/duplicate")) owned.orders.push({ ...owned.orders[0]!,id: "duplicate" });
      return owned;
    });
    expect(ui.doc.activeElement).toBeNull();
    await ui.click("Start judge experience");expect(ui.doc.activeElement?.id).toBe("case-heading");
    await ui.click("Introduce duplicate");expect(ui.doc.activeElement).toBe(ui.button("Detect anomaly"));
    await ui.click("Owner access");expect(ui.doc.activeElement?.id).toBe("owner-email");
    await ui.click("Close owner sign-in");expect(ui.doc.activeElement?.id).toBe("owner-toggle");
    expect(ui.calls.filter(c => c.method === "POST")).toHaveLength(2);
  });
  it("focuses execution after approval and the receipt heading after successful execution",async () => {
    let approved = false,executed = false;
    const ui = await mountJudge(call => {
      if (call.path === "/api/session") return session;
      if (call.path.endsWith("/investigation")) return null;
      if (call.path.endsWith("/approve")) approved = true;
      if (call.path.endsWith("/execute")) executed = true;
      if (call.path.includes("/receipts/")) return receipt("SUCCEEDED",true);
      return { ...scenario("run_owned"),latestPlan: { ...plan,approved,has_receipt: executed } };
    },"run_owned");
    await ui.click("Approve this exact merchant-only plan");expect(ui.doc.activeElement).toBe(ui.button("Execute approved local repair"));
    await ui.click("Execute approved local repair");expect(ui.doc.activeElement?.id).toBe("receipt-heading");
    expect(ui.doc.root.querySelectorAll("button").some(b => /Exact plan approved|Execute approved/.test(b.textContent))).toBe(false);
    for (const name of ["Resume/Recheck Case","Recheck committed receipt","Export receipt and evidence"]) expect(ui.button(name).disabled).toBe(false);
    expect(ui.calls.filter(c => c.method === "POST").map(c => c.path.split("/").at(-1))).toEqual(["approve","execute"]);
  });
  for (const outcome of ["REJECTED","EXPIRED","SUCCEEDED"]) it(`keeps review controls for unverified ${outcome}`,async () => {
    const ui = await mountJudge(call => call.path === "/api/session" ? session : call.path.endsWith("/investigation") ? null : call.path.includes("/receipts/") ? receipt(outcome,false) : { ...scenario("run_owned"),latestPlan: plan },"run_owned");
    expect(ui.button("Review exact repair plan").disabled).toBe(false);expect(ui.button("Execute approved local repair").disabled).toBe(false);
    expect(ui.doc.root.textContent).toContain("Outcome needs review");expect(ui.calls.some(c => c.method === "POST")).toBe(false);
  });
  it("focuses the error announcement after a failed action without replay",async () => {
    const ui = await mountJudge(call => call.path === "/api/session" ? session : new Response('{}',{ status: 503 }));
    await ui.click("Start judge experience");expect(ui.doc.activeElement?.id).toBe("action-error");expect(ui.doc.activeElement?.getAttribute("role")).toBe("alert");
    expect(ui.calls.filter(c => c.method === "POST")).toHaveLength(1);
  });
});
