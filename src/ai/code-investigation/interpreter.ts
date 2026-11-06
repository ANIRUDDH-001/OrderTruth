import { createHash } from "node:crypto";
import { atomicBody, auditBody, captureBody, distributedPrefix, intentBody, pathBody, retryBody } from "./fixtures.ts";
export type Mode = "capture" | "path" | "intent" | "atomic" | "marked";
export type Parsed = { mode: Mode; body: string; prefix: string; name: string };
/** Exact finite grammar. Unrecognized code is rejected, never evaluated as JavaScript. */
export function parseFixture(source: string): Parsed {
  if (Buffer.byteLength(source) > 12000) throw new Error("SOURCE_LIMIT");
  const prefix = source.startsWith(distributedPrefix) ? distributedPrefix : "";
  const match = /^export async function (place|fulfill)\(db, payment, path\) \{\n([\s\S]*)\n\}$/.exec(source.slice(prefix.length));
  if (!match) throw new Error("UNSUPPORTED_GRAMMAR");
  const body = match[2]!;
  const modes = new Map<string,Mode>([[captureBody,"capture"],[pathBody,"path"],[intentBody,"intent"],[atomicBody,"atomic"],[auditBody,"atomic"],[retryBody,"marked"]]);
  const mode = modes.get(body);
  if (!mode) throw new Error("UNSUPPORTED_GRAMMAR");
  return { mode, body, prefix, name: match[1]! };
}
export type Payment = { merchantId: string; intentId: string; captureId: string; amountMinor: number; currency: string };
export type Order = Payment & { id: string; path: string; key: string };
export type Admission = { reviewedSha256: string; reviewer: string };
export const sourceSha = (source: string) => createHash("sha256").update(source).digest("hex");
/** Isolated in-memory interpreter: no eval/import/filesystem/subprocess/transport.
 * Finite grammar, <=32 writes, <=256 operations, <=128 trace entries, bounded fields.
 * Synthetic storage semantics, never evidence of PostgreSQL or process concurrency. */
export function admitReviewedFixture(source: string, admission: Admission) {
  if (!/^[a-f0-9]{64}$/.test(admission.reviewedSha256) || sourceSha(source) !== admission.reviewedSha256
    || !/^[a-zA-Z0-9_-]{1,80}$/.test(admission.reviewer)) throw new Error("REVIEW_ADMISSION_REQUIRED");
  const program = parseFixture(source);
  const rows: Order[] = [], marked = new Set<string>(), trace: Array<Record<string,unknown>> = [];
  let operations = 0;
  const log = (entry: Record<string,unknown>) => { if (trace.length >= 128) throw new Error("TRACE_LIMIT"); trace.push(Object.freeze(entry)); };
  const validate = (p: Payment, path: string) => {
    if (++operations > 256) throw new Error("OPERATION_LIMIT");
    if (![p.merchantId,p.intentId,p.captureId,path].every(v => typeof v === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(v))
      || !Number.isSafeInteger(p.amountMinor) || p.amountMinor <= 0 || !/^[A-Z]{3}$/.test(p.currency)) throw new Error("INVALID_PAYMENT");
  };
  const same = (a: Payment,b: Payment) => a.merchantId === b.merchantId && a.intentId === b.intentId && a.captureId === b.captureId && a.amountMinor === b.amountMinor && a.currency === b.currency;
  const insert = (p: Payment, path: string, key: string) => {
    if (rows.length >= 32) throw new Error("ROW_LIMIT");
    const row = Object.freeze({ ...p, id: `o${rows.length + 1}`, path, key }); log({ event: "COMMIT", orderId: row.id, captureId: p.captureId, path }); rows.push(row); return row;
  };
  const pause = async (hook?: () => Promise<void>) => {
    if (!hook) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([hook(),new Promise<never>((_resolve,reject) => { timer = setTimeout(() => reject(new Error("SCHEDULE_TIMEOUT")),250); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  const keyFor = (p: Payment,path: string) => `${p.merchantId}/${program.mode === "intent" ? p.intentId : p.captureId}${program.mode === "path" ? `/${path}` : ""}`;
  const handle = async (payment: Payment,path: string, hooks: { afterCheck?: () => Promise<void>; afterMark?: () => Promise<void>; failBeforeCommit?: boolean } = {}) => {
    validate(payment,path);
    const p = Object.freeze({ ...payment });
    const key = keyFor(p,path);
    if (program.mode === "atomic") {
      const conflicts = rows.filter(row => row.merchantId === p.merchantId && (row.intentId === p.intentId || row.captureId === p.captureId));
      if (conflicts.some(row => !same(row,p))) { log({ event: "IDENTITY_REJECTED", captureId: p.captureId, path }); throw new Error("IDENTITY_CONFLICT"); }
      if (conflicts[0]) { log({ event: "REUSED", orderId: conflicts[0].id, path }); return conflicts[0]; }
      if (hooks.failBeforeCommit) { log({ event: "ROLLBACK", path }); throw new Error("INJECTED_FAILURE"); }
      return insert(p,path,key);
    }
    if (program.mode === "marked") {
      if (marked.has(key)) { log({ event: "SUPPRESSED", path }); return undefined; }
      log({ event: "MARK_COMMIT", path }); marked.add(key); await pause(hooks.afterMark);
    } else {
      const existing = rows.find(row => row.key === key);
      log({ event: "EXISTENCE_CHECK", found: !!existing, captureId: p.captureId, path });
      if (existing) return existing;
      await pause(hooks.afterCheck);
    }
    if (hooks.failBeforeCommit) { log({ event: "ROLLBACK", path }); throw new Error("INJECTED_FAILURE"); }
    return insert(p,path,key);
  };
  return { handle, snapshot: () => rows.map(row => ({ ...row })), trace: () => trace.map(entry => ({ ...entry })) };
}
