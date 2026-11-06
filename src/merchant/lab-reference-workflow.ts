/** Local-only composition: public signature intake and private checkout-return callback. */
import { createHash } from "node:crypto";
import type { WebhookIntake, IntakeResponse } from "../webhooks/intake.ts";
import type { createReferenceRuntime } from "./lab-reference-runtime.ts";

export function createReferenceWorkflow(o: {
  intake: Pick<WebhookIntake,"receive">;
  processor: { drain(): Promise<number> };
  runtime: Awaited<ReturnType<typeof createReferenceRuntime>>;
}) {
  return {
    /** Invoke from the trusted checkout completion flow, never from a public arbitrary-intent route. */
    onCheckoutReturn: (intentId: string) => o.runtime.returnFor(intentId),
    /** Mount as intake in buildWebhookApp: retains body/rate limits and the exact one-route ingress. */
    receive: async (raw: Buffer, headers: Record<string,string|string[]|undefined>, correlationId: string): Promise<IntakeResponse> => {
      // Only exact bytes of an already authenticated stored event can bypass a
      // second postback. This acknowledges an existing event, never a new delivery.
      let known: Awaited<ReturnType<typeof o.runtime.knownEvent>> = null;
      try {
        const parsed = JSON.parse(raw.toString("utf8"));
        if (typeof parsed.id === "string") known = await o.runtime.knownEvent(parsed.id,createHash("sha256").update(raw).digest("hex"));
      } catch { /* malformed or unavailable storage goes through normal intake */ }
      if (known && ["disagreed","foreign","ignored","failed"].includes(known.state)) return {status:200,body:{ok:true,result:"duplicate"}};
      const accepted = known
        ? {status:200,body:{ok:true,result:"duplicate" as const}}
        : await o.intake.receive(raw,headers,correlationId);
      if (accepted.status !== 200 || !accepted.body.ok) return accepted;
      // Parse ONLY after authenticated durable intake. Runtime loads its proof from storage,
      // not this object; duplicates can never replace the original authenticated event.
      const event = JSON.parse(raw.toString("utf8"));
      if (!["PAYMENT.CAPTURE.COMPLETED","CHECKOUT.ORDER.APPROVED"].includes(event.event_type)) return accepted;
      try {
        await o.processor.drain();
        await o.runtime.webhook(event.id);
        return accepted;
      } catch {
        // PayPal can retry a processing/readback/merchant failure. A committed capture claim
        // is reused; neither this composition nor the runtime has a financial mutation API.
        return { status:503, body:{ok:false,error:"reference_processing_unavailable"} };
      }
    },
  };
}
