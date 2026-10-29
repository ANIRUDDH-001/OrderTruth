import { readFileSync } from "node:fs";
import { describe,expect,it } from "vitest";
import { SNAPSHOTS } from "../src/ai/ask-eval/catalog.ts";
import { evidenceReference } from "../src/ai/ask-eval/reference.ts";

const ids = (s: "PRE" | "POST") => SNAPSHOTS[s].map(f => f.id);
describe("frozen fact catalog",() => {
  it("states every checkable value it declares, verbatim, in the fact text",() => {
    for (const s of ["PRE","POST"] as const) for (const f of SNAPSHOTS[s]) for (const t of f.tokens) expect(f.text,`${s}/${f.id}`).toContain(t);
  });
  it("keeps shared facts identical across states except the three that change with the repair",() => {
    expect(ids("POST").filter(i => !ids("PRE").includes(i))).toEqual(["RECEIPT","PAYPAL_UNCHANGED"]);
    expect(ids("PRE").every(i => ids("POST").includes(i))).toBe(true);
    const changed = ids("PRE").filter(i => SNAPSHOTS.PRE.find(f => f.id === i)!.text !== SNAPSHOTS.POST.find(f => f.id === i)!.text);
    expect(changed.sort()).toEqual(["APPROVAL","ORD_B","ORD_COUNT"]);
  });
  it("names the product record behind every fact, and never uses post-execution records before the repair",() => {
    for (const s of ["PRE","POST"] as const) for (const f of SNAPSHOTS[s]) expect(f.source.length,`${s}/${f.id}`).toBeGreaterThan(10);
    for (const f of SNAPSHOTS.PRE) expect(f.source,`PRE/${f.id}`).not.toMatch(/repair_outcomes|merchant_order_voids|approved_at/);
    for (const id of ["RECEIPT","PAYPAL_UNCHANGED"]) expect(SNAPSHOTS.POST.find(f => f.id === id)!.source).toMatch(/repair_outcomes/);
    expect(SNAPSHOTS.POST.find(f => f.id === "ORD_B")!.source).toMatch(/merchant_order_voids/);
    expect(SNAPSHOTS.POST.find(f => f.id === "APPROVAL")!.source).toMatch(/approved_at/);
  });
  it("uses only well-formed evidence identifiers",() => {
    for (const s of ["PRE","POST"] as const) for (const f of SNAPSHOTS[s])
      expect(f.evidenceId,`${s}/${f.id}`).toMatch(/^(E\d+|M_run_[0-9a-f-]{36}|D_[0-9a-f-]{36}|rp_[0-9a-f-]{36}|POLICY)$/);
  });
  it("matches the committed evidence reference exactly",() => {
    expect(readFileSync(new URL("../docs/ASK_EVAL_EVIDENCE_REFERENCE.md",import.meta.url),"utf8")).toBe(evidenceReference());
  });
});
