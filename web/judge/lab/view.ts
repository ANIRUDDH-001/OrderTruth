import type { LabPageData } from "../../../scripts/lab-build.ts";
export function renderLab(doc: Document, data: LabPageData): void {
  const root = doc.querySelector<HTMLElement>("#app");
  if (!root) throw new Error("Integration Lab root unavailable");
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls = "") => {
    const node = doc.createElement(tag); node.textContent = text; node.className = cls; return node;
  };
  const link = (text: string, href: string, cls = "") => {
    const a = el("a", text, cls); a.href = href;
    if (href.startsWith("/lab/evidence/")) a.setAttribute("download", text);
    return a;
  };
  const panel = (heading: string, description = "") => { const s = el("section", "", "panel lab-panel"); s.append(el("h2", heading)); if (description) s.append(el("p", description, "muted")); return s; };
  const field = (label: string, value: string) => { const row = el("div", "", "record"); row.append(el("span", label), el("strong", value)); return row; };
  const table = (caption: string, columns: string[]) => {
    const wrap = el("div", "", "lab-table-wrap"), t = el("table"), head = el("thead"), row = el("tr"), body = el("tbody");
    for (const label of columns) { const th = el("th", label); th.setAttribute("scope", "col"); row.append(th); }
    head.append(row); t.append(el("caption", caption), head, body); wrap.append(t); return { wrap, body };
  };
  root.replaceChildren();
  const header = el("header"); header.append(link("OrderTruth", "/", "brand"), el("span", "Recorded integration evidence", "muted"), link("Back to judge experience", "/", "button secondary")); root.append(header);
  const main = el("main", "", "lab-main"); main.id = "workspace"; main.tabIndex = -1;
  const hero = el("div", "", "lab-hero");
  const title = el("div"); title.append(el("p", "V3 · REFERENCE INTEGRATION", "kicker"), el("h1", "Integration Lab"),
    el("p", "One race. A deterministic fix. Recorded evidence.", "lead"), el("p", data.proof.provenance.label));
  const badge = el("div", "", "lab-verdict"); badge.append(el("span", "GATE A", "kicker"), el("strong", "Fixed lab passed"),
    el("p", "Two matching accepted runs · P1 / T1"), el("p", "Locally reproduced · synthetic fixture", "muted")); hero.append(title, badge); main.append(hero);
  const boundary = el("aside", "", "provenance lab-boundary"); boundary.append(el("strong", "A lab proof, separate from the judge case"),
    el("p", "The original concurrency defect is an expected control failure. The reference fix is human-written; no applied AI migration patch was recorded."),
    el("p", "Not independently attested: build hashes establish consistency with recorded files, not proof that their execution was genuine.")); main.append(boundary);
  const first = data.proof.runs[0]!;
  const originalOrders = first.original.find(r => r.id === "L4")?.checks.find(c => c.name === "forced:one_matching_order")?.observed?.orders;
  const referenceOrders = first.reference.find(r => r.id === "L4")?.checks.find(c => c.name === "forced:one_matching_order")?.observed?.orders;
  const highlights = el("div", "", "lab-highlights");
  for (const [heading, result, detail] of [
    ["Original merchant", typeof originalOrders === "number" ? `${originalOrders} orders` : "Duplicate reproduced", "Expected failure · forced checkout/webhook race"],
    ["Reference fix", typeof referenceOrders === "number" ? `${referenceOrders} matching order` : "Order checks passed", "Forced race and eight-process stress passed"],
    ["Negative controls", `${first.negativeControls.length} caught`, "Every intended defect rejected in both runs"],
  ]) { const card = el("section", "", "panel lab-metric"); card.append(el("h2", heading), el("strong", result, "lab-number"), el("p", detail, "muted")); highlights.append(card); }
  main.append(highlights);

  for (const [index, run] of data.proof.runs.entries()) {
    const section = panel(`Repetition ${index + 1}`, run.runId);
    const ladder = table("Reference fix: every applicable rung", ["Rung", "Recorded result", "Evidence checks"]);
    for (const r of run.reference) {
      const tr = el("tr"), checks = el("td"), detail = el("details"); detail.append(el("summary", `${r.checks.length} recorded checks`));
      const list = el("ul"); for (const c of r.checks) list.append(el("li", `${c.name} · ${c.kind} · ${c.ok ? "PASS" : "FAIL"}`)); detail.append(list); checks.append(detail);
      const name = el("th", r.id); name.setAttribute("scope", "row"); tr.append(name, el("td", r.status, "lab-pass"), checks); ladder.body.append(tr);
    }
    section.append(ladder.wrap);
    const controls = table("Nine negative controls: rejected for their intended defect", ["Control", "Intended failing check", "Observed facts", "Observed result"]);
    for (const n of run.negativeControls) { const tr = el("tr"), name = el("th", n.id); name.setAttribute("scope", "row");
      const facts = n.result.checks.find(c => c.name === n.intended.check)?.observed;
      tr.append(name, el("td", `${n.intended.rung} / ${n.intended.check}`), el("td", JSON.stringify(facts ?? {})), el("td", n.observed)); controls.body.append(tr); }
    section.append(controls.wrap);
    if (index === 0) main.append(section); else { const folded = el("details", "", "panel lab-repeat"); folded.append(el("summary", "Inspect the second fresh repetition"), section); main.append(folded); }
  }
  const grid = el("div", "", "lab-grid");
  const identity = panel("What was verified", "Source identity is separate from the build publishing these files.");
  identity.append(field("Verified source commit S", data.proof.sourceCommit), field("Run", data.proof.runId), field("Origin", data.proof.candidate.origin),
    field("Migration diff", data.proof.candidate.diffStatus), field("Policy gate", data.proof.policyGate), field("Review", "Recorded Gate A PASS; not independently attested"));
  const publication = panel("Publication identity"); publication.append(field("Built from commit", data.build.commit ?? "Unavailable"),
    field("Build state", data.build.dirty ? "Uncommitted preview" : "Clean publication build"), field("Public source", "Public source availability not verified"),
    field("Publication manifest SHA-256", data.publication.manifestSha256));
  if (data.build.snapshotSha256) publication.append(field("W1 validation source snapshot", data.build.snapshotSha256));
  grid.append(identity, publication); main.append(grid);
  const coverage = panel("Exercised paths and runtime", "These are known V-A lab paths, not a discovery of every merchant path.");
  for (const p of data.proof.coverage.paths) coverage.append(field(p.pathId, p.tier));
  coverage.append(field("Historical coverage", data.proof.coverage.historical), field("Candidate / controller", `${data.proof.environment.candidateNode} / ${data.proof.environment.controllerNode}`),
    field("PostgreSQL", data.proof.environment.postgresVersion)); main.append(coverage);
  const limitations = panel("Limits of this result"); const list = el("ul"); for (const text of data.proof.limitations) list.append(el("li", text)); limitations.append(list); main.append(limitations);
  const evidence = panel("Inspect the recorded evidence", "Each download is a static file checked by this build. No code or payment operation runs here.");
  evidence.append(field("Verifier manifest", data.proof.environment.manifestSha256), field("Guard subject", data.proof.environment.subjectSha256!));
  const manifestRow = el("div", "", "record");
  manifestRow.append(link("manifest.json", "/lab/evidence/manifest.json"), el("span", data.publication.manifestSha256, "lab-hash")); evidence.append(manifestRow);
  for (const f of data.publication.files) { const row = el("div", "", "record"); row.append(link(f.file, `/lab/evidence/${f.file}`), el("span", f.sha256, "lab-hash")); evidence.append(row); }
  const images = el("details"); images.append(el("summary", "Historical Gate A image identities")); for (const [name, id] of Object.entries(data.proof.environment.images)) images.append(field(name, id)); evidence.append(images); main.append(evidence);
  const reproduce = panel("Reproduce from a local checkout", "Public source availability is not verified. These instructions assume you already have this repository and the verified commit; they do not claim that a public clone is currently available.");
  reproduce.append(el("pre", `git checkout ${data.proof.sourceCommit}\npnpm install --frozen-lockfile\npnpm v3:verify:gate-a`), el("p", "Use Node 22.18.0, pnpm 11.4.0 and Docker's Linux engine. The disposable verifier runs two repetitions and must finish with accepted results and cleanup PASS.", "muted")); main.append(reproduce);
  root.append(main, el("footer", "Independent OrderTruth prototype · Synthetic integration verification and genuine PayPal Sandbox observation are separate evidence sources."));
}
