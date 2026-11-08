import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { InvestigationEvidence } from "./investigation.ts";

export const EGRESS_POLICY = "causal-relations-v1";
const id = z.string().min(1).max(160);
const count = z.number().int().min(0).max(1000);
const time = z.iso.datetime();
const handler = z.enum(["capture_return","webhook_capture_completed"]);
const status = z.enum(["CREATED","SAVED","APPROVED","VOIDED","COMPLETED","PAYER_ACTION_REQUIRED","PENDING","DECLINED","FAILED","REFUNDED","PARTIALLY_REFUNDED","DENIED"]);
const money = z.object({ currency_code: z.string().regex(/^[A-Z]{3}$/).nullable(),value: z.string().regex(/^\d{1,12}\.\d{2}$/).nullable() }).strict().nullable();
const base = { id,observedAt: time };
const payment = z.object({ ...base,source: z.enum(["PAYPAL_SANDBOX_OBSERVATION","SYNTHETIC_PAYMENT_OBSERVATION"]),facts: z.object({
  orderStatus: status.nullable().optional(),purchaseUnits: z.array(z.object({ amount: money.optional(),captures: z.array(z.object({ status: status.nullable().optional(),amount: money.optional() }).strict()).max(20).optional() }).strict()).max(10).optional(),
}).strict() }).strict();
const merchant = z.object({ ...base,source: z.literal("CONTROLLED_MERCHANT_STATE"),facts: z.object({ activeOrders: count,
  orders: z.array(z.object({ id,status: z.enum(["placed","voided_duplicate"]),amountMinor: z.number().int().nonnegative().safe(),currency: z.string().regex(/^[A-Z]{3}$/) }).strict()).max(100),providerMutation: z.literal(false),
}).strict() }).strict();
const diagnostic = z.object({ ...base,source: z.literal("MERCHANT_DIAGNOSTIC"),facts: z.discriminatedUnion("diagnostic",[
  z.object({ diagnostic: z.literal("IDEMPOTENCY_KEYS"),distinctKeys: count,entries: z.array(z.object({ handler,keySha256: z.string().regex(/^[a-f0-9]{64}$/),merchantOrderId: id }).strict()).max(100),scope: z.literal("CONTROLLED_MERCHANT_HANDLERS") }).strict(),
  z.object({ diagnostic: z.literal("HANDLER_TIMING"),clockPrecision: z.literal("MILLISECOND"),entries: z.array(z.object({ handler,startedAt: time,finishedAt: time,durationMs: z.number().int().nonnegative().max(86_400_000),merchantOrderId: id }).strict()).max(100),note: z.literal("Recorded intervals describe controlled handlers; they do not establish PayPal concurrency.") }).strict(),
  z.object({ diagnostic: z.literal("MERCHANT_WRITE_OUTCOMES"),committedWrites: count,entries: z.array(z.object({ handler,merchantOrderId: id,outcome: z.literal("COMMITTED") }).strict()).max(100),limitation: z.literal("Only committed controlled merchant writes are observed here; absence of a row does not prove no failed attempt occurred.") }).strict(),
]) }).strict();
const inputSchema = z.array(z.union([payment,merchant,diagnostic])).min(1).max(20);

/** Private input is validated recursively before projection. Unknown fields cause
 * rejection, never silent stripping. No arbitrary text is admitted to transport.
 * References are random per call; no weak hashes or stable transaction IDs leave.
 * This minimizes disclosure; relationships can still be identifying, not anonymous. */
export function prepareEvidenceEgress(input: readonly InvestigationEvidence[]) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || new Set(input.map(e => e.id)).size !== input.length) throw new Error("AI_EGRESS_REJECTED");
  // Account-specific data controls are not yet qualified. Even reduced Sandbox
  // relationships are financial evidence, not proven anonymous demo data.
  if (parsed.data.some(e => e.source === "PAYPAL_SANDBOX_OBSERVATION")) throw new Error("AI_EGRESS_REJECTED");
  const references = new Map<string,string>();
  const opaque = (privateId: string) => { let ref = references.get(privateId); if (!ref) { ref = `ref_${randomUUID()}`; references.set(privateId,ref); } return ref; };
  const citationMap = new Map<string,string>();
  const evidence = parsed.data.map(e => {
    const ref = `e_${randomUUID()}`; citationMap.set(ref,e.id);
    let facts: unknown;
    if (e.source === "CONTROLLED_MERCHANT_STATE") facts = { activeOrders: e.facts.activeOrders,providerMutation: false,
      orders: e.facts.orders.map(o => ({ reference: opaque(o.id),status: o.status })) };
    else if (e.source === "MERCHANT_DIAGNOSTIC") {
      const f = e.facts;
      if (f.diagnostic === "IDEMPOTENCY_KEYS") facts = { diagnostic: f.diagnostic,distinctKeys: f.distinctKeys,
        entries: f.entries.map(x => ({ handler: x.handler,keyReference: opaque(x.keySha256),orderReference: opaque(x.merchantOrderId) })) };
      else if (f.diagnostic === "MERCHANT_WRITE_OUTCOMES") facts = { diagnostic: f.diagnostic,committedWrites: f.committedWrites,
        entries: f.entries.map(x => ({ handler: x.handler,orderReference: opaque(x.merchantOrderId),outcome: x.outcome })),failedAttemptsObserved: false };
      else {
        if (f.entries.some(x => Date.parse(x.finishedAt)-Date.parse(x.startedAt) !== x.durationMs)) throw new Error("AI_EGRESS_REJECTED");
        // Interval relationships are sufficient to challenge a race explanation.
        facts = { diagnostic: f.diagnostic,clockPrecision: f.clockPrecision,entries: f.entries.map(x => ({ handler: x.handler,orderReference: opaque(x.merchantOrderId) })),
          pairs: f.entries.flatMap((a,i) => f.entries.slice(i+1).map(b => ({ first: opaque(a.merchantOrderId),second: opaque(b.merchantOrderId),
            relation: a.durationMs === 0 || b.durationMs === 0 ? "UNKNOWN" : Date.parse(a.finishedAt) <= Date.parse(b.startedAt) || Date.parse(b.finishedAt) <= Date.parse(a.startedAt) ? "DISJOINT" : "OVERLAP" }))) };
      }
    } else facts = { orderStatus: e.facts.orderStatus,purchaseUnitCount: e.facts.purchaseUnits?.length ?? 0,
      captureStatuses: e.facts.purchaseUnits?.flatMap(u => u.captures?.map(c => c.status) ?? []) ?? [] };
    return { id: ref,source: e.source,facts };
  });
  const payload = JSON.stringify({ policy: EGRESS_POLICY,evidence });
  if (Buffer.byteLength(payload,"utf8") > 16000) throw new Error("AI_EGRESS_REJECTED");
  return { payload,citationMap };
}
