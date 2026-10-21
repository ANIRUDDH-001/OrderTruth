/** Writers share payment -> intent lock order, including direct merchant writers.
 * Functions capture the owned schema search path when the migration creates them. */
export const POSTGRES_SCHEMA_V2 = String.raw`
CREATE FUNCTION ot_payment_write_guard() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 PERFORM 1 FROM checkout_intents WHERE id=NEW.intent_id FOR UPDATE;
 IF (OLD.capture_id IS NOT NULL AND NEW.capture_id IS DISTINCT FROM OLD.capture_id)
 OR (OLD.state='captured' AND (NEW.capture_status IS DISTINCT FROM OLD.capture_status
   OR NEW.captured_minor IS DISTINCT FROM OLD.captured_minor
   OR NEW.captured_currency IS DISTINCT FROM OLD.captured_currency)) THEN
   RAISE EXCEPTION 'established capture identity and financial facts are immutable';
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER payment_attempts_00_identity BEFORE UPDATE ON payment_attempts FOR EACH ROW EXECUTE FUNCTION ot_payment_write_guard();

CREATE FUNCTION ot_merchant_write_lock() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 PERFORM 1 FROM payment_attempts WHERE id=NEW.attempt_id FOR UPDATE;
 PERFORM 1 FROM checkout_intents WHERE id=NEW.intent_id FOR UPDATE;
 RETURN NEW;
END $ot$;
CREATE TRIGGER merchant_orders_00_lock BEFORE INSERT ON merchant_orders FOR EACH ROW EXECUTE FUNCTION ot_merchant_write_lock();

CREATE FUNCTION ot_void_write_lock() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
DECLARE target merchant_orders%ROWTYPE;
BEGIN
 SELECT * INTO target FROM merchant_orders WHERE id=NEW.order_id;
 PERFORM 1 FROM payment_attempts WHERE id=target.attempt_id FOR UPDATE;
 PERFORM 1 FROM checkout_intents WHERE id=target.intent_id FOR UPDATE;
 RETURN NEW;
END $ot$;
CREATE TRIGGER merchant_order_voids_00_lock BEFORE INSERT ON merchant_order_voids FOR EACH ROW EXECUTE FUNCTION ot_void_write_lock();

CREATE FUNCTION ot_observation_write_lock() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
DECLARE intent TEXT;
BEGIN
 IF NEW.attempt_id IS NOT NULL THEN
   SELECT intent_id INTO intent FROM payment_attempts WHERE id=NEW.attempt_id FOR UPDATE;
   PERFORM 1 FROM checkout_intents WHERE id=intent FOR UPDATE;
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER evidence_00_lock BEFORE INSERT ON evidence FOR EACH ROW EXECUTE FUNCTION ot_observation_write_lock();
`;
