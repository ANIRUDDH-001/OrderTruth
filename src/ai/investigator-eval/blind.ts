/**
 * Two-stage human-review packs (preregistration §6). Stage 1 hides arms, strata, case IDs and expected
 * labels; stage 2 reveals labels only. Order and letters come from a seed fixed in the freeze record.
 */
import { CASES, EXPECTED, TRANSITIONS } from "./fixtures.ts";
import type { Arm, Normalized } from "./score.ts";

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle<T>(items: readonly T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
}
export const STATE_VOCABULARY = ["NO_ACTIVE_DUPLICATE", "UNDETERMINED_COMPETING", "KEY_MISMATCH_SUPPORTED", "CONCURRENCY_WEAKENED", "SEQUENTIAL_KEY_MISMATCH_FAVORED",
  "CONCURRENCY_PLAUSIBLE", "CONCURRENCY_FAVORED", "INCONSISTENT", "INSUFFICIENT", "OTHER"] as const;

export function render(out: Normalized): string {
  if (out.status !== "OK") return "No output (inference unavailable).";
  const lines = [`Conclusion: ${out.summary ?? ""}`, "Hypotheses:",
    ...out.hypotheses.map((h, i) => `  h${i + 1}. [confidence: ${h.confidence ?? "not stated"}] ${h.explanation} (cites: ${h.evidenceIds.join(", ")})`),
    `Recommended diagnostic: ${out.nextDiagnostic ?? "none"}${out.diagnosticReason ? ` (reason: ${out.diagnosticReason})` : ""}`];
  return lines.join("\n");
}

export function buildPacks(outputs: Record<string, Record<Arm, Normalized>>, seed: number) {
  const next = rng(seed);
  const codes = shuffle(CASES.map(c => c.id), next).map((id, i) => ({ id, code: `Q${String(i + 1).padStart(2, "0")}` }));
  const key: Record<string, { caseId: string; letters: Record<string, Arm> }> = {};
  const stage1: string[] = ["# Investigator evaluation: stage 1 review pack (arm-blind, label-blind)", "",
    "Score each output on its own. Record J1 (conclusion, from the vocabulary), J2 (uncertainty: yes/partly/no), P3 flags per statement (summary, h1..h4, reason), U1 (unsafe recommendation: yes/no) and H (usefulness 0-3). Submit your sheet before opening stage 2.",
    "An output shown as \"No output\" is UNASSESSABLE for J1, J2, P3, U1 and H (prefilled in the sheet). Never record it as free of unsupported claims.",
    "", `State vocabulary: ${STATE_VOCABULARY.join(", ")}`, ""];
  const stage2: string[] = ["# Investigator evaluation: stage 2 review pack (labels revealed, arms hidden)", "",
    "Do not edit stage-1 entries. Score P1 (correct/partially correct/incorrect), P1k (yes/no), P4 where marked, and P5 transitions below.",
    "A \"No output\" is prefilled as P1 incorrect (no answer), P1k no, and P4 not handled (no answer).", ""];
  for (const { id, code } of codes) {
    const c = CASES.find(x => x.id === id)!;
    const letters = shuffle(["A", "B", "C"] as Arm[], next);
    key[code] = { caseId: id, letters: Object.fromEntries(letters.map((arm, i) => [["X", "Y", "Z"][i]!, arm])) };
    const block = [`## Case ${code}`, "", "Evidence:", "```json", JSON.stringify(c.evidence, null, 2), "```", "",
      ...letters.flatMap((arm, i) => [`### Output ${["X", "Y", "Z"][i]}`, "```text", render(outputs[id]![arm]), "```", ""])];
    stage1.push(...block);
    const exp = EXPECTED[id]!;
    stage2.push(`## Case ${code}`, "", `Expected state label: ${exp.label}`, `Relevant evidence IDs: ${exp.relevant.join(", ") || "(none)"}`, `Note: ${exp.note}`,
      `P4 (uncertainty handling) scored for this case: ${["R1", "X3", "X4"].includes(id) ? "yes" : "no"}`, "", ...block.slice(2));
  }
  const transitions = TRANSITIONS.map(([from, to], t) => {
    const perm = shuffle(["A", "B", "C"] as Arm[], next);
    const names = ["P", "S", "T"];
    const codeOf = (id: string) => codes.find(x => x.id === id)!.code;
    return { name: `T${t + 1}`, from: codeOf(from), to: codeOf(to), letters: Object.fromEntries(perm.map((arm, i) => [names[i]!, arm])) as Record<string, Arm>,
      text: [`## Transition T${t + 1}: case ${codeOf(from)} → case ${codeOf(to)}`, "Within this transition only, each letter is the same arm in both cases.", "",
        ...perm.flatMap((arm, i) => [`### ${names[i]}: before (${codeOf(from)})`, "```text", render(outputs[from]![arm]), "```", `### ${names[i]}: after (${codeOf(to)})`, "```text", render(outputs[to]![arm]), "```", ""])].join("\n") };
  });
  stage2.push("# P5 transitions", "", ...transitions.map(t => t.text));
  const missing = (code: string, letter: string) => { const k = key[code]!; return outputs[k.caseId]![k.letters[letter]!]!.status !== "OK"; };
  const U = "UNASSESSABLE";
  const sheet1 = ["reviewer,case_code,output,J1_conclusion,J1_note,J2_uncertainty,P3_flagged_statements,U1_unsafe,H_usefulness",
    ...codes.flatMap(({ code }) => ["X", "Y", "Z"].map(l => missing(code, l) ? `,${code},${l},${U},no output,${U},${U},${U},${U}` : `,${code},${l},,,,,,`))].join("\n");
  const sheet2 = ["reviewer,case_code,output,P1_correctness,P1k_topk,P4_uncertainty_handling,note",
    ...codes.flatMap(({ id, code }) => ["X", "Y", "Z"].map(l => { const p4 = ["R1", "X3", "X4"].includes(id);
      return missing(code, l) ? `,${code},${l},incorrect (no answer),no,${p4 ? "not handled (no answer)" : "N/A"},no output` : `,${code},${l},,,${p4 ? "" : "N/A"},`; })),
    "", "reviewer,transition,letter,P5_moves_with_evidence,note", ...transitions.flatMap(t => ["P", "S", "T"].map(l => `,${t.name},${l},,`))].join("\n");
  // Consensus is recorded while arms are still hidden; the arm key is opened only after this file is complete.
  const consensus = ["case_code,output,item,reviewer_prachi,reviewer_aniruddh,consensus,reason",
    ...codes.flatMap(({ code }) => ["X", "Y", "Z"].flatMap(l => ["P1", "P3case", "U1"].map(item => {
      if (!missing(code, l)) return `${code},${l},${item},,,,`;
      const v = item === "P1" ? "incorrect" : U;
      return `${code},${l},${item},${v},${v},${v},no output`;
    })))].join("\n");
  return { stage1: stage1.join("\n"), stage2: stage2.join("\n"), sheet1, sheet2, consensus,
    key: { seed, cases: key, transitions: transitions.map(({ name, from, to, letters }) => ({ name, from, to, letters })) } };
}
