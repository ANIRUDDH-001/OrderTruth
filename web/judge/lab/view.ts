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
  const hero = el("section", "", "lab-hero");
  hero.append(el("p", "Integration Lab", "kicker"), el("h1", "One payment. Two orders. One preventable race."),
    el("p", "A recorded case study of duplicate merchant orders, and the reference fix tested against them.", "lead"),
    el("p", "A buyer returns from checkout while a payment notification arrives. If both paths create an order independently, one payment can lead to two merchant orders. The payment record alone cannot prevent that merchant-side mistake.")); main.append(hero);
  const boundary = el("aside", "", "provenance lab-boundary"); boundary.append(el("strong", "A lab proof, separate from the judge case"),
    el("p", "The original concurrency defect is an expected control failure. The reference fix is human-written; no applied AI migration patch was recorded."),
    el("p", "Not independently attested: build hashes establish consistency with recorded files, not proof that their execution was genuine.")); main.append(boundary);
  const first = data.proof.runs[0]!;
  const originalOrders = first.original.find(r => r.id === "L4")?.checks.find(c => c.name === "forced:one_matching_order")?.observed?.orders;
  const referenceOrders = first.reference.find(r => r.id === "L4")?.checks.find(c => c.name === "forced:one_matching_order")?.observed?.orders;
  const highlights = el("div", "", "lab-comparison");
  for (const [heading, result, detail] of [
    ["Before the fix", typeof originalOrders === "number" ? `${originalOrders} orders` : "Count not recorded", "Expected failure: the simulated checkout-return and webhook race creates duplicate merchant orders."],
    ["After the reference fix", typeof referenceOrders === "number" ? `${referenceOrders} matching order` : "Count not recorded", "Recorded result: the same forced race and an eight-process stress test retain one matching merchant order."],
  ]) { const card = el("section", "", `lab-outcome ${heading === "Before the fix" ? "lab-before" : "lab-after"}`); card.append(el("h2", heading), el("strong", result, "lab-number"), el("p", detail)); highlights.append(card); }
  main.append(highlights);

  const explanation = panel("How the reference fix works", "Both tested order-writing paths use the same guarded operation instead of making separate decisions.");
  const steps = el("ol", "", "lab-steps");
  for (const [title, description] of [
    ["Agree on the payment identity", "The guard checks the capture evidence against the intended merchant order. A different payment or amount must not silently reuse it."],
    ["Claim the order once", "The checkout return and payment notification compete for the same database-backed claim. The claim and merchant order are committed together."],
    ["Reuse the matching order", "A repeated call returns the existing matching result. If a commit outcome is uncertain, recovery checks durable evidence before deciding what happened."],
  ]) { const item = el("li"); item.append(el("strong", title), el("p", description)); steps.append(item); }
  explanation.append(steps, el("p", "This is a human-written reference implementation for the two tested Lab paths. It does not capture or refund money, and it is not a guard installed in the live merchant recovery database.", "muted")); main.append(explanation);

  const status = panel("What this evidence establishes", "Reading this page does not execute the experiment again.");
  const confidence = table("Evidence and its limits", ["Evidence boundary", "What it establishes"]);
  for (const [label, detail] of [
    ["Recorded experiment", "Two accepted historical repetitions report the duplicate before the fix, one matching order after it, and rejection of all nine deliberately defective controls. Execution is not independently attested."],
    ["Checked by this build", "The publication files match their pinned identities. The build validates their structure, recomputes qualification and checks agreement between the reports, summary and cleanup record."],
    ["Not tested", "Production deployment, every possible merchant path, arbitrary hostile or AI-generated code, and exactly-once effects outside this database are not established. The Lab does not demonstrate AI superiority."],
  ]) { const row = el("tr"), name = el("th", label); name.setAttribute("scope", "row"); row.append(name, el("td", detail)); confidence.body.append(row); }
  status.append(confidence.wrap); main.append(status);
  const provenance = panel("Synthetic Lab evidence. Genuine Sandbox observations.", "This Lab uses synthetic PayPal-shaped fixtures; no PayPal data or new payment is involved. The main merchant journey separately investigates stored genuine PayPal Sandbox observations and verifies human-approved local recovery.");
  provenance.append(el("p", "A successful Lab test does not establish a new Sandbox capture, natural webhook delivery or a fresh provider readback. Return to the merchant experience to investigate your own private case."), link("Return to merchant investigation", "/", "button secondary")); main.append(provenance);

  const technical = el("details", "", "lab-technical"); technical.id = "technical-verification";
  technical.append(el("summary", "Technical Verification"), el("p", "Optional: named checks, negative controls, source identities, original JSON artifacts and reproduction instructions. All historical evidence is preserved.", "muted"));
  const rungNames: Record<string, string> = { L0: "Runtime and isolation prerequisites", L1: "One matching order and supported evidence", L3: "Repeated requests reuse the matching order", L4: "Forced checkout and webhook race", L5: "Crash before commit and safe retry", L7: "Different payment identities remain separate", L9: "Conflicting payment facts are refused", L21: "Uncertain commit and restart recovery", L22: "Separate events and installations", AUTH: "Test authority cannot authorize live writes" };
  const checkName = (name: string) => name.replace(/_/g, " ").replace(/:/g, " · ");

  for (const [index, run] of data.proof.runs.entries()) {
    const section = panel(`Repetition ${index + 1}`, run.runId);
    const ladder = table("Reference fix: named verification checks", ["Verification", "Recorded outcome", "Supporting checks"]);
    for (const r of run.reference) {
      const tr = el("tr"), checks = el("td"), detail = el("details"); detail.append(el("summary", `${r.checks.length} recorded checks`));
      const list = table("Supporting check outcomes", ["Check", "Outcome", "Evidence source"]);
      for (const c of r.checks) { const row = el("tr"); row.append(el("td", checkName(c.name)), el("td", c.ok ? "PASS" : "FAIL"), el("td", checkName(c.kind))); list.body.append(row); }
      detail.append(list.wrap); checks.append(detail);
      const name = el("th", `${rungNames[r.id] ?? r.id} (${r.id})`); name.setAttribute("scope", "row"); tr.append(name, el("td", r.status, r.status === "PASS" ? "lab-pass" : ""), checks); ladder.body.append(tr);
    }
    section.append(ladder.wrap);
    const controls = table("Nine negative controls: rejected for their intended defect", ["Control", "Intended failing check", "Observed facts", "Observed result"]);
    for (const n of run.negativeControls) { const tr = el("tr"), name = el("th", n.id); name.setAttribute("scope", "row");
      const facts = n.result.checks.find(c => c.name === n.intended.check)?.observed;
      tr.append(name, el("td", `${n.intended.rung} / ${n.intended.check}`), el("td", JSON.stringify(facts ?? {})), el("td", n.observed)); controls.body.append(tr); }
    section.append(controls.wrap);
    if (index === 0) technical.append(section); else { const folded = el("details", "", "panel lab-repeat"); folded.append(el("summary", "Inspect the second recorded repetition"), section); technical.append(folded); }
  }
  const grid = el("div", "", "lab-grid");
  const identity = panel("What was verified", "Source identity is separate from the build publishing these files.");
  identity.append(field("Verified source commit S", data.proof.sourceCommit), field("Run", data.proof.runId), field("Origin", data.proof.candidate.origin),
    field("Migration diff", data.proof.candidate.diffStatus), field("Policy gate", data.proof.policyGate), field("Review", "Recorded Gate A PASS; not independently attested"), el("p", data.proof.provenance.label));
  const publication = panel("Publication identity"); publication.append(field("Built from commit", data.build.commit ?? "Unavailable"),
    field("Build state", data.build.dirty ? "Uncommitted preview" : "Clean publication build"), field("Public source", "Public source availability not verified"),
    field("Publication manifest SHA-256", data.publication.manifestSha256));
  if (data.build.snapshotSha256) publication.append(field("W1 validation source snapshot", data.build.snapshotSha256));
  grid.append(identity, publication); technical.append(grid);
  const coverage = panel("Exercised paths and runtime", "These are known V-A lab paths, not a discovery of every merchant path.");
  for (const p of data.proof.coverage.paths) coverage.append(field(p.pathId, p.tier));
  coverage.append(field("Historical coverage", data.proof.coverage.historical), field("Candidate / controller", `${data.proof.environment.candidateNode} / ${data.proof.environment.controllerNode}`),
    field("PostgreSQL", data.proof.environment.postgresVersion)); technical.append(coverage);
  const limitations = panel("Limits of this result"); const list = el("ul", "", "lab-limitations"); for (const text of data.proof.limitations) list.append(el("li", text)); limitations.append(list); technical.append(limitations);
  const evidence = panel("Inspect the recorded evidence", "Each download is a static file checked by this build. No code or payment operation runs here.");
  evidence.append(field("Verifier manifest", data.proof.environment.manifestSha256), field("Guard subject", data.proof.environment.subjectSha256!));
  const manifestRow = el("div", "", "record");
  manifestRow.append(link("manifest.json", "/lab/evidence/manifest.json"), el("span", data.publication.manifestSha256, "lab-hash")); evidence.append(manifestRow);
  for (const f of data.publication.files) { const row = el("div", "", "record"); row.append(link(f.file, `/lab/evidence/${f.file}`), el("span", f.sha256, "lab-hash")); evidence.append(row); }
  const images = el("details"); images.append(el("summary", "Historical Gate A image identities")); for (const [name, id] of Object.entries(data.proof.environment.images)) images.append(field(name, id)); evidence.append(images); technical.append(evidence);
  const reproduce = panel("Reproduce from a local checkout", "Public source availability is not verified. These instructions assume you already have this repository and the verified commit; they do not claim that a public clone is currently available.");
  reproduce.append(el("pre", `git checkout ${data.proof.sourceCommit}\npnpm install --frozen-lockfile\npnpm v3:verify:gate-a`), el("p", "Use Node 22.18.0, pnpm 11.4.0 and Docker's Linux engine. The disposable verifier runs two repetitions and must finish with accepted results and cleanup PASS.", "muted")); technical.append(reproduce); main.append(technical);
  root.append(main, el("footer", "Independent OrderTruth prototype · Synthetic integration verification and genuine PayPal Sandbox observation are separate evidence sources."));
}
