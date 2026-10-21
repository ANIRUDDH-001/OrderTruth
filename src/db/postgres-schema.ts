/** PostgreSQL 18 translation of the Gate 3A schema.
 * Qualification only until the API checkpoint passes. No historical database is imported.
 * Explicit SQL retained for review; runtime does not translate SQLite queries.
 */
export const POSTGRES_SCHEMA_V1 = String.raw`

-- SQLite-compatible JSON/text primitives used by the translated guards.
-- These are PostgreSQL functions, not a runtime query translator.
CREATE FUNCTION ot_json_valid(document TEXT) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE SET search_path FROM CURRENT AS $ot$
BEGIN PERFORM document::jsonb; RETURN TRUE;
EXCEPTION WHEN invalid_text_representation THEN RETURN FALSE; END $ot$;
CREATE FUNCTION ot_json_array_length(document TEXT) RETURNS INTEGER LANGUAGE sql IMMUTABLE SET search_path FROM CURRENT AS $ot$
 SELECT jsonb_array_length(document::jsonb) $ot$;
CREATE FUNCTION ot_json_extract(document TEXT, path TEXT) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE SET search_path FROM CURRENT AS $ot$
DECLARE item jsonb; keys text[];
BEGIN
 IF path !~ '^\$\.' THEN RAISE EXCEPTION 'unsupported JSON path'; END IF;
 keys := string_to_array(regexp_replace(substr(path,3), '\[([0-9]+)\]', '.\1', 'g'), '.');
 item := document::jsonb #> keys;
 IF jsonb_typeof(item) IN ('array','object') THEN RETURN item::text; END IF;
 RETURN item #>> '{}';
END $ot$;
CREATE FUNCTION ot_json_each(document TEXT) RETURNS TABLE(value TEXT) LANGUAGE sql IMMUTABLE SET search_path FROM CURRENT AS $ot$
 SELECT jsonb_array_elements_text(document::jsonb) $ot$;
CREATE FUNCTION ot_julianday(value TEXT) RETURNS DOUBLE PRECISION LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $ot$
BEGIN RETURN EXTRACT(EPOCH FROM value::timestamptz)/86400.0 + 2440587.5;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL; END $ot$;


CREATE TABLE schema_migrations (version BIGINT PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE checkout_intents (
     id TEXT PRIMARY KEY,
     sku TEXT NOT NULL,
     currency TEXT NOT NULL CHECK (currency = 'USD'),
     amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
     correlation_id TEXT NOT NULL,
     created_at TEXT NOT NULL
   , checkout_key TEXT, organization_id TEXT NOT NULL DEFAULT 'org_reference');

CREATE TABLE payment_attempts (
     id TEXT PRIMARY KEY,
     intent_id TEXT NOT NULL UNIQUE REFERENCES checkout_intents(id),
     paypal_order_id TEXT UNIQUE,
     create_request_id TEXT NOT NULL UNIQUE,
     capture_request_id TEXT NOT NULL UNIQUE,
     state TEXT NOT NULL,
     provider_order_status TEXT,
     capture_id TEXT UNIQUE,
     capture_status TEXT,
     captured_minor BIGINT,
     captured_currency TEXT,
     payee_merchant_masked TEXT,
     verdict_reasons TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   , capture_claims BIGINT NOT NULL DEFAULT 0, capture_claimed_at_ms BIGINT);

CREATE TABLE evidence (
     seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     attempt_id TEXT REFERENCES payment_attempts(id),
     evidence_class TEXT NOT NULL CHECK (evidence_class IN
       ('PAYPAL_API_READBACK','PAYPAL_API_RESPONSE','PAYPAL_VERIFIED_WEBHOOK','MERCHANT_DB_OBSERVED','CONTROLLED_FAULT_INJECTION','AI_HYPOTHESIS','OPERATOR_STATEMENT')),
     operation TEXT NOT NULL,
     http_status BIGINT,
     paypal_debug_id TEXT,
     request_id TEXT,
     correlation_id TEXT NOT NULL,
     duration_ms BIGINT,
     summary_json TEXT NOT NULL,
     created_at TEXT NOT NULL
   );

CREATE TABLE attempt_transitions (from_state TEXT NOT NULL, to_state TEXT NOT NULL, PRIMARY KEY (from_state, to_state));

CREATE TABLE webhook_deliveries (
     seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     state TEXT NOT NULL,
     claimed_event_id TEXT,
     claimed_event_type TEXT,
     transmission_id TEXT,
     transmission_time TEXT,
     body_sha256 TEXT NOT NULL,
     body_bytes BIGINT NOT NULL,
     reason TEXT,
     correlation_id TEXT NOT NULL,
     verify_ms BIGINT,
     verify_debug_id TEXT,
     received_at_ms BIGINT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );

CREATE TABLE webhook_events (
     event_id TEXT PRIMARY KEY,
     event_type TEXT NOT NULL,
     resource_type TEXT,
     event_create_time TEXT,
     first_delivery_seq BIGINT NOT NULL UNIQUE REFERENCES webhook_deliveries(seq),
     deliveries BIGINT NOT NULL DEFAULT 1,
     state TEXT NOT NULL,
     order_id TEXT,
     attempt_id TEXT REFERENCES payment_attempts(id),
     process_attempts BIGINT NOT NULL DEFAULT 0,
     next_attempt_at_ms BIGINT NOT NULL DEFAULT 0,
     lease_until_ms BIGINT,
     outcome TEXT,
     summary_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );

CREATE TABLE webhook_transitions (subject TEXT NOT NULL, from_state TEXT NOT NULL, to_state TEXT NOT NULL, PRIMARY KEY (subject, from_state, to_state));

CREATE TABLE webhook_audit (
     seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     subject TEXT NOT NULL,
     subject_id TEXT NOT NULL,
     from_state TEXT,
     to_state TEXT NOT NULL,
     reason TEXT,
     at TEXT NOT NULL
   );

CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE fault_injections (
     id TEXT PRIMARY KEY,
     organization_id TEXT NOT NULL REFERENCES organizations(id),
     label TEXT NOT NULL CHECK (label = 'CONTROLLED_FAULT_INJECTION'),
     kind TEXT NOT NULL CHECK (kind IN ('DUPLICATE_ORDER_RACE')),
     intent_id TEXT NOT NULL REFERENCES checkout_intents(id),
     params_json TEXT NOT NULL,
     created_at TEXT NOT NULL
   );

CREATE TABLE merchant_orders (
     id TEXT PRIMARY KEY,
     organization_id TEXT NOT NULL REFERENCES organizations(id),
     intent_id TEXT NOT NULL REFERENCES checkout_intents(id),
     attempt_id TEXT NOT NULL REFERENCES payment_attempts(id),
     paypal_order_id TEXT NOT NULL,
     capture_id TEXT NOT NULL,
     sku TEXT NOT NULL,
     currency TEXT NOT NULL,
     amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
     status TEXT NOT NULL,
     created_by_path TEXT NOT NULL CHECK (created_by_path IN ('capture_return', 'webhook_capture_completed')),
     fault_injection_id TEXT REFERENCES fault_injections(id),
     created_at TEXT NOT NULL
   );

CREATE TABLE invariant_evaluations (
     seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     organization_id TEXT NOT NULL REFERENCES organizations(id),
     contract TEXT NOT NULL,
     intent_id TEXT NOT NULL REFERENCES checkout_intents(id),
     result TEXT NOT NULL CHECK (result IN ('HOLDS', 'VIOLATED', 'NOT_ELIGIBLE', 'OUT_OF_SCOPE')),
     active_order_count BIGINT NOT NULL,
     reasons_json TEXT NOT NULL,
     facts_json TEXT NOT NULL,
     run_id TEXT NOT NULL,
     evaluated_at TEXT NOT NULL
   );

CREATE TABLE incidents (
     id TEXT PRIMARY KEY,
     organization_id TEXT NOT NULL REFERENCES organizations(id),
     contract TEXT NOT NULL,
     dedup_key TEXT NOT NULL UNIQUE,
     severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
     state TEXT NOT NULL,
     intent_id TEXT NOT NULL REFERENCES checkout_intents(id),
     attempt_id TEXT NOT NULL REFERENCES payment_attempts(id),
     paypal_order_id TEXT NOT NULL,
     capture_id TEXT NOT NULL,
     title TEXT NOT NULL,
     opened_by_evaluation_seq BIGINT NOT NULL REFERENCES invariant_evaluations(seq),
     reproduction_json TEXT NOT NULL,
     opened_at TEXT NOT NULL
   , incident_class TEXT NOT NULL DEFAULT 'DUPLICATE_MERCHANT_ORDER'
     CHECK (incident_class IN ('DUPLICATE_MERCHANT_ORDER', 'MISSING_MERCHANT_ORDER')));

CREATE TABLE incident_evidence (
     seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     incident_id TEXT NOT NULL REFERENCES incidents(id),
     evidence_class TEXT NOT NULL CHECK (evidence_class IN ('PAYPAL_API_READBACK', 'PAYPAL_VERIFIED_WEBHOOK', 'MERCHANT_DB_OBSERVED', 'CONTROLLED_FAULT_INJECTION')),
     ref_type TEXT NOT NULL,
     ref_id TEXT NOT NULL,
     source_at TEXT,
     summary_json TEXT NOT NULL,
     linked_at TEXT NOT NULL,
     UNIQUE (incident_id, evidence_class, ref_id),
     CHECK ((evidence_class = 'PAYPAL_API_READBACK' AND ref_type = 'evidence')
         OR (evidence_class = 'PAYPAL_VERIFIED_WEBHOOK' AND ref_type = 'webhook_event')
         OR (evidence_class = 'MERCHANT_DB_OBSERVED' AND ref_type = 'merchant_order')
         OR (evidence_class = 'CONTROLLED_FAULT_INJECTION' AND ref_type = 'fault_injection'))
   );

CREATE TABLE repair_plans (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), incident_id TEXT NOT NULL REFERENCES incidents(id),
 intent_id TEXT NOT NULL REFERENCES checkout_intents(id), contract TEXT NOT NULL, evaluation_seq BIGINT NOT NULL REFERENCES invariant_evaluations(seq),
 keep_order_id TEXT NOT NULL REFERENCES merchant_orders(id), void_order_ids_json TEXT NOT NULL CHECK(ot_json_valid(void_order_ids_json)),
 cause_at_plan TEXT NOT NULL, facts_json TEXT NOT NULL CHECK(ot_json_valid(facts_json)), facts_sha256 TEXT NOT NULL CHECK(length(facts_sha256)=64),
 plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64), requester_name TEXT NOT NULL CHECK(length(trim(requester_name)) BETWEEN 1 AND 100),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 CHECK(ot_julianday(expires_at)>ot_julianday(created_at)), CHECK(ot_json_array_length(void_order_ids_json)>0)
);

CREATE TABLE repair_approvals (
 id TEXT PRIMARY KEY, plan_id TEXT NOT NULL UNIQUE REFERENCES repair_plans(id), plan_sha256 TEXT NOT NULL,
 operator_name TEXT NOT NULL CHECK(length(trim(operator_name)) BETWEEN 1 AND 100),
 identity_assurance TEXT NOT NULL CHECK(identity_assurance='LOCAL_DEMO_DECLARED_OPERATOR'),
 approval_mode TEXT NOT NULL CHECK(approval_mode IN ('INTERACTIVE_TTY','SIMULATED_TEST')), approved_at TEXT NOT NULL
);

CREATE TABLE repair_executions (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL UNIQUE REFERENCES repair_plans(id), started_at TEXT NOT NULL);

CREATE TABLE repair_transitions (execution_id TEXT PRIMARY KEY REFERENCES repair_executions(id), state TEXT NOT NULL CHECK(state='EXECUTING'), recorded_at TEXT NOT NULL);

CREATE TABLE merchant_order_voids (order_id TEXT PRIMARY KEY REFERENCES merchant_orders(id), execution_id TEXT NOT NULL REFERENCES repair_executions(id),
 reason TEXT NOT NULL CHECK(reason='DUPLICATE_MERCHANT_ORDER'), created_at TEXT NOT NULL);

CREATE TABLE incident_resolutions (incident_id TEXT PRIMARY KEY REFERENCES incidents(id), evaluation_seq BIGINT NOT NULL UNIQUE REFERENCES invariant_evaluations(seq),
 execution_id TEXT NOT NULL UNIQUE REFERENCES repair_executions(id), created_at TEXT NOT NULL);

CREATE TABLE repair_outcomes (execution_id TEXT PRIMARY KEY REFERENCES repair_executions(id),
 outcome TEXT NOT NULL CHECK(outcome IN ('SUCCEEDED','REJECTED_INTEGRITY','REJECTED_APPROVAL','REJECTED_EXPIRED','REJECTED_STALE','FAILED_POSTCONDITION')),
 reasons_json TEXT NOT NULL CHECK(ot_json_valid(reasons_json)), provider_before_sha256 TEXT NOT NULL, provider_after_sha256 TEXT NOT NULL, completed_at TEXT NOT NULL);

CREATE TABLE repair_audit (seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES repair_plans(id),
 event TEXT NOT NULL CHECK(event IN ('PLANNED','APPROVED','SUCCEEDED','REJECTED_INTEGRITY','REJECTED_APPROVAL','REJECTED_EXPIRED','REJECTED_STALE','FAILED_POSTCONDITION')),
 detail_json TEXT NOT NULL CHECK(ot_json_valid(detail_json)), created_at TEXT NOT NULL);

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('approved','capture_in_progress');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('approved','captured');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('approved','denied');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('approved','mismatch');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('approved','pending');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('approved','uncertain');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('awaiting_buyer_approval','approved');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('awaiting_buyer_approval','captured');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('awaiting_buyer_approval','denied');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('awaiting_buyer_approval','mismatch');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('awaiting_buyer_approval','pending');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('awaiting_buyer_approval','uncertain');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('capture_in_progress','captured');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('capture_in_progress','denied');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('capture_in_progress','mismatch');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('capture_in_progress','pending');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('capture_in_progress','uncertain');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('created','awaiting_buyer_approval');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('pending','captured');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('pending','denied');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('pending','mismatch');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('pending','uncertain');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('uncertain','capture_in_progress');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('uncertain','captured');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('uncertain','denied');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('uncertain','mismatch');

INSERT INTO attempt_transitions (from_state,to_state) VALUES ('uncertain','pending');

INSERT INTO webhook_transitions (subject,from_state,to_state) VALUES ('delivery','received_unverified','abandoned');

INSERT INTO webhook_transitions (subject,from_state,to_state) VALUES ('delivery','received_unverified','duplicate');

INSERT INTO webhook_transitions (subject,from_state,to_state) VALUES ('delivery','received_unverified','rejected');

INSERT INTO webhook_transitions (subject,from_state,to_state) VALUES ('delivery','received_unverified','retryable_failure');

INSERT INTO webhook_transitions (subject,from_state,to_state) VALUES ('delivery','received_unverified','verified');

INSERT INTO webhook_transitions (subject,from_state,to_state) VALUES ('event','processing','disagreed');

INSERT INTO webhook_transitions (subject,from_state,to_state) VALUES ('event','processing','failed');

INSERT INTO webhook_transitions (subject,from_state,to_state) VALUES ('event','processing','foreign');

INSERT INTO webhook_transitions (subject,from_state,to_state) VALUES ('event','processing','ignored');

INSERT INTO webhook_transitions (subject,from_state,to_state) VALUES ('event','processing','processed');

INSERT INTO webhook_transitions (subject,from_state,to_state) VALUES ('event','processing','retryable_failure');

INSERT INTO webhook_transitions (subject,from_state,to_state) VALUES ('event','retryable_failure','processing');

INSERT INTO webhook_transitions (subject,from_state,to_state) VALUES ('event','verified_pending','processing');

INSERT INTO organizations (id,name,created_at) VALUES ('org_reference','OrderTruth reference merchant','2026-10-19T00:00:00.000Z');

CREATE UNIQUE INDEX checkout_intents_checkout_key ON checkout_intents(checkout_key);

CREATE INDEX webhook_deliveries_claimed_event ON webhook_deliveries(claimed_event_id);

CREATE INDEX webhook_deliveries_state ON webhook_deliveries(state, received_at_ms);

CREATE INDEX webhook_events_due ON webhook_events(state, next_attempt_at_ms);

CREATE INDEX merchant_orders_intent ON merchant_orders(organization_id, intent_id);

CREATE INDEX invariant_evaluations_intent ON invariant_evaluations(organization_id, intent_id, seq);

CREATE FUNCTION evidence_no_update_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='evidence is append-only', ERRCODE='23514';
 RETURN NEW;
END $ot$;
CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence FOR EACH ROW EXECUTE FUNCTION evidence_no_update_fn();

CREATE FUNCTION evidence_no_delete_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='evidence is append-only', ERRCODE='23514';
 RETURN OLD;
END $ot$;
CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence FOR EACH ROW EXECUTE FUNCTION evidence_no_delete_fn();

CREATE FUNCTION attempt_transitions_static_i_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='attempt_transitions is static', ERRCODE='23514';
 RETURN NEW;
END $ot$;
CREATE TRIGGER attempt_transitions_static_i BEFORE INSERT ON attempt_transitions FOR EACH ROW EXECUTE FUNCTION attempt_transitions_static_i_fn();

CREATE FUNCTION attempt_transitions_static_u_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='attempt_transitions is static', ERRCODE='23514';
 RETURN NEW;
END $ot$;
CREATE TRIGGER attempt_transitions_static_u BEFORE UPDATE ON attempt_transitions FOR EACH ROW EXECUTE FUNCTION attempt_transitions_static_u_fn();

CREATE FUNCTION attempt_transitions_static_d_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='attempt_transitions is static', ERRCODE='23514';
 RETURN OLD;
END $ot$;
CREATE TRIGGER attempt_transitions_static_d BEFORE DELETE ON attempt_transitions FOR EACH ROW EXECUTE FUNCTION attempt_transitions_static_d_fn();

CREATE FUNCTION payment_attempts_initial_state_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF NEW.state <> 'created' THEN
 RAISE EXCEPTION USING MESSAGE='illegal attempt state transition: new attempts start as created', ERRCODE='23514';
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER payment_attempts_initial_state BEFORE INSERT ON payment_attempts FOR EACH ROW EXECUTE FUNCTION payment_attempts_initial_state_fn();

CREATE FUNCTION payment_attempts_state_guard_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF OLD.state <> NEW.state AND NOT EXISTS (SELECT 1 FROM attempt_transitions WHERE from_state = OLD.state AND to_state = NEW.state) THEN
 RAISE EXCEPTION USING MESSAGE='illegal attempt state transition', ERRCODE='23514';
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER payment_attempts_state_guard BEFORE UPDATE OF state ON payment_attempts FOR EACH ROW EXECUTE FUNCTION payment_attempts_state_guard_fn();

CREATE FUNCTION webhook_transitions_static_i_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='webhook_transitions is static', ERRCODE='23514';
 RETURN NEW;
END $ot$;
CREATE TRIGGER webhook_transitions_static_i BEFORE INSERT ON webhook_transitions FOR EACH ROW EXECUTE FUNCTION webhook_transitions_static_i_fn();

CREATE FUNCTION webhook_transitions_static_u_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='webhook_transitions is static', ERRCODE='23514';
 RETURN NEW;
END $ot$;
CREATE TRIGGER webhook_transitions_static_u BEFORE UPDATE ON webhook_transitions FOR EACH ROW EXECUTE FUNCTION webhook_transitions_static_u_fn();

CREATE FUNCTION webhook_transitions_static_d_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='webhook_transitions is static', ERRCODE='23514';
 RETURN OLD;
END $ot$;
CREATE TRIGGER webhook_transitions_static_d BEFORE DELETE ON webhook_transitions FOR EACH ROW EXECUTE FUNCTION webhook_transitions_static_d_fn();

CREATE FUNCTION webhook_audit_no_update_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='webhook_audit is append-only', ERRCODE='23514';
 RETURN NEW;
END $ot$;
CREATE TRIGGER webhook_audit_no_update BEFORE UPDATE ON webhook_audit FOR EACH ROW EXECUTE FUNCTION webhook_audit_no_update_fn();

CREATE FUNCTION webhook_audit_no_delete_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='webhook_audit is append-only', ERRCODE='23514';
 RETURN OLD;
END $ot$;
CREATE TRIGGER webhook_audit_no_delete BEFORE DELETE ON webhook_audit FOR EACH ROW EXECUTE FUNCTION webhook_audit_no_delete_fn();

CREATE FUNCTION webhook_deliveries_no_delete_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='webhook deliveries are append-only', ERRCODE='23514';
 RETURN OLD;
END $ot$;
CREATE TRIGGER webhook_deliveries_no_delete BEFORE DELETE ON webhook_deliveries FOR EACH ROW EXECUTE FUNCTION webhook_deliveries_no_delete_fn();

CREATE FUNCTION webhook_events_no_delete_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='webhook events are append-only', ERRCODE='23514';
 RETURN OLD;
END $ot$;
CREATE TRIGGER webhook_events_no_delete BEFORE DELETE ON webhook_events FOR EACH ROW EXECUTE FUNCTION webhook_events_no_delete_fn();

CREATE FUNCTION webhook_deliveries_initial_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF NEW.state <> 'received_unverified' THEN
 RAISE EXCEPTION USING MESSAGE='illegal webhook delivery state: deliveries start as received_unverified', ERRCODE='23514';
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER webhook_deliveries_initial BEFORE INSERT ON webhook_deliveries FOR EACH ROW EXECUTE FUNCTION webhook_deliveries_initial_fn();

CREATE FUNCTION webhook_deliveries_guard_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF OLD.state <> NEW.state AND NOT EXISTS (SELECT 1 FROM webhook_transitions WHERE subject = 'delivery' AND from_state = OLD.state AND to_state = NEW.state) THEN
 RAISE EXCEPTION USING MESSAGE='illegal webhook delivery state transition', ERRCODE='23514';
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER webhook_deliveries_guard BEFORE UPDATE OF state ON webhook_deliveries FOR EACH ROW EXECUTE FUNCTION webhook_deliveries_guard_fn();

CREATE FUNCTION webhook_events_initial_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF NEW.state <> 'verified_pending'
       OR NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.seq = NEW.first_delivery_seq AND d.state = 'verified' AND d.claimed_event_id = NEW.event_id) THEN
 RAISE EXCEPTION USING MESSAGE='webhook event requires a PayPal-verified delivery of the same event id', ERRCODE='23514';
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER webhook_events_initial BEFORE INSERT ON webhook_events FOR EACH ROW EXECUTE FUNCTION webhook_events_initial_fn();

CREATE FUNCTION webhook_events_guard_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF OLD.state <> NEW.state AND NOT EXISTS (SELECT 1 FROM webhook_transitions WHERE subject = 'event' AND from_state = OLD.state AND to_state = NEW.state) THEN
 RAISE EXCEPTION USING MESSAGE='illegal webhook event state transition', ERRCODE='23514';
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER webhook_events_guard BEFORE UPDATE OF state ON webhook_events FOR EACH ROW EXECUTE FUNCTION webhook_events_guard_fn();

CREATE FUNCTION webhook_deliveries_audit_i_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 INSERT INTO webhook_audit (subject, subject_id, from_state, to_state, reason, at) VALUES ('delivery', CAST(NEW.seq AS TEXT), NULL, NEW.state, NEW.reason, NEW.updated_at);
 RETURN NEW;
END $ot$;
CREATE TRIGGER webhook_deliveries_audit_i AFTER INSERT ON webhook_deliveries FOR EACH ROW EXECUTE FUNCTION webhook_deliveries_audit_i_fn();

CREATE FUNCTION webhook_deliveries_audit_u_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF OLD.state <> NEW.state THEN
 INSERT INTO webhook_audit (subject, subject_id, from_state, to_state, reason, at) VALUES ('delivery', CAST(NEW.seq AS TEXT), OLD.state, NEW.state, NEW.reason, NEW.updated_at);
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER webhook_deliveries_audit_u AFTER UPDATE OF state ON webhook_deliveries FOR EACH ROW EXECUTE FUNCTION webhook_deliveries_audit_u_fn();

CREATE FUNCTION webhook_events_audit_i_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 INSERT INTO webhook_audit (subject, subject_id, from_state, to_state, reason, at) VALUES ('event', NEW.event_id, NULL, NEW.state, 'delivery ' || NEW.first_delivery_seq, NEW.updated_at);
 RETURN NEW;
END $ot$;
CREATE TRIGGER webhook_events_audit_i AFTER INSERT ON webhook_events FOR EACH ROW EXECUTE FUNCTION webhook_events_audit_i_fn();

CREATE FUNCTION webhook_events_audit_u_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF OLD.state <> NEW.state THEN
 INSERT INTO webhook_audit (subject, subject_id, from_state, to_state, reason, at) VALUES ('event', NEW.event_id, OLD.state, NEW.state, NEW.outcome, NEW.updated_at);
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER webhook_events_audit_u AFTER UPDATE OF state ON webhook_events FOR EACH ROW EXECUTE FUNCTION webhook_events_audit_u_fn();

CREATE FUNCTION organizations_no_delete_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='organizations are never deleted', ERRCODE='23514';
 RETURN OLD;
END $ot$;
CREATE TRIGGER organizations_no_delete BEFORE DELETE ON organizations FOR EACH ROW EXECUTE FUNCTION organizations_no_delete_fn();

CREATE FUNCTION checkout_intents_org_i_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = NEW.organization_id) THEN
 RAISE EXCEPTION USING MESSAGE='unknown organization', ERRCODE='23514';
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER checkout_intents_org_i BEFORE INSERT ON checkout_intents FOR EACH ROW EXECUTE FUNCTION checkout_intents_org_i_fn();

CREATE FUNCTION checkout_intents_org_u_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF OLD.organization_id <> NEW.organization_id THEN
 RAISE EXCEPTION USING MESSAGE='intent organization is immutable', ERRCODE='23514';
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER checkout_intents_org_u BEFORE UPDATE OF organization_id ON checkout_intents FOR EACH ROW EXECUTE FUNCTION checkout_intents_org_u_fn();

CREATE FUNCTION fault_injections_org_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM checkout_intents i WHERE i.id = NEW.intent_id AND i.organization_id = NEW.organization_id) THEN
 RAISE EXCEPTION USING MESSAGE='fault injection intent belongs to another organization', ERRCODE='23514';
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER fault_injections_org BEFORE INSERT ON fault_injections FOR EACH ROW EXECUTE FUNCTION fault_injections_org_fn();

CREATE FUNCTION fault_injections_no_update_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='fault injections are append-only', ERRCODE='23514';
 RETURN NEW;
END $ot$;
CREATE TRIGGER fault_injections_no_update BEFORE UPDATE ON fault_injections FOR EACH ROW EXECUTE FUNCTION fault_injections_no_update_fn();

CREATE FUNCTION fault_injections_no_delete_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='fault injections are append-only', ERRCODE='23514';
 RETURN OLD;
END $ot$;
CREATE TRIGGER fault_injections_no_delete BEFORE DELETE ON fault_injections FOR EACH ROW EXECUTE FUNCTION fault_injections_no_delete_fn();

CREATE FUNCTION merchant_orders_no_update_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='merchant orders are immutable in Stage 1C', ERRCODE='23514';
 RETURN NEW;
END $ot$;
CREATE TRIGGER merchant_orders_no_update BEFORE UPDATE ON merchant_orders FOR EACH ROW EXECUTE FUNCTION merchant_orders_no_update_fn();

CREATE FUNCTION merchant_orders_no_delete_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='merchant orders are never deleted', ERRCODE='23514';
 RETURN OLD;
END $ot$;
CREATE TRIGGER merchant_orders_no_delete BEFORE DELETE ON merchant_orders FOR EACH ROW EXECUTE FUNCTION merchant_orders_no_delete_fn();

CREATE FUNCTION invariant_evaluations_no_update_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='invariant evaluations are append-only', ERRCODE='23514';
 RETURN NEW;
END $ot$;
CREATE TRIGGER invariant_evaluations_no_update BEFORE UPDATE ON invariant_evaluations FOR EACH ROW EXECUTE FUNCTION invariant_evaluations_no_update_fn();

CREATE FUNCTION invariant_evaluations_no_delete_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='invariant evaluations are append-only', ERRCODE='23514';
 RETURN OLD;
END $ot$;
CREATE TRIGGER invariant_evaluations_no_delete BEFORE DELETE ON invariant_evaluations FOR EACH ROW EXECUTE FUNCTION invariant_evaluations_no_delete_fn();

CREATE FUNCTION incidents_i_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF NEW.state <> 'open'
       OR NOT EXISTS (SELECT 1 FROM invariant_evaluations e WHERE e.seq = NEW.opened_by_evaluation_seq AND e.result = 'VIOLATED'
                      AND e.intent_id = NEW.intent_id AND e.organization_id = NEW.organization_id) THEN
 RAISE EXCEPTION USING MESSAGE='incident must open from a VIOLATED evaluation of the same organization intent', ERRCODE='23514';
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER incidents_i BEFORE INSERT ON incidents FOR EACH ROW EXECUTE FUNCTION incidents_i_fn();

CREATE FUNCTION incidents_no_delete_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='incidents are never deleted', ERRCODE='23514';
 RETURN OLD;
END $ot$;
CREATE TRIGGER incidents_no_delete BEFORE DELETE ON incidents FOR EACH ROW EXECUTE FUNCTION incidents_no_delete_fn();

CREATE FUNCTION incident_evidence_ref_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF NOT (
       (NEW.ref_type = 'evidence' AND EXISTS (SELECT 1 FROM evidence e JOIN incidents x ON x.id = NEW.incident_id
          WHERE CAST(e.seq AS TEXT) = NEW.ref_id AND CAST(e.seq AS TEXT) = NEW.ref_id
            AND e.evidence_class = 'PAYPAL_API_READBACK' AND e.http_status = 200 AND e.attempt_id = x.attempt_id))
       OR (NEW.ref_type = 'webhook_event' AND EXISTS (SELECT 1 FROM webhook_events w JOIN webhook_deliveries d ON d.seq = w.first_delivery_seq JOIN incidents x ON x.id = NEW.incident_id
          WHERE w.event_id = NEW.ref_id AND w.state = 'processed' AND d.state = 'verified' AND w.attempt_id = x.attempt_id))
       OR (NEW.ref_type = 'merchant_order' AND EXISTS (SELECT 1 FROM merchant_orders m JOIN incidents x ON x.id = NEW.incident_id
          WHERE m.id = NEW.ref_id AND m.intent_id = x.intent_id AND m.organization_id = x.organization_id))
       OR (NEW.ref_type = 'fault_injection' AND EXISTS (SELECT 1 FROM fault_injections f JOIN incidents x ON x.id = NEW.incident_id
          WHERE f.id = NEW.ref_id AND f.intent_id = x.intent_id AND f.organization_id = x.organization_id))
     ) THEN
 RAISE EXCEPTION USING MESSAGE='incident evidence must reference an existing record of its own class, intent and organization', ERRCODE='23514';
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER incident_evidence_ref BEFORE INSERT ON incident_evidence FOR EACH ROW EXECUTE FUNCTION incident_evidence_ref_fn();

CREATE FUNCTION incident_evidence_no_update_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='incident evidence is append-only', ERRCODE='23514';
 RETURN NEW;
END $ot$;
CREATE TRIGGER incident_evidence_no_update BEFORE UPDATE ON incident_evidence FOR EACH ROW EXECUTE FUNCTION incident_evidence_no_update_fn();

CREATE FUNCTION incident_evidence_no_delete_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='incident evidence is append-only', ERRCODE='23514';
 RETURN OLD;
END $ot$;
CREATE TRIGGER incident_evidence_no_delete BEFORE DELETE ON incident_evidence FOR EACH ROW EXECUTE FUNCTION incident_evidence_no_delete_fn();

CREATE FUNCTION merchant_orders_i_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF NEW.status<>'placed' OR NOT EXISTS (
 SELECT 1 FROM checkout_intents i JOIN payment_attempts a ON a.intent_id=i.id
 WHERE i.id=NEW.intent_id AND a.id=NEW.attempt_id AND i.organization_id=NEW.organization_id
 AND a.state='captured' AND a.capture_status='COMPLETED' AND a.captured_minor=i.amount_minor AND a.captured_currency=i.currency
 AND a.paypal_order_id=NEW.paypal_order_id AND a.capture_id=NEW.capture_id
 AND i.sku=NEW.sku AND i.currency=NEW.currency AND i.amount_minor=NEW.amount_minor)
 OR (NEW.fault_injection_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fault_injections f
 WHERE f.id=NEW.fault_injection_id AND f.intent_id=NEW.intent_id AND f.organization_id=NEW.organization_id)) THEN
 RAISE EXCEPTION USING MESSAGE='merchant order must match COMPLETED captured payment and organization', ERRCODE='23514';
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER merchant_orders_i BEFORE INSERT ON merchant_orders FOR EACH ROW EXECUTE FUNCTION merchant_orders_i_fn();

CREATE FUNCTION repair_plans_i_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF NOT EXISTS (
 SELECT 1 FROM incidents x JOIN invariant_evaluations e ON e.seq=NEW.evaluation_seq JOIN merchant_orders m ON m.id=NEW.keep_order_id
 WHERE x.id=NEW.incident_id AND x.organization_id=NEW.organization_id AND x.intent_id=NEW.intent_id AND x.contract=NEW.contract
 AND e.organization_id=x.organization_id AND e.intent_id=x.intent_id AND e.result='VIOLATED'
 AND m.organization_id=x.organization_id AND m.intent_id=x.intent_id) THEN
 RAISE EXCEPTION USING MESSAGE='repair plan scope mismatch', ERRCODE='23514';
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER repair_plans_i BEFORE INSERT ON repair_plans FOR EACH ROW EXECUTE FUNCTION repair_plans_i_fn();

CREATE FUNCTION repair_approvals_i_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF NOT EXISTS (
 SELECT 1 FROM repair_plans p WHERE p.id=NEW.plan_id AND p.plan_sha256=NEW.plan_sha256
 AND NEW.approved_at>=p.created_at AND NEW.approved_at<p.expires_at
 AND NOT EXISTS(SELECT 1 FROM incident_resolutions r WHERE r.incident_id=p.incident_id)
 AND NOT EXISTS(SELECT 1 FROM repair_executions e WHERE e.plan_id=p.id)) THEN
 RAISE EXCEPTION USING MESSAGE='approval requires current unconsumed plan and exact hash', ERRCODE='23514';
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER repair_approvals_i BEFORE INSERT ON repair_approvals FOR EACH ROW EXECUTE FUNCTION repair_approvals_i_fn();

CREATE FUNCTION merchant_order_voids_i_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF NOT EXISTS (
 SELECT 1 FROM repair_executions e JOIN repair_transitions t ON t.execution_id=e.id JOIN repair_plans p ON p.id=e.plan_id
 JOIN repair_approvals a ON a.plan_id=p.id JOIN merchant_orders m ON m.id=NEW.order_id
 JOIN checkout_intents i ON i.id=m.intent_id JOIN payment_attempts b ON b.id=m.attempt_id
 WHERE e.id=NEW.execution_id AND a.plan_sha256=p.plan_sha256 AND m.organization_id=p.organization_id AND m.intent_id=p.intent_id AND m.id<>p.keep_order_id
 AND EXISTS(SELECT 1 FROM ot_json_each(p.void_order_ids_json) j WHERE j.value=m.id)
 AND b.intent_id=i.id AND b.state='captured' AND b.capture_status='COMPLETED' AND b.captured_minor=i.amount_minor AND b.captured_currency=i.currency
 AND m.paypal_order_id=b.paypal_order_id AND m.capture_id=b.capture_id AND m.sku=i.sku AND m.amount_minor=i.amount_minor AND m.currency=i.currency
 AND NOT EXISTS(SELECT 1 FROM repair_outcomes o WHERE o.execution_id=e.id)
 AND NOT EXISTS(SELECT 1 FROM incident_resolutions r WHERE r.incident_id=p.incident_id)) THEN
 RAISE EXCEPTION USING MESSAGE='void requires executing approved scoped plan and matching non-keeper', ERRCODE='23514';
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER merchant_order_voids_i BEFORE INSERT ON merchant_order_voids FOR EACH ROW EXECUTE FUNCTION merchant_order_voids_i_fn();

CREATE FUNCTION incident_resolutions_i_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF NOT EXISTS (
 SELECT 1 FROM repair_executions e JOIN repair_plans p ON p.id=e.plan_id JOIN incidents x ON x.id=p.incident_id JOIN invariant_evaluations v ON v.seq=NEW.evaluation_seq
 WHERE e.id=NEW.execution_id AND x.id=NEW.incident_id AND v.organization_id=p.organization_id AND v.intent_id=p.intent_id AND v.contract=p.contract
 AND v.result='HOLDS' AND v.active_order_count=1 AND v.seq>x.opened_by_evaluation_seq AND v.run_id=e.id
 AND ot_json_array_length(ot_json_extract(v.facts_json,'$.matchingOrderIds'))=1 AND ot_json_extract(v.facts_json,'$.matchingOrderIds[0]')=p.keep_order_id
 AND NOT EXISTS(SELECT 1 FROM repair_outcomes o WHERE o.execution_id=e.id)) THEN
 RAISE EXCEPTION USING MESSAGE='resolution requires later scoped HOLDS postcondition for keeper', ERRCODE='23514';
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER incident_resolutions_i BEFORE INSERT ON incident_resolutions FOR EACH ROW EXECUTE FUNCTION incident_resolutions_i_fn();

CREATE FUNCTION repair_outcomes_i_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF (NEW.outcome='SUCCEEDED' AND (NEW.provider_before_sha256<>NEW.provider_after_sha256 OR NOT EXISTS (SELECT 1 FROM incident_resolutions r WHERE r.execution_id=NEW.execution_id)))
 OR (NEW.outcome<>'SUCCEEDED' AND (EXISTS(SELECT 1 FROM merchant_order_voids v WHERE v.execution_id=NEW.execution_id) OR EXISTS(SELECT 1 FROM incident_resolutions r WHERE r.execution_id=NEW.execution_id))) THEN
 RAISE EXCEPTION USING MESSAGE='terminal outcome inconsistent with correction', ERRCODE='23514';
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER repair_outcomes_i BEFORE INSERT ON repair_outcomes FOR EACH ROW EXECUTE FUNCTION repair_outcomes_i_fn();

CREATE FUNCTION repair_plans_no_update_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='repair history is append-only', ERRCODE='23514';
 RETURN NEW;
END $ot$;
CREATE TRIGGER repair_plans_no_update BEFORE UPDATE ON repair_plans FOR EACH ROW EXECUTE FUNCTION repair_plans_no_update_fn();

CREATE FUNCTION repair_plans_no_delete_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='repair history is append-only', ERRCODE='23514';
 RETURN OLD;
END $ot$;
CREATE TRIGGER repair_plans_no_delete BEFORE DELETE ON repair_plans FOR EACH ROW EXECUTE FUNCTION repair_plans_no_delete_fn();

CREATE FUNCTION repair_approvals_no_update_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='repair history is append-only', ERRCODE='23514';
 RETURN NEW;
END $ot$;
CREATE TRIGGER repair_approvals_no_update BEFORE UPDATE ON repair_approvals FOR EACH ROW EXECUTE FUNCTION repair_approvals_no_update_fn();

CREATE FUNCTION repair_approvals_no_delete_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='repair history is append-only', ERRCODE='23514';
 RETURN OLD;
END $ot$;
CREATE TRIGGER repair_approvals_no_delete BEFORE DELETE ON repair_approvals FOR EACH ROW EXECUTE FUNCTION repair_approvals_no_delete_fn();

CREATE FUNCTION repair_executions_no_update_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='repair history is append-only', ERRCODE='23514';
 RETURN NEW;
END $ot$;
CREATE TRIGGER repair_executions_no_update BEFORE UPDATE ON repair_executions FOR EACH ROW EXECUTE FUNCTION repair_executions_no_update_fn();

CREATE FUNCTION repair_executions_no_delete_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='repair history is append-only', ERRCODE='23514';
 RETURN OLD;
END $ot$;
CREATE TRIGGER repair_executions_no_delete BEFORE DELETE ON repair_executions FOR EACH ROW EXECUTE FUNCTION repair_executions_no_delete_fn();

CREATE FUNCTION repair_transitions_no_update_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='repair history is append-only', ERRCODE='23514';
 RETURN NEW;
END $ot$;
CREATE TRIGGER repair_transitions_no_update BEFORE UPDATE ON repair_transitions FOR EACH ROW EXECUTE FUNCTION repair_transitions_no_update_fn();

CREATE FUNCTION repair_transitions_no_delete_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='repair history is append-only', ERRCODE='23514';
 RETURN OLD;
END $ot$;
CREATE TRIGGER repair_transitions_no_delete BEFORE DELETE ON repair_transitions FOR EACH ROW EXECUTE FUNCTION repair_transitions_no_delete_fn();

CREATE FUNCTION merchant_order_voids_no_update_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='repair history is append-only', ERRCODE='23514';
 RETURN NEW;
END $ot$;
CREATE TRIGGER merchant_order_voids_no_update BEFORE UPDATE ON merchant_order_voids FOR EACH ROW EXECUTE FUNCTION merchant_order_voids_no_update_fn();

CREATE FUNCTION merchant_order_voids_no_delete_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='repair history is append-only', ERRCODE='23514';
 RETURN OLD;
END $ot$;
CREATE TRIGGER merchant_order_voids_no_delete BEFORE DELETE ON merchant_order_voids FOR EACH ROW EXECUTE FUNCTION merchant_order_voids_no_delete_fn();

CREATE FUNCTION incident_resolutions_no_update_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='repair history is append-only', ERRCODE='23514';
 RETURN NEW;
END $ot$;
CREATE TRIGGER incident_resolutions_no_update BEFORE UPDATE ON incident_resolutions FOR EACH ROW EXECUTE FUNCTION incident_resolutions_no_update_fn();

CREATE FUNCTION incident_resolutions_no_delete_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='repair history is append-only', ERRCODE='23514';
 RETURN OLD;
END $ot$;
CREATE TRIGGER incident_resolutions_no_delete BEFORE DELETE ON incident_resolutions FOR EACH ROW EXECUTE FUNCTION incident_resolutions_no_delete_fn();

CREATE FUNCTION repair_outcomes_no_update_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='repair history is append-only', ERRCODE='23514';
 RETURN NEW;
END $ot$;
CREATE TRIGGER repair_outcomes_no_update BEFORE UPDATE ON repair_outcomes FOR EACH ROW EXECUTE FUNCTION repair_outcomes_no_update_fn();

CREATE FUNCTION repair_outcomes_no_delete_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='repair history is append-only', ERRCODE='23514';
 RETURN OLD;
END $ot$;
CREATE TRIGGER repair_outcomes_no_delete BEFORE DELETE ON repair_outcomes FOR EACH ROW EXECUTE FUNCTION repair_outcomes_no_delete_fn();

CREATE FUNCTION repair_audit_no_update_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='repair history is append-only', ERRCODE='23514';
 RETURN NEW;
END $ot$;
CREATE TRIGGER repair_audit_no_update BEFORE UPDATE ON repair_audit FOR EACH ROW EXECUTE FUNCTION repair_audit_no_update_fn();

CREATE FUNCTION repair_audit_no_delete_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='repair history is append-only', ERRCODE='23514';
 RETURN OLD;
END $ot$;
CREATE TRIGGER repair_audit_no_delete BEFORE DELETE ON repair_audit FOR EACH ROW EXECUTE FUNCTION repair_audit_no_delete_fn();

CREATE FUNCTION incidents_no_update_fn() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 RAISE EXCEPTION USING MESSAGE='incidents are immutable', ERRCODE='23514';
 RETURN NEW;
END $ot$;
CREATE TRIGGER incidents_no_update BEFORE UPDATE ON incidents FOR EACH ROW EXECUTE FUNCTION incidents_no_update_fn();
`;
