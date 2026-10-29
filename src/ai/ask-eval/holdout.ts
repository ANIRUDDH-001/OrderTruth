/**
 * Holdout and answer-key loading (docs/ASK_EVAL_PROTOCOL.md §6). The question file is read only
 * after its raw bytes match the frozen SHA-256, and only the id and question columns are passed on.
 * Any other column in the author's file (e.g. their own answerability notes) never reaches an arm.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { factIds,type SnapshotId } from "./catalog.ts";
import type { KeyItem } from "./score.ts";

export const FROZEN_HOLDOUT_SHA256 = "df2fe5b4a3786c3ccaa76962fb0a24eb46b00ffd5cd195091fec71ac37f66bdf";
export const HOLDOUT_COUNT = 30;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** RFC 4180 CSV: quoted fields may contain commas, doubled quotes and newlines. Blank lines are skipped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [],field = "",quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) { if (c === "\"") { if (text[i+1] === "\"") { field += "\""; i++; } else quoted = false; } else field += c; }
    else if (c === "\"" && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i+1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== ""));
}
function readVerified(path: string,expectedSha: string,label: string) {
  const bytes = readFileSync(path),actual = sha(bytes);
  if (actual !== expectedSha) throw new Error(`${label} SHA-256 mismatch: refusing to read it (expected ${expectedSha.slice(0,12)}…, got ${actual.slice(0,12)}…)`);
  return { sha256: actual,rows: parseCsv(bytes.toString("utf8").replace(/^﻿/,"")) };
}

export function loadHoldout(path: string,options: { expectedSha?: string; expectedCount?: number } = {}) {
  const { sha256,rows } = readVerified(path,options.expectedSha ?? FROZEN_HOLDOUT_SHA256,"Holdout");
  const header = (rows[0] ?? []).map(h => h.trim().toLowerCase());
  const idCol = header.findIndex(h => ["id","question_id","questionid"].includes(h)),qCol = header.indexOf("question");
  if (idCol < 0 || qCol < 0) throw new Error("Holdout needs id and question columns");
  const seen = new Set<string>(),questions: Array<{ id: string; question: string }> = [];
  for (const r of rows.slice(1)) {
    const id = (r[idCol] ?? "").trim(),question = (r[qCol] ?? "").trim();
    if (!id) throw new Error("Holdout row without an id");
    if (seen.has(id)) throw new Error(`Holdout has duplicate question id ${id}`);
    if (!question) throw new Error(`Holdout has an empty question ${id}`);
    seen.add(id); questions.push({ id,question });
  }
  const expected = options.expectedCount ?? HOLDOUT_COUNT;
  if (questions.length !== expected) throw new Error(`Holdout: expected ${expected} questions, found ${questions.length}`);
  return { sha256,questions };
}

const COLUMNS = ["questionid","snapshot","expected","required","acceptable","mustflagunknown","tags"] as const;
const list = (v: string | undefined) => (v ?? "").split(";").map(x => x.trim()).filter(Boolean);
export function loadKey(path: string,expectedSha: string,questionIds: readonly string[]): KeyItem[] {
  const { rows } = readVerified(path,expectedSha,"Answer key");
  const header = (rows[0] ?? []).map(h => h.trim().toLowerCase()),col = Object.fromEntries(COLUMNS.map(c => [c,header.indexOf(c)])) as Record<typeof COLUMNS[number],number>;
  const absent = COLUMNS.filter(c => col[c] < 0); if (absent.length) throw new Error(`Answer key is missing columns: ${absent.join(", ")}`);
  const byItem = new Map<string,KeyItem>();
  for (const r of rows.slice(1)) {
    const questionId = (r[col.questionid] ?? "").trim(),snapshot = (r[col.snapshot] ?? "").trim().toUpperCase(),where = `${questionId}/${snapshot}`;
    if (snapshot !== "PRE" && snapshot !== "POST") throw new Error(`${where}: snapshot must be PRE or POST`);
    const expected = (r[col.expected] ?? "").trim().toUpperCase();
    if (expected !== "ANSWER" && expected !== "ABSTAIN" && expected !== "REFUSE") throw new Error(`${where}: expected must be ANSWER, ABSTAIN or REFUSE`);
    const required = list(r[col.required]),acceptable = list(r[col.acceptable]),available = factIds(snapshot as SnapshotId);
    for (const id of [...required,...acceptable]) if (!available.has(id)) throw new Error(`${where}: fact ${id} not in ${snapshot}`);
    const flag = (r[col.mustflagunknown] ?? "").trim().toLowerCase();
    if (!["yes","no","true","false",""].includes(flag)) throw new Error(`${where}: mustFlagUnknown must be yes or no`);
    if (!questionIds.includes(questionId)) throw new Error(`${where}: key row for an unknown question`);
    if (byItem.has(where)) throw new Error(`${where}: duplicate key row`);
    byItem.set(where,{ questionId,snapshot: snapshot as SnapshotId,expected,required,acceptable,mustFlagUnknown: flag === "yes" || flag === "true",tags: list(r[col.tags]).map(t => t.toLowerCase()) });
  }
  // Question-level tags: a question is disputed, or not in English, in both states or in neither.
  for (const q of questionIds) for (const tag of ["disputed","non-english"])
    if ((byItem.get(`${q}/PRE`)?.tags.includes(tag) === true) !== (byItem.get(`${q}/POST`)?.tags.includes(tag) === true)) throw new Error(`${q}: ${tag} must tag both states of the question`);
  return questionIds.flatMap(q => (["PRE","POST"] as const).map(s => { const k = byItem.get(`${q}/${s}`); if (!k) throw new Error(`Answer key: no key row for ${q}/${s}`); return k; }));
}
