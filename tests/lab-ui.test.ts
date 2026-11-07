import { afterEach, describe, expect, it, vi } from "vitest";
import { mountJudge } from "./helpers/judge-dom.ts";
import { fixturePublication } from "./helpers/lab-publication.ts";
import { renderLab } from "../web/judge/lab/view.ts";
import { LAB_LABEL } from "../packages/assurance/src/lab-record.ts";
import type { LabPageData } from "../scripts/lab-build.ts";
afterEach(async () => { if (vi.isFakeTimers()) await vi.runAllTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });
async function page() {
  const ui = await mountJudge(() => ({ authenticated: false }));
  const p = fixturePublication();
  const data: LabPageData = { proof: p.proof, publication: { manifestSha256: "f".repeat(64), files: p.manifest.files, sourceAvailability: "NOT_VERIFIED" }, build: { commit: "e".repeat(40), dirty: true } };
  return { ui, data };
}
describe("Integration Lab view", () => {
  it("leads with a case study and keeps technical evidence in one optional closed disclosure", async () => {
    const { ui, data } = await page(); renderLab(ui.doc as unknown as Document, data);
    const technical = ui.doc.root.querySelector("#technical-verification");
    expect(technical).not.toBeNull(); expect(technical!.getAttribute("open")).toBeNull();
    expect(technical!.querySelector("summary")!.textContent).toBe("Technical Verification");
    const text = ui.doc.root.textContent;
    for (const label of ["One payment. Two orders. One preventable race.", "Before the fix", "After the reference fix", "How the reference fix works", "What this evidence establishes", "Recorded experiment", "Checked by this build", "Not tested"]) expect(text).toContain(label);
    expect(technical!.querySelectorAll("table").length).toBeGreaterThanOrEqual(2);
    for (const a of ui.doc.root.querySelectorAll("a").filter(a => (a as unknown as HTMLAnchorElement).href.startsWith("/lab/evidence/"))) expect(technical!.contains(a)).toBe(true);
    expect(technical!.textContent).toContain("Forced checkout and webhook race");
    for (const li of ui.doc.root.querySelectorAll("li")) expect(li.textContent.trim().length).toBeGreaterThan(4);
  });
  it("labels real record provenance, expected original failure, nine controls, limits and local publication without API calls", async () => {
    const { ui, data } = await page(); const calls = ui.calls.length;
    renderLab(ui.doc as unknown as Document, data);
    const text = ui.doc.root.textContent;
    for (const expected of ["Integration Lab", LAB_LABEL, "Expected failure", "NC1", "NC12", "DATA_MODIFYING_CTE", "T1", "checkout_return", "webhook", "NOT_RECORDED_GATE_A", "Not independently attested", "Uncommitted preview", "Public source availability not verified"])
      expect(text).toContain(expected);
    expect(ui.doc.root.querySelectorAll("table").length).toBeGreaterThanOrEqual(2);
    expect(ui.doc.root.querySelectorAll("button")).toHaveLength(0);
    expect(ui.calls).toHaveLength(calls);
    expect(ui.doc.root.querySelectorAll("a").some(a => (a as unknown as HTMLAnchorElement).href === "/")).toBe(true);
  });
  it("offers the publication manifest alongside every hashed artifact", async () => {
    const { ui, data } = await page();
    renderLab(ui.doc as unknown as Document, data);
    const links = ui.doc.root.querySelectorAll("a").map(a => (a as unknown as HTMLAnchorElement).href);
    expect(links).toContain("/lab/evidence/manifest.json");
    for (const f of data.publication.files) expect(links).toContain(`/lab/evidence/${f.file}`);
    const downloads = ui.doc.root.querySelectorAll("a").filter(a => (a as unknown as HTMLAnchorElement).href.startsWith("/lab/evidence/"));
    expect(downloads).toHaveLength(data.publication.files.length + 1);
    for (const a of downloads) expect(a.getAttribute("download")).toBe(a.textContent);
    expect(ui.doc.root.textContent).toContain(data.publication.manifestSha256);
  });
  it("renders a markup-like limitation as text", async () => {
    const { ui, data } = await page(); const unsafe = '<script>throw "unexpected"</script>';
    const mutable = structuredClone(data); (mutable.proof.limitations as string[]).push(unsafe);
    renderLab(ui.doc as unknown as Document, mutable);
    expect(ui.doc.root.textContent).toContain(unsafe); expect(ui.doc.root.querySelectorAll("script")).toHaveLength(0);
  });
  it("adds ordinary judge navigation without changing session reads", async () => {
    const { ui } = await page();
    expect(ui.doc.root.querySelectorAll("a").some(a => a.textContent === "Integration Lab" && (a as unknown as HTMLAnchorElement).href === "/lab/")).toBe(true);
    expect(ui.calls.every(c => c.method === "GET")).toBe(true);
  });
});
