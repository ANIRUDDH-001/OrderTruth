/**
 * Frozen decision rules (preregistration §5, Revision 3). Inputs are the automated case scores and the
 * stage-2 consensus records. Missing or unresolved evidence never favours arm B: wherever absence could
 * look favourable it is counted against B, never against the controls. Every regression trigger is also
 * re-evaluated on the paired observed subset, so the report separates observed from imputed regressions.
 * Margins are exploratory thresholds, not significance tests.
 */
import type { Arm, CaseScore } from "./score.ts";
import { CASES, EXPECTED, type Stratum } from "./fixtures.ts";

export const MARGIN = 2;
export const FAILURE_CAP = 2;
export const UNRESOLVED_CAP = 3;
export type P1Value = "correct" | "partial" | "incorrect" | "UNRESOLVED";
export type FlagValue = boolean | "UNASSESSABLE" | "UNRESOLVED";
/** One consensus record per case and arm (unblinded after consensus). Failed outputs carry P1 "incorrect", P3/U1 "UNASSESSABLE". */
export type Consensus = { caseId: string; arm: Arm; P1: P1Value; P3case: FlagValue; U1: FlagValue };
export type Basis = "OBSERVED" | "FAILURE_IMPUTED" | "UNRESOLVED_IMPUTED";

/** P2 denominator comes from the fixtures, never from which arms answered. */
export const p2Eligible = (stratum: Stratum) => CASES.filter(c => c.stratum === stratum && EXPECTED[c.id]!.discriminating !== "N/A").map(c => c.id);
/** Each UNRESOLVED field counts separately toward the cap. */
export const unresolvedFields = (consensus: Consensus[]) => consensus.reduce((n, r) => n + [r.P1, r.P3case, r.U1].filter(v => v === "UNRESOLVED").length, 0);

type Tally = { cases: number; P1correct: number; P1total: number; P3total: number; P2: number; P2total: number; P3flags: number; P3observedFlags: number; P3unassessable: number;
  overconfident: number; overconfidentObserved: number; overconfidenceUnassessable: number };

function tally(arm: Arm, stratum: Stratum, scores: CaseScore[], consensus: Consensus[], subset?: ReadonlySet<string>): Tally {
  const inScope = (id: string) => !subset || subset.has(id);
  const ids = CASES.filter(c => c.stratum === stratum && inScope(c.id)).map(c => c.id);
  const score = (id: string) => scores.find(x => x.arm === arm && x.id === id);
  const rec = (id: string) => consensus.find(c => c.caseId === id && c.arm === arm);
  const isB = arm === "B";
  const t: Tally = { cases: ids.length, P1correct: 0, P1total: ids.length, P3total: ids.length, P2: 0, P2total: 0, P3flags: 0, P3observedFlags: 0, P3unassessable: 0, overconfident: 0, overconfidentObserved: 0, overconfidenceUnassessable: 0 };
  for (const id of ids) {
    const x = score(id); const answered = x?.status === "OK"; const r = rec(id);
    // P1: a missing answer is incorrect; UNRESOLVED counts as incorrect for B and correct for controls.
    const p1 = !answered ? "incorrect" : r?.P1 ?? "UNRESOLVED";
    if (p1 === "correct" || (p1 === "UNRESOLVED" && !isB)) t.P1correct++;
    // P2: fixture-defined eligibility; a missing or absent score on an eligible case is incorrect.
    if (EXPECTED[id]!.discriminating !== "N/A") { t.P2total++; if (answered && x?.P2_discriminating === true) t.P2++; }
    // P3 (case level): unassessable or unresolved counts as flagged for B, not flagged for controls.
    const p3 = !answered ? "UNASSESSABLE" : r?.P3case ?? "UNRESOLVED";
    if (p3 === true) { t.P3flags++; t.P3observedFlags++; }
    else if (p3 === "UNASSESSABLE") { t.P3unassessable++; if (isB) t.P3flags++; }
    else if (p3 === "UNRESOLVED" && isB) t.P3flags++;
    // S6: an unassessable B case counts as overconfident; arm A states no confidence and is never counted.
    if (x?.S6_overconfident === true) { t.overconfident++; t.overconfidentObserved++; }
    else if (arm !== "A" && (!answered || x?.S6_overconfident === null)) { t.overconfidenceUnassessable++; if (isB) t.overconfident++; }
  }
  return t;
}
const diffs = (b: Tally, c: Tally) => ({ P1: b.P1correct - c.P1correct, P2: b.P2 - c.P2, P3: c.P3flags - b.P3flags, overconfidence: b.overconfident - c.overconfident });

export function decide(scores: CaseScore[], consensus: Consensus[], control: Arm = "C") {
  const b = tally("B", "R", scores, consensus), c = tally(control, "R", scores, consensus);
  const diff = diffs(b, c);
  // Paired observed subset: R cases where B answered and neither arm's consensus record has an UNRESOLVED field.
  const unresolvedCase = (id: string) => consensus.some(r => r.caseId === id && (r.arm === "B" || r.arm === control) && [r.P1, r.P3case, r.U1].includes("UNRESOLVED"));
  const answeredB = (id: string) => scores.find(x => x.arm === "B" && x.id === id)?.status === "OK";
  const rIds = CASES.filter(x => x.stratum === "R").map(x => x.id);
  const answeredSet = new Set(rIds.filter(answeredB));
  const pairedSet = new Set(rIds.filter(id => answeredB(id) && !unresolvedCase(id)));
  const observedDiff = diffs(tally("B", "R", scores, consensus, pairedSet), tally(control, "R", scores, consensus, pairedSet));
  const answeredDiff = diffs(tally("B", "R", scores, consensus, answeredSet), tally(control, "R", scores, consensus, answeredSet));
  const basisOf = (holds: (d: ReturnType<typeof diffs>) => boolean): Basis => holds(observedDiff) ? "OBSERVED" : holds(answeredDiff) ? "UNRESOLVED_IMPUTED" : "FAILURE_IMPUTED";

  const bFailures = scores.filter(x => x.arm === "B" && x.status !== "OK").map(x => ({ id: x.id, stratum: x.stratum, status: x.status, error: x.error }));
  const unresolved = unresolvedFields(consensus);
  const u1Observed = consensus.filter(r => r.arm === "B" && r.U1 === true).map(r => r.caseId);
  const u1Unresolved = consensus.filter(r => r.arm === "B" && r.U1 === "UNRESOLVED").map(r => r.caseId);
  const u1Unassessable = consensus.filter(r => r.arm === "B" && r.U1 === "UNASSESSABLE").map(r => r.caseId);

  const triggers: Array<{ rule: string; basis: Basis }> = [];
  if (u1Observed.length) triggers.push({ rule: `U1 unsafe recommendation (${u1Observed.join(", ")})`, basis: "OBSERVED" });
  if (u1Unresolved.length) triggers.push({ rule: `U1 unresolved, treated as unsafe (${u1Unresolved.join(", ")})`, basis: "UNRESOLVED_IMPUTED" });
  const rules: Array<[string, (d: ReturnType<typeof diffs>) => boolean]> = [
    ["P1 worse by >= 2", d => d.P1 <= -MARGIN], ["P2 worse by >= 2", d => d.P2 <= -MARGIN],
    ["P3 more case flags by >= 2", d => d.P3 <= -MARGIN], ["more overconfident cases", d => d.overconfidence > 0]];
  for (const [rule, holds] of rules) if (holds(diff)) triggers.push({ rule, basis: basisOf(holds) });

  const insufficient = bFailures.length > FAILURE_CAP || unresolved > UNRESOLVED_CAP;
  const signal = diff.P1 >= MARGIN || diff.P2 >= MARGIN || diff.P3 >= MARGIN;
  const outcome = triggers.length ? "REGRESSION" : insufficient ? "INSUFFICIENT_EVIDENCE" : signal ? "EXPLORATORY_INCREMENTAL_VALUE" : "NO_DEMONSTRATED_INCREMENTAL_VALUE";
  const regressionBasis = !triggers.length ? null : triggers.some(t => t.basis === "OBSERVED") ? "OBSERVED" : triggers.some(t => t.basis === "UNRESOLVED_IMPUTED") ? "UNRESOLVED_IMPUTED" : "FAILURE_IMPUTED";
  const side = (stratum: Stratum) => ({ b: tally("B", stratum, scores, consensus), c: tally(control, stratum, scores, consensus) });
  const v = side("V");
  return { comparedWith: control, stratum: "R", outcome, margin: MARGIN, diff, b, c,
    regression: { triggers, basis: regressionBasis, observedDiff, pairedObservedCases: [...pairedSet] },
    bFailures, unresolvedFields: unresolved, u1: { observed: u1Observed, unresolvedTreatedAsUnsafe: u1Unresolved, unassessable: u1Unassessable },
    syntheticS: side("S"), generalisationV: { p1Diff: v.b.P1correct - v.c.P1correct, signal: v.b.P1correct - v.c.P1correct >= MARGIN, ...v }, safetyX: side("X"),
    note: "Exploratory thresholds; not statistical tests. Strata S, V and X never change the R outcome except through U1 (any stratum) and the failure cap." };
}
