/** Describe recorded handler intervals. States what the times show, never why a write happened. */
export type TimingRow = { orderId: string; handler: string; startedAt: string; finishedAt: string; durationMs: number };
export type TimingDescription = { rows: TimingRow[]; observations: string[]; limitations: string[] };

const FALLBACK = "Timing values could not be read; see the recorded evidence below.";
const SCOPE = "This shows when each recorded write ran, not why it ran.";
const PROVIDER = "Timing alone does not establish a PayPal failure.";
const CONTROLLED = 'Controlled case: the duplicate write runs when "Introduce duplicate" is pressed. Any gap between writes reflects when it was pressed, not real webhook delivery latency.';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function describeHandlerTiming(facts: Record<string,unknown>,controlled: boolean): TimingDescription {
  const limitations = [SCOPE,PROVIDER,...(controlled ? [CONTROLLED] : []),...(typeof facts.note === "string" ? [`Recorded note: "${facts.note}"`] : [])];
  const rows = readRows(facts.entries);
  if (!rows) return { rows: [],observations: [],limitations: [FALLBACK,...limitations] };
  rows.sort((a,b) => Date.parse(a.startedAt)-Date.parse(b.startedAt) || a.orderId.localeCompare(b.orderId));
  return { rows,observations: [...overlap(rows,facts.clockPrecision),...handlers(rows)],limitations };
}

// Any missing, malformed or inconsistent entry rejects the whole set: nothing is computed from partial data.
function readRows(entries: unknown): TimingRow[]|null {
  if (!Array.isArray(entries)) return null;
  const rows: TimingRow[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) return null;
    const { handler,merchantOrderId,startedAt,finishedAt,durationMs } = entry as Record<string,unknown>;
    if (typeof handler !== "string" || !handler || typeof merchantOrderId !== "string" || !merchantOrderId) return null;
    if (typeof startedAt !== "string" || typeof finishedAt !== "string" || !ISO.test(startedAt) || !ISO.test(finishedAt)) return null;
    const start = Date.parse(startedAt),finish = Date.parse(finishedAt);
    if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start || (durationMs !== undefined && durationMs !== finish-start)) return null;
    rows.push({ orderId: merchantOrderId,handler,startedAt,finishedAt,durationMs: finish-start });
  }
  return rows;
}

// Rows are sorted by start, so for i < j only the later start against the earlier finish decides the relation.
function relation(a: TimingRow,b: TimingRow) {
  const start = Date.parse(b.startedAt),finish = Date.parse(a.finishedAt);
  return start < finish ? "OVERLAP" : start === finish ? "TOUCH" : "APART";
}
function overlap(rows: TimingRow[],precision: unknown): string[] {
  if (rows.length === 0) return ["No recorded writes."];
  if (rows.length === 1) return ["Only one recorded write, so there is nothing to compare."];
  if (precision !== "MILLISECOND") return [`Clock precision is ${typeof precision === "string" && precision ? precision : "not recorded"}, so overlap is not computed.`];
  if (rows.length === 2) {
    const [first,second] = rows as [TimingRow,TimingRow];
    const kind = relation(first,second);
    if (kind === "TOUCH") return ["The second started in the same millisecond the first finished, so overlap can't be determined at this precision."];
    if (kind === "APART") return [`The two recorded writes did not overlap. The second started ${span(Date.parse(second.startedAt)-Date.parse(first.finishedAt))} after the first finished.`];
    const shared = Math.min(Date.parse(first.finishedAt),Date.parse(second.finishedAt))-Date.parse(second.startedAt);
    return [`The two recorded writes overlapped${shared > 0 ? ` by ${shared} ms` : ""}.`];
  }
  const kinds = rows.flatMap((a,i) => rows.slice(i+1).map(b => relation(a,b)));
  const overlapped = kinds.filter(k => k === "OVERLAP").length,touched = kinds.filter(k => k === "TOUCH").length;
  const pairs = (n: number) => `${n} pair${n === 1 ? "" : "s"}`;
  return [`Of ${rows.length} recorded writes, ${pairs(overlapped)} overlapped${touched
    ? `; ${pairs(touched)} started in the same millisecond another finished, so ${touched === 1 ? "its" : "their"} overlap can't be determined` : ""}.`];
}
function handlers(rows: TimingRow[]): string[] {
  if (rows.length < 2) return [];
  const names = [...new Set(rows.map(r => r.handler))];
  if (names.length === 1) return [rows.length === 2 ? `Both came from the same handler: ${names[0]}.` : `All ${rows.length} came from the same handler: ${names[0]}.`];
  const list = `${names.slice(0,-1).join(", ")} and ${names.at(-1)}`;
  return [rows.length === 2 ? `They came from different handlers: ${list}.` : `They came from ${names.length} different handlers: ${list}.`];
}
function span(ms: number) { return ms < 1000 ? `${ms} ms` : `${(ms/1000).toFixed(1)} s`; }
