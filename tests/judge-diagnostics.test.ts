import { afterEach,describe,expect,it,vi } from "vitest";
import { describeHandlerTiming } from "../web/judge/diagnostics.ts";
import { mountJudge,scenario,type JudgeNode } from "./helpers/judge-dom.ts";

afterEach(async () => { if (vi.isFakeTimers()) await vi.runAllTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

// Recorded on the hosted judge, run_a9ef2c36-1eb1-492b-9662-5eb656cca492, 2026-10-29.
const NOTE = "Recorded intervals describe controlled handlers; they do not establish PayPal concurrency.";
const live = { id: "D_d1e84a0b-e2b1-4956-a870-74ab5e2970e6",source: "MERCHANT_DIAGNOSTIC",observedAt: "2026-10-29T06:12:34.805Z",facts: {
  diagnostic: "HANDLER_TIMING",clockPrecision: "MILLISECOND",note: NOTE,entries: [
    { handler: "capture_return",startedAt: "2026-10-29T06:11:34.478Z",finishedAt: "2026-10-29T06:11:34.511Z",durationMs: 33,merchantOrderId: "mo_5fc89787-f051-4521-901a-aa4c4ac54ac2" },
    { handler: "webhook_capture_completed",startedAt: "2026-10-29T06:11:51.125Z",finishedAt: "2026-10-29T06:11:51.141Z",durationMs: 16,merchantOrderId: "mo_1d9841c0-2f9b-494e-affd-3e3355364997" }] } };
const entry = (handler: string,order: string,start: string,finish: string,durationMs: number) =>
  ({ handler,merchantOrderId: order,startedAt: `2026-10-29T06:00:${start}Z`,finishedAt: `2026-10-29T06:00:${finish}Z`,durationMs });
const timing = (entries: unknown,clockPrecision: unknown = "MILLISECOND") => ({ diagnostic: "HANDLER_TIMING",clockPrecision,note: NOTE,entries });
// The generated summary must state only what the intervals show, never why the duplicate exists.
const UNSUPPORTED = /\b(race|concurren\w*|caus\w*|because|retr(y|ies|ied)|latenc\w*|late|delay\w*|paypal)\b/i;
const CONTROLLED = 'Controlled case: the duplicate write runs when "Introduce duplicate" is pressed. Any gap between writes reflects when it was pressed, not real webhook delivery latency.';
const FALLBACK = "Timing values could not be read; see the recorded evidence below.";

describe("handler timing summary",() => {
  it("reports the live case: ordered rows, durations, no overlap, 16.6 s gap, different handlers",() => {
    const result = describeHandlerTiming(live.facts,true);
    expect(result.rows).toEqual([
      { orderId: "mo_5fc89787-f051-4521-901a-aa4c4ac54ac2",handler: "capture_return",startedAt: "2026-10-29T06:11:34.478Z",finishedAt: "2026-10-29T06:11:34.511Z",durationMs: 33 },
      { orderId: "mo_1d9841c0-2f9b-494e-affd-3e3355364997",handler: "webhook_capture_completed",startedAt: "2026-10-29T06:11:51.125Z",finishedAt: "2026-10-29T06:11:51.141Z",durationMs: 16 }]);
    expect(result.observations).toEqual([
      "The two recorded writes did not overlap. The second started 16.6 s after the first finished.",
      "They came from different handlers: capture_return and webhook_capture_completed."]);
    expect(result.limitations).toContain(CONTROLLED);
    expect(result.limitations).toContain(`Recorded note: "${NOTE}"`);
  });
  it("orders rows by start time regardless of input order",() => {
    const result = describeHandlerTiming(timing([entry("b","o2","01.000","01.010",10),entry("a","o1","00.000","00.020",20)]),false);
    expect(result.rows.map(r => r.orderId)).toEqual(["o1","o2"]);
    expect(result.observations[0]).toBe("The two recorded writes did not overlap. The second started 980 ms after the first finished.");
  });
  it("reports overlap in milliseconds",() => {
    const result = describeHandlerTiming(timing([entry("a","o1","00.000","00.100",100),entry("b","o2","00.040","00.090",50)]),false);
    expect(result.observations[0]).toBe("The two recorded writes overlapped by 50 ms.");
  });
  it("reports a zero-length write inside another as overlapping without inventing an amount",() => {
    const result = describeHandlerTiming(timing([entry("a","o1","00.000","00.100",100),entry("b","o2","00.050","00.050",0)]),false);
    expect(result.observations[0]).toBe("The two recorded writes overlapped.");
  });
  it("does not decide overlap when intervals touch at the clock's precision",() => {
    const result = describeHandlerTiming(timing([entry("a","o1","00.000","00.100",100),entry("b","o2","00.100","00.150",50)]),false);
    expect(result.observations[0]).toBe("The second started in the same millisecond the first finished, so overlap can't be determined at this precision.");
  });
  it("counts overlapping pairs across three writes, including non-adjacent ones",() => {
    const result = describeHandlerTiming(timing([entry("a","o1","00.000","00.500",500),entry("b","o2","00.100","00.200",100),entry("a","o3","00.300","00.400",100)]),false);
    expect(result.observations).toEqual(["Of 3 recorded writes, 2 pairs overlapped.","They came from 2 different handlers: a and b."]);
  });
  it("reports touching pairs among three writes as undetermined, not as non-overlapping",() => {
    const result = describeHandlerTiming(timing([entry("a","o1","00.000","00.100",100),entry("b","o2","00.100","00.200",100),entry("c","o3","00.500","00.600",100)]),false);
    expect(result.observations[0]).toBe("Of 3 recorded writes, 0 pairs overlapped; 1 pair started in the same millisecond another finished, so its overlap can't be determined.");
  });
  it("says when both writes came from the same handler",() => {
    const result = describeHandlerTiming(timing([entry("a","o1","00.000","00.010",10),entry("a","o2","00.500","00.510",10)]),false);
    expect(result.observations[1]).toBe("Both came from the same handler: a.");
  });
  it("has nothing to compare with one write",() => {
    const result = describeHandlerTiming(timing([entry("a","o1","00.000","00.010",10)]),false);
    expect(result.rows).toHaveLength(1);
    expect(result.observations).toEqual(["Only one recorded write, so there is nothing to compare."]);
  });
  it("does not compute overlap when the clock precision is not milliseconds",() => {
    for (const precision of ["SECOND",undefined]) {
      const result = describeHandlerTiming({ ...timing([entry("a","o1","00.000","00.010",10),entry("b","o2","00.005","00.020",15)]),clockPrecision: precision },false);
      expect(result.rows).toHaveLength(2);
      expect(result.observations[0]).toBe(`Clock precision is ${precision === undefined ? "not recorded" : "SECOND"}, so overlap is not computed.`);
    }
  });
  for (const [name,facts] of [
    ["missing entries",{ diagnostic: "HANDLER_TIMING",clockPrecision: "MILLISECOND" }],
    ["entries that are not a list",timing("two")],
    ["an unparseable time",timing([entry("a","o1","00.000","00.010",10),{ ...entry("b","o2","00.020","00.030",10),startedAt: "yesterday" }])],
    ["a finish before its start",timing([entry("a","o1","00.050","00.010",-40)])],
    ["a recorded duration that disagrees with its times",timing([entry("a","o1","00.000","00.033",30)])],
    ["a missing handler",timing([{ ...entry("a","o1","00.000","00.010",10),handler: undefined }])],
    ["a missing order",timing([{ ...entry("a","o1","00.000","00.010",10),merchantOrderId: "" }])]
  ] as const) it(`falls back without computed results for ${name}`,() => {
    const result = describeHandlerTiming(facts as Record<string,unknown>,true);
    expect(result.rows).toEqual([]);
    expect(result.observations).toEqual([]);
    expect(result.limitations[0]).toBe(FALLBACK);
  });
  it("shows the controlled-case disclosure only for controlled runs",() => {
    expect(describeHandlerTiming(live.facts,true).limitations).toContain(CONTROLLED);
    expect(describeHandlerTiming(live.facts,false).limitations).not.toContain(CONTROLLED);
  });
  it("never states a cause in any generated summary",() => {
    const cases = [live.facts,timing([entry("a","o1","00.000","00.100",100),entry("b","o2","00.040","00.090",50)]),
      timing([entry("a","o1","00.000","00.100",100),entry("b","o2","00.100","00.150",50)]),timing([entry("a","o1","00.000","00.010",10)]),
      timing([entry("a","o1","00.000","00.010",10),entry("b","o2","00.005","00.020",15)],"SECOND"),timing("bad")];
    for (const facts of cases) for (const controlled of [true,false]) for (const line of describeHandlerTiming(facts,controlled).observations) expect(line).not.toMatch(UNSUPPORTED);
  });
});

const session = { authenticated: true,userId: "fixture_owner",owner: false };
const analysis = (next: string) => ({ status: "FRESH",freshModelExecution: true,reason: null,generatedAt: "2026-10-29T06:12:15.000Z",model: "fixture-model",evidence: [],
  baseline: { summary: "Rules-based guidance",nextDiagnostic: next },
  investigation: { summary: "Two orders reference one payment.",nextDiagnostic: next,diagnosticReason: "Check the recorded writes.",
    hypotheses: [{ explanation: "A race between handlers or client retries may explain the second order.",evidenceIds: ["E5"],confidence: "MEDIUM",status: "HYPOTHESIS" }] } });
const find = (node: JudgeNode,match: (n: JudgeNode) => boolean): JudgeNode[] => [...(match(node) ? [node] : []),...node.children.flatMap(c => find(c,match))];
async function runDiagnostic(evidence: unknown,next = "HANDLER_TIMING") {
  const ui = await mountJudge(call => {
    if (call.path === "/api/session") return session;
    if (call.path.endsWith("/investigation")) return null;
    if (call.path.endsWith("/investigate")) return analysis(next);
    if (call.path.endsWith("/diagnostics")) return evidence;
    return scenario("run_owned");
  },"run_owned");
  await ui.click("Investigate with AI");
  await ui.click(next === "HANDLER_TIMING" ? "Run handler timing check" : "Run idempotency-key comparison");
  return ui;
}

describe("judge timing diagnostic view",() => {
  it("shows the recorded intervals as a table with the generated summary, disclosure, note and raw evidence",async () => {
    const ui = await runDiagnostic(live);
    const [table] = find(ui.doc.root,n => n.tag === "table");
    expect(table).toBeDefined();
    expect(find(table!,n => n.tag === "caption")[0]?.textContent).toBe("When each recorded merchant write ran");
    // One column per write (ordered by start) so the table fits the narrow investigation panel.
    expect(find(table!,n => n.tag === "thead").flatMap(h => find(h,n => n.tag === "th")).map(n => [n.textContent,n.getAttribute("scope")])).toEqual([["Write 1","col"],["Write 2","col"]]);
    const rows = find(table!,n => n.tag === "tbody").flatMap(b => find(b,n => n.tag === "tr"));
    expect(rows.map(r => find(r,n => n.tag === "th").map(n => [n.textContent,n.getAttribute("scope")])[0])).toEqual(
      [["Order","row"],["Written by","row"],["Started","row"],["Finished","row"],["Took","row"]]);
    const cells = rows.map(r => find(r,n => n.tag === "td"));
    expect(cells[0]!.map(c => [c.textContent,c.getAttribute("title")])).toEqual([["mo_5fc89787…","mo_5fc89787-f051-4521-901a-aa4c4ac54ac2"],["mo_1d9841c0…","mo_1d9841c0-2f9b-494e-affd-3e3355364997"]]);
    expect(cells[1]!.map(c => c.textContent)).toEqual(["capture_return","webhook_capture_completed"]);
    expect(cells[2]!.map(c => c.getAttribute("title"))).toEqual(["2026-10-29T06:11:34.478Z","2026-10-29T06:11:51.125Z"]);
    expect(cells[3]!.map(c => c.getAttribute("title"))).toEqual(["2026-10-29T06:11:34.511Z","2026-10-29T06:11:51.141Z"]);
    expect(cells[4]!.map(c => c.textContent)).toEqual(["33 ms","16 ms"]);
    const summary = find(ui.doc.root,n => n.className === "timing-observations")[0]!.textContent;
    expect(summary).toContain("The two recorded writes did not overlap. The second started 16.6 s after the first finished.");
    // Scoped check: the AI hypothesis on the same page legitimately says "race" and "retries".
    expect(summary).not.toMatch(UNSUPPORTED);
    expect(ui.doc.root.textContent).toMatch(/race between handlers or client retries/);
    const limits = find(ui.doc.root,n => n.className === "timing-limitations")[0]!.textContent;
    expect(limits).toContain(CONTROLLED);
    expect(limits).toContain(`Recorded note: "${NOTE}"`);
    expect(find(ui.doc.root,n => n.tag === "summary").map(n => n.textContent)).toContain("HANDLER_TIMING · D_d1e84a0b-e2b1-4956-a870-74ab5e2970e6");
  });
  it("shows the safe fallback and keeps the raw evidence when timestamps are malformed",async () => {
    const broken = { ...live,facts: { ...live.facts,entries: [{ ...live.facts.entries[0]!,startedAt: "not a time" },live.facts.entries[1]!] } };
    const ui = await runDiagnostic(broken);
    expect(find(ui.doc.root,n => n.tag === "table")).toEqual([]);
    expect(find(ui.doc.root,n => n.className === "timing-observations")[0]?.textContent ?? "").toBe("");
    expect(find(ui.doc.root,n => n.className === "timing-limitations")[0]!.textContent).toContain(FALLBACK);
    expect(find(ui.doc.root,n => n.tag === "summary").map(n => n.textContent)).toContain("HANDLER_TIMING · D_d1e84a0b-e2b1-4956-a870-74ab5e2970e6");
  });
  it("leaves the idempotency-key diagnostic summary unchanged",async () => {
    const ui = await runDiagnostic({ id: "D_keys",source: "MERCHANT_DIAGNOSTIC",observedAt: "2026-10-29T06:12:40.000Z",
      facts: { diagnostic: "IDEMPOTENCY_KEYS",distinctKeys: 2,entries: [],scope: "CONTROLLED_MERCHANT_HANDLERS" } },"IDEMPOTENCY_KEYS");
    expect(ui.doc.root.textContent).toContain("2 distinct merchant write keys observed. Separate keys can allow duplicate writes.");
    expect(find(ui.doc.root,n => n.tag === "table")).toEqual([]);
  });
});
