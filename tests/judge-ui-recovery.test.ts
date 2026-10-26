import { afterEach,describe,expect,it,vi } from "vitest";
import { mountJudge,scenario } from "./helpers/judge-dom.ts";

const session = { authenticated: true,userId: "original_user",owner: false };
const denied = () => new Response('{"error":"Scenario not found"}',{ status: 404 });
afterEach(async () => { await vi.runAllTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

describe("judge combined recovery transitions",() => {
  it("requires reconciliation after foreign case -> owned creation -> uncertain mutation",async () => {
    let created = 0;const owned = scenario("run_owned");
    const ui = await mountJudge(call => {
      if (call.path === "/api/session") return session;
      if (call.path === "/api/scenarios" && call.method === "POST") { created++; return owned; }
      if (call.path.endsWith("/duplicate")) { owned.orders.push({ ...owned.orders[0]!,id: "duplicate" }); return new Response('{"error":"Outcome uncertain"}',{ status: 503 }); }
      if (call.path === "/api/scenarios/run_foreign") return denied();
      if (call.path.endsWith("/investigation")) return null;
      return owned;
    },"run_foreign");
    await ui.click("Start a new isolated case"); await ui.click("Introduce duplicate");
    expect(created).toBe(1); expect(ui.button("Start a new isolated case").disabled).toBe(true);
    const mark = ui.calls.length;await ui.click("Resume/Recheck Case");
    expect(ui.calls.slice(mark).every(c => c.method === "GET")).toBe(true);
    expect(ui.calls.slice(mark).some(c => c.path === "/api/scenarios/run_owned")).toBe(true);
    expect(ui.location.href).toContain("run_owned"); expect(ui.button("Start a new isolated case").disabled).toBe(false);
    expect(ui.calls.filter(c => c.path.endsWith("/duplicate"))).toHaveLength(1);
  });
  it("does not clear pending mutation uncertainty when reconciliation gets 404",async () => {
    let lost = false;const ui = await mountJudge(call => {
      if (call.path === "/api/session") return session;
      if (call.path.endsWith("/investigation")) return null;
      if (call.path.endsWith("/duplicate")) { lost = true;throw new TypeError("Lost response"); }
      return lost ? denied() : scenario("run_owned");
    },"run_owned");
    await ui.click("Introduce duplicate");await ui.click("Resume/Recheck Case");
    expect(ui.location.href).toContain("run_owned");expect(ui.button("Start a new isolated case").disabled).toBe(true);
    expect(ui.calls.filter(c => c.method === "POST")).toHaveLength(1);
  });
  it("retains the affected mutation run across reload and a 404",async () => {
    const storage = new Map<string,string>();
    const first = await mountJudge(call => call.path === "/api/session" ? session : call.path.endsWith("/investigation") ? null : call.path.endsWith("/duplicate") ? new Response('{}',{ status: 503 }) : scenario("run_owned"),"run_owned",storage);
    await first.click("Introduce duplicate");
    const reload = await mountJudge(call => call.path === "/api/session" ? session : denied(),"run_owned",storage);
    expect(reload.location.href).toContain("run_owned");expect(reload.button("Start a new isolated case").disabled).toBe(true);
    expect(reload.calls.filter(c => c.method === "POST")).toHaveLength(0);
  });
  for (const value of [{},null,{ run: { id: "run_partial" } },{ ...scenario("run_partial"),paymentReference: null }]) {
    it(`keeps recovery controls for malformed creation ${JSON.stringify(value)}`,async () => {
      const ui = await mountJudge(call => call.path === "/api/session" ? session : value);
      await ui.click("Start judge experience");expect(ui.button("Resume/Recheck Case").disabled).toBe(false);
      expect(ui.doc.root.textContent).toMatch(/creation.*uncertain/i);expect(ui.button("Start judge experience").disabled).toBe(true);
      await ui.click("Resume/Recheck Case");expect(ui.doc.root.textContent).toMatch(/cannot.*(locate|reconcile)/i);
      expect(ui.button("Start judge experience").disabled).toBe(true);expect(ui.calls.filter(c => c.method === "POST")).toHaveLength(1);
      expect(new URL(ui.location.href).searchParams.has("run")).toBe(false);
    });
  }
  it("cannot clear unidentified creation by rechecking an older valid case",async () => {
    const ui = await mountJudge(call => call.path === "/api/session" ? session : call.path === "/api/scenarios" ? {} : call.path.endsWith("/investigation") ? null : scenario("run_old"),"run_old");
    await ui.click("Start a new isolated case");await ui.click("Resume/Recheck Case");
    expect(ui.location.href).toContain("run_old");expect(ui.doc.root.textContent).toMatch(/cannot.*(locate|reconcile)/i);
    expect(ui.button("Start a new isolated case").disabled).toBe(true);expect(ui.calls.filter(c => c.method === "POST")).toHaveLength(1);
  });
  it("retains an unidentified creation warning across reload without another POST",async () => {
    const storage = new Map<string,string>();
    const first = await mountJudge(call => call.path === "/api/session" ? session : {},"",storage);await first.click("Start judge experience");
    const reload = await mountJudge(() => session,"",storage);
    expect(reload.doc.root.textContent).toMatch(/cannot.*(locate|reconcile)/i);expect(reload.button("Start judge experience").disabled).toBe(true);
    expect(reload.calls.filter(c => c.method === "POST")).toHaveLength(0);
  });
  it("keeps failed creation after a foreign case blocked even after read-only recheck",async () => {
    const ui = await mountJudge(call => call.path === "/api/session" ? session : call.path === "/api/scenarios" ? new Response('{"error":"Unknown outcome"}',{ status: 503 }) : denied(),"run_foreign");
    await ui.click("Start a new isolated case");await ui.click("Resume/Recheck Case");
    expect(ui.button("Start a new isolated case").disabled).toBe(true);expect(ui.location.href).toContain("run_foreign");
    expect(ui.calls.filter(c => c.method === "POST")).toHaveLength(1);
  });
  for (const fails of [false,true]) {
    it(`preserves the active owner form when history ${fails ? "fails" : "completes"}`,async () => {
      let complete!: (value: unknown) => void;
      const history = new Promise(resolve => { complete = resolve; });
      const ui = await mountJudge(call => call.path === "/api/session" ? session : call.path.endsWith("/investigation") ? history : scenario("run_owned"),"run_owned");
      await ui.click("Owner access");const email = ui.doc.querySelector("#owner-email")!,password = ui.doc.querySelector("#owner-password")!;
      const labels = ui.doc.root.querySelectorAll("label");
      email.value = "synthetic@example.invalid";password.value = "FIXTURE_ONLY";password.selectionStart = 2;password.selectionEnd = 5;password.focus();
      complete(fails ? new Response('{"error":"Unavailable"}',{ status: 503 }) : null);await vi.advanceTimersByTimeAsync(fails ? 9000 : 0);
      expect(ui.doc.querySelector("#owner-email")).toBe(email);expect(ui.doc.querySelector("#owner-password")).toBe(password);
      expect(email.value).toBe("synthetic@example.invalid");expect(password.value).toBe("FIXTURE_ONLY");expect(ui.doc.activeElement).toBe(password);
      expect(password.selectionStart).toBe(2);expect(password.selectionEnd).toBe(5);
      expect(ui.doc.root.querySelectorAll("label").every((label,index) => label === labels[index])).toBe(true);expect(email.required && password.required).toBe(true);
      expect(ui.calls.some(c => c.method === "POST")).toBe(false);
    });
  }
  it("does not replace the investigation control that owns focus during history completion",async () => {
    let complete!: (value: unknown) => void;const history = new Promise(resolve => { complete = resolve; });
    const ui = await mountJudge(call => call.path === "/api/session" ? session : call.path.endsWith("/investigation") ? history : scenario("run_owned"),"run_owned");
    const control = ui.button("Investigate with AI");control.focus();complete(null);await vi.advanceTimersByTimeAsync(0);
    expect(ui.button("Investigate with AI")).toBe(control);expect(ui.doc.activeElement).toBe(control);
    expect(ui.calls.filter(c => c.method === "POST")).toHaveLength(0);
  });
});
