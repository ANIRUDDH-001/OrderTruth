import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AttemptRow, IntentRow } from "./store.ts";
import { GATE0_PRODUCT, canTransition, verifyCaptureReadback, type OrderReadback } from "../domain/checkout.ts";
import { summarizeOrder } from "../paypal/summaries.ts";
import { maskId } from "../redact.ts";
import { withTransaction } from "./postgres.ts";

/** Asynchronous checkout persistence under qualification; not wired to public routes. */
export class PostgresCheckoutStore {
  constructor(readonly pool: Pool, readonly schema = "ordertruth") {
    if (schema !== "ordertruth" && !/^qual_[a-f0-9]{20}$/.test(schema)) throw new Error("Invalid OrderTruth schema");
  }
  private transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, async client => {
      await client.query("SELECT set_config('search_path',$1,true)", [`${this.schema},pg_catalog`]);
      return action(client);
    });
  }
  private async lockAttempt(client: PoolClient, id: string): Promise<{ attempt: AttemptRow; intent: IntentRow }> {
    const attempt = (await client.query<AttemptRow>("SELECT * FROM payment_attempts WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!attempt) throw new Error("Payment attempt not found");
    const intent = (await client.query<IntentRow>("SELECT * FROM checkout_intents WHERE id=$1 FOR UPDATE", [attempt.intent_id])).rows[0];
    if (!intent) throw new Error("Payment intent not found");
    return { attempt, intent };
  }
  async createCheckout(key: string): Promise<{ intent: IntentRow; attempt: AttemptRow }> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new Error("Invalid checkout key");
    return this.transaction(async client => {
      const at = new Date().toISOString();
      // The unique key arbitrates concurrent creation; no select-then-insert race.
      await client.query("INSERT INTO checkout_intents(id,sku,currency,amount_minor,correlation_id,created_at,checkout_key) VALUES($1,$2,'USD',$3,$4,$5,$6) ON CONFLICT(checkout_key) DO NOTHING",
        [`ci_${randomUUID()}`, GATE0_PRODUCT.sku, GATE0_PRODUCT.price.minor, `corr_${randomUUID()}`, at, key]);
      const intent = (await client.query<IntentRow>("SELECT * FROM checkout_intents WHERE checkout_key=$1", [key])).rows[0]!;
      await client.query("INSERT INTO payment_attempts(id,intent_id,create_request_id,capture_request_id,state,created_at,updated_at) VALUES($1,$2,$3,$4,'created',$5,$5) ON CONFLICT(intent_id) DO NOTHING",
        [`pa_${randomUUID()}`, intent.id, randomUUID(), randomUUID(), at]);
      const attempt = (await client.query<AttemptRow>("SELECT * FROM payment_attempts WHERE intent_id=$1", [intent.id])).rows[0]!;
      return { intent, attempt };
    });
  }
  async attachOrder(attemptId: string, orderId: string): Promise<boolean> {
    if (!/^[A-Z0-9_]{8,64}$/.test(orderId)) throw new Error("Invalid provider order identifier");
    return this.transaction(async client => {
      await this.lockAttempt(client, attemptId);
      const result = await client.query("UPDATE payment_attempts SET paypal_order_id=$1,provider_order_status='CREATED',state='awaiting_buyer_approval',updated_at=$2 WHERE id=$3 AND state='created' AND paypal_order_id IS NULL",
        [orderId, new Date().toISOString(), attemptId]);
      return result.rowCount === 1;
    });
  }
  async claimCapture(attemptId: string, nowMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid capture claim clock");
    return this.transaction(async client => {
      await this.lockAttempt(client, attemptId);
      const result = await client.query("UPDATE payment_attempts SET state='capture_in_progress',capture_claims=capture_claims+1,capture_claimed_at_ms=$1,updated_at=$2 WHERE id=$3 AND state='approved'",
        [nowMs, new Date(nowMs).toISOString(), attemptId]);
      return result.rowCount === 1;
    });
  }
  /** The provider call must finish before entering here. Observation and its accepted
   * interpretation commit together; this module never makes financial/provider calls. */
  async recordReadback(attemptId: string, raw: OrderReadback, provenance: "SYNTHETIC_QUALIFICATION" | "PAYPAL_SANDBOX_GET"): Promise<{ accepted: boolean; attempt: AttemptRow }> {
    if (!["SYNTHETIC_QUALIFICATION", "PAYPAL_SANDBOX_GET"].includes(provenance)) throw new Error("Explicit observation provenance required");
    return this.transaction(async client => {
      const { attempt, intent } = await this.lockAttempt(client, attemptId);
      if (!attempt.paypal_order_id) throw new Error("Provider order is not attached");
      const at = new Date().toISOString();
      const verdict = verifyCaptureReadback(raw, { orderId: attempt.paypal_order_id,
        amount: { currency: intent.currency, minor: intent.amount_minor }, customId: intent.id });
      await client.query("INSERT INTO evidence(attempt_id,evidence_class,operation,http_status,correlation_id,summary_json,created_at) VALUES($1,'PAYPAL_API_READBACK','readback',200,$2,$3,$4)",
        [attemptId, intent.correlation_id, JSON.stringify({ ...summarizeOrder(raw), provenance }), at]);
      const conflictingIdentity = attempt.capture_id !== null && verdict.captureId !== null && verdict.captureId !== attempt.capture_id;
      const contradictsCapture = attempt.state === "captured" && (verdict.state !== "captured" || verdict.captured?.minor !== attempt.captured_minor || verdict.captured?.currency !== attempt.captured_currency);
      let accepted = false;
      if (conflictingIdentity || contradictsCapture) {
        await client.query("UPDATE payment_attempts SET verdict_reasons=$1,updated_at=$2 WHERE id=$3",
          [JSON.stringify(["Conflicting provider observation; accepted capture identity retained. Investigation required."]), at, attemptId]);
      } else {
        const approvedWithoutCapture = verdict.state === "uncertain" && raw.status === "APPROVED" && !raw.purchase_units?.[0]?.payments?.captures?.length && attempt.state === "awaiting_buyer_approval";
        const next = approvedWithoutCapture ? "approved" : verdict.state;
        if (canTransition(attempt.state, next)) {
          await client.query("UPDATE payment_attempts SET state=$1,provider_order_status=$2,capture_id=$3,capture_status=$4,captured_minor=$5,captured_currency=$6,payee_merchant_masked=$7,verdict_reasons=$8,updated_at=$9 WHERE id=$10",
            [next, verdict.orderStatus, verdict.captureId ?? attempt.capture_id, verdict.captureStatus ?? attempt.capture_status,
              verdict.captured?.minor ?? attempt.captured_minor, verdict.captured?.currency ?? attempt.captured_currency,
              maskId(raw.purchase_units?.[0]?.payee?.merchant_id), JSON.stringify(verdict.reasons), at, attemptId]);
          accepted = true;
        }
      }
      return { accepted, attempt: (await client.query<AttemptRow>("SELECT * FROM payment_attempts WHERE id=$1", [attemptId])).rows[0]! };
    });
  }
}
