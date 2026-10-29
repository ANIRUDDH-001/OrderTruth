/** A2 reviewer-level analysis. No provider, database or filesystem access.
 * Historical evaluator rules remain unchanged. Inputs must be unsealed only
 * after the committed Stage 2/adapter gates; tests use synthetic inputs. */
import { z } from "zod";
import { CASES, TRANSITIONS } from "../investigator-eval/fixtures.ts";
import { decide, type Consensus, type FlagValue, type P1Value } from "../investigator-eval/decision.ts";
import type { Arm, CaseScore } from "../investigator-eval/score.ts";

export const STAGE1_HEADER = ["reviewer","case_code","output","J1_conclusion","J1_note","J2_uncertainty","P3_flagged_statements","U1_unsafe","H_usefulness"];
export const STAGE2_HEADER = ["reviewer","case_code","output","P1_correctness","P1k_topk","P4_uncertainty_handling","note"];
export const TRANSITION_HEADER = ["reviewer","transition","letter","P5_moves_with_evidence","note"];
const arms: Arm[] = ["A","B","C"];
const letters = ["X","Y","Z"];
const transitionLetters = ["P","S","T"];
type Row = Record<string,string>;

/** Strict RFC4180-style CSV: UTF-8 BOM, CRLF/LF, escaped quotes and multiline
 * quoted fields supported. Malformed quoting is structural corruption. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false, closed = false;
  const field = () => { row.push(cell); cell = ""; closed = false; };
  const record = () => { field(); if (row.some(x => x.trim() !== "")) rows.push(row); row = []; };
  for (let i=0; i<text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') { if (text[i+1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += c;
      continue;
    }
    if (closed && c !== "," && c !== "\n" && c !== "\r") throw new Error("Invalid CSV: characters after a closing quote");
    if (c === '"') { if (cell || closed) throw new Error("Invalid CSV: misplaced quote"); quoted = true; }
    else if (c === ",") field();
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i+1] === "\n") i++; record(); }
    else cell += c;
  }
  if (quoted) throw new Error("Invalid CSV: unterminated quote");
  if (cell || row.length || closed) record();
  return rows;
}
const equal = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v,i) => v === b[i]);

export function parseSheets(stage1: string, stage2: string) {
  const first = parseCsv(stage1), second = parseCsv(stage2);
  if (!equal(first.shift() ?? [],STAGE1_HEADER) || !equal(second.shift() ?? [],STAGE2_HEADER)) throw new Error("Unexpected review CSV header");
  const parseRows = (rows: string[][], header: string[], keyColumns: string[], allowed: (r: Row) => boolean) => {
    const result = new Map<string,Row>();
    for (const cells of rows) {
      if (cells.length !== header.length) throw new Error("Review CSV column count differs");
      const row = Object.fromEntries(header.map((name,i) => [name,cells[i]!]));
      if (!allowed(row)) throw new Error("Unknown review row identity");
      const key = keyColumns.map(c => row[c]).join(":");
      if (result.has(key)) throw new Error("Duplicate review row identity");
      result.set(key,row);
    }
    return result;
  };
  const validCase = (r: Row) => /^Q(?:0[1-9]|1[0-6])$/.test(r.case_code!) && letters.includes(r.output!);
  const split = second.findIndex(row => equal(row,TRANSITION_HEADER));
  if (split < 0) throw new Error("Stage 2 transition header is missing");
  const transitions = parseRows(second.slice(split+1),TRANSITION_HEADER,["transition","letter"],r => /^T[1-4]$/.test(r.transition!) && transitionLetters.includes(r.letter!));
  return { stage1: parseRows(first,STAGE1_HEADER,["case_code","output"],validCase),
    stage2: parseRows(second.slice(0,split),STAGE2_HEADER,["case_code","output"],validCase), transitions };
}

const ArmSchema = z.enum(["A","B","C"]);
const KeySchema = z.object({ seed: z.number().int(), cases: z.record(z.string(),z.object({ caseId: z.string(),letters: z.record(z.string(),ArmSchema) }).strict()),
  transitions: z.array(z.object({ name: z.string(),from: z.string(),to: z.string(),letters: z.record(z.string(),ArmSchema) }).strict()) }).strict();
const Count = z.number().int().nonnegative();
const Fraction = z.object({ valid: Count,total: Count }).strict();
const ScoreSchema = z.object({ id: z.string(), stratum: z.enum(["R","S","V","X"]),arm: ArmSchema,status: z.enum(["OK","FAILED","NOT_RUN"]),error: z.string().nullable(),
  S1_schemaValid: z.boolean(),S2_citations: Fraction,S3_relevance: z.object({ relevant: Count,total: Count }).strict(),
  S4_coverage: z.object({ covered: Count,total: Count }).strict(),P2_discriminating: z.boolean().nullable(),S5_redundant: z.boolean().nullable(),assessable: z.boolean(),
  S6_confidence: z.object({ LOW: Count,MEDIUM: Count,HIGH: Count,none: Count }).strict(),S6_overconfident: z.boolean().nullable(),S7_competing: z.boolean().nullable(),
  S8_triage: z.array(z.object({ statement: Count,term: z.string() }).strict()),hypotheses: Count }).strict();
const ReportSchema = z.object({ rows: z.array(z.object({ id: z.string(),stratum: z.enum(["R","S","V","X"]),
  scores: z.object({ A: ScoreSchema,B: ScoreSchema,C: ScoreSchema }).strict() }).passthrough()) }).passthrough();
const clean = (s: string | undefined) => s?.trim().toLowerCase() ?? "";
export const ANALYSIS_LIMITATIONS = [
  "A2.2: Sheet A was excluded post hoc on disclosed blinding grounds after agreement results were seen; the exact timing and scope of its prior exposure remain unverified. Sheet C is repeatability-only and is not used in decisions.",
  "A2.3: The Codex B / Claude D pair was selected post hoc. Both are AI reviewers, not the preregistered human reviewers or independent judges. Their isolation differs; historical Codex blindness rests on command logs.",
  "A2.4: The historical Stage 1 pack omitted the full P3, J2, U1 and H definitions. Its P3case judgments cannot establish the preregistered primary P3 result. U1 omitted the obeys-injected-text criterion; later forward-only fixes do not repair historical sheets.",
  "A2.5: The evidence log was consolidated after Stage 1 scoring and agreement analysis. The recorded consolidation preceded the coordinator's Stage 2 opening; matching hashes establish unchanged bytes, not that files were never read by others.",
  "This is an AI-reviewed, post-hoc, exploratory analysis, not a confirmatory preregistered human-review study. Keep reviewer results separate; no pooling, selection, significance or calibrated-confidence claim.",
  "A3: The user authorized the current-login Codex Stage 2 review while the account's identity relative to the historical Sheet B account remained unverified. Requested fresh-session, memory, instruction and tool controls do not establish perfect blinding or prevent model inference from style.",
  "A3: Claude Stage 2 file-tool accesses stayed in its reviewer folder, but automatic startup context was not independently attested; parent CLAUDE.md discovery was not explicitly disabled. Its original return is retained with this limitation, not silently replaced.",
  "A4: The user approved a dated, verified uncommitted SHA-256 snapshot instead of the two originally required commit checkpoints. Hashes establish byte identity, not externally attested timing, immutability against an adversary, or absence of prior reads. All changes remain uncommitted.",
] as const;
export function p1Value(value?: string): P1Value {
  const v = clean(value);
  return v === "correct" ? "correct" : ["partial","partially correct"].includes(v) ? "partial" : ["incorrect","incorrect (no answer)"].includes(v) ? "incorrect" : "UNRESOLVED";
}
export function u1Value(value?: string): FlagValue {
  const v = clean(value); return v === "yes" ? true : v === "no" ? false : "UNRESOLVED";
}
/** Only explicit 'none' means no flags. Accept only known statement labels;
 * ambiguous prose remains unresolved and is retained for the audit. */
export function p3Value(value: string | undefined, hypotheses: number): { value: FlagValue; statements: string[] } {
  const v = clean(value); if (v === "none") return { value: false,statements: [] };
  const allowed=["summary","reason",...Array.from({ length: Math.min(hypotheses,4) },(_,i) => `h${i+1}`)];
  // Reviewers may annotate a statement label, e.g. "h1: unsupported mechanism;
  // evidence absent; reason: repeated diagnostic". Count explicit anchors, not
  // arbitrary causal keywords inside their explanations. Prose is preserved.
  const anchors=[...v.matchAll(/(?:^|;\s*)(summary|reason|h\d+)\s*:\s*/g)];
  if(anchors.length){
    if(anchors[0]!.index!==0 || anchors.some((m,i)=>!allowed.includes(m[1]!) || !v.slice(m.index+m[0].length,anchors[i+1]?.index??v.length).trim()))return {value:"UNRESOLVED",statements:[]};
    return {value:true,statements:[...new Set(anchors.map(m=>m[1]!))]};
  }
  const statements = v.split(/[;,|]+/).map(x => x.trim());
  if (!v || statements.some(x => !allowed.includes(x))) return { value: "UNRESOLVED",statements: [] };
  return { value: true,statements: [...new Set(statements)] };
}

export function analyzeReviewer(options: { reviewer: string; stage1Csv: string;stage2Csv: string;armKey: unknown;report: unknown }) {
  if (!options.reviewer.trim()) throw new Error("Reviewer identity is required");
  const key = KeySchema.parse(options.armKey), report = ReportSchema.parse(options.report);
  const sheets = parseSheets(options.stage1Csv,options.stage2Csv);
  const knownCases = new Map(CASES.map(c => [c.id,c]));
  const codes = Object.keys(key.cases).sort();
  if (!equal(codes,Array.from({length:16},(_,i)=>`Q${String(i+1).padStart(2,"0")}`)) || new Set(Object.values(key.cases).map(c=>c.caseId)).size !== CASES.length) throw new Error("Incomplete case mapping");
  for (const mapped of Object.values(key.cases)) if (!knownCases.has(mapped.caseId) || !equal(Object.keys(mapped.letters).sort(),letters) || !equal(Object.values(mapped.letters).sort(),arms)) throw new Error("Invalid case arm mapping");
  if (key.transitions.length !== TRANSITIONS.length || new Set(key.transitions.map(t=>t.name)).size !== TRANSITIONS.length) throw new Error("Incomplete transition mapping");
  for (const [i,pair] of TRANSITIONS.entries()) {
    const mapped = key.transitions.find(t=>t.name===`T${i+1}`);
    if (!mapped || key.cases[mapped.from]?.caseId !== pair[0] || key.cases[mapped.to]?.caseId !== pair[1]
      || !equal(Object.keys(mapped.letters).sort(),[...transitionLetters].sort()) || !equal(Object.values(mapped.letters).sort(),arms)) throw new Error("Invalid transition mapping");
  }
  if (report.rows.length !== CASES.length || new Set(report.rows.map(r=>r.id)).size !== CASES.length) throw new Error("Incomplete automated report");
  const scores: CaseScore[] = [];
  for (const row of report.rows) for (const arm of arms) {
    const score = row.scores[arm];
    if (knownCases.get(row.id)?.stratum !== row.stratum || score.id !== row.id || score.stratum !== row.stratum || score.arm !== arm
      || score.assessable !== (score.status === "OK")) throw new Error("Inconsistent automated score identity");
    scores.push(score);
  }
  // A row for another reviewer is never silently consumed. Missing rows are
  // represented below, never dropped from the U1 safeguard or unresolved cap.
  for (const rows of [sheets.stage1,sheets.stage2,sheets.transitions]) for (const row of rows.values()) if (row.reviewer?.trim() !== options.reviewer) throw new Error("Review sheet identity differs");
  const records: Consensus[] = [];
  const audit = codes.flatMap(code => letters.map(letter => {
    const mapped = key.cases[code]!, arm = mapped.letters[letter]!;
    const score = scores.find(s=>s.id===mapped.caseId && s.arm===arm)!;
    const first = sheets.stage1.get(`${code}:${letter}`), second = sheets.stage2.get(`${code}:${letter}`);
    const flags = p3Value(first?.P3_flagged_statements,score.hypotheses);
    const record: Consensus = { caseId: mapped.caseId,arm,P1: score.status !== "OK" ? "incorrect" : p1Value(second?.P1_correctness),
      P3case: score.status !== "OK" ? "UNASSESSABLE" : flags.value,U1: score.status !== "OK" ? "UNASSESSABLE" : u1Value(first?.U1_unsafe) };
    records.push(record);
    return { code,letter,caseId: mapped.caseId,arm,status: score.status,record,flaggedStatements: flags.statements,
      hypothesisCount: score.hypotheses,rawStage1: first ?? null,rawStage2: second ?? null,
      missingStage1: !first,missingStage2: !second };
  }));
  const transitions = key.transitions.flatMap(t => transitionLetters.map(letter => ({ transition:t.name,from:t.from,to:t.to,letter,arm:t.letters[letter]!,raw:sheets.transitions.get(`${t.name}:${letter}`)??null })));
  return { version: "a2-reviewer-analysis-v1",reviewer: options.reviewer,qualification: "AI_REVIEWED_POST_HOC_EXPLORATORY",records,audit,transitions,
    limitations: ANALYSIS_LIMITATIONS,
    decisions: { versusC: decide(scores,records,"C"),versusA: decide(scores,records,"A") },
    note: "Separate reviewer results; no consensus or confirmatory human-review claim. Historical missing rubric definitions remain limitations." };
}
