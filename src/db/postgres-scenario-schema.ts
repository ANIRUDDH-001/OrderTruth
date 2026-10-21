/** Scenario identity maps reference original payment rows; they never copy a payment. */
export const POSTGRES_SCENARIOS_V4 = String.raw`
CREATE TABLE scenario_runs (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES ot_auth_user(id),
 payment_attempt_id TEXT NOT NULL REFERENCES payment_attempts(id),
 source_evidence_seq BIGINT NOT NULL REFERENCES evidence(seq),
 provenance TEXT NOT NULL CHECK(provenance IN ('PAYPAL_SANDBOX_GET','SYNTHETIC_QUALIFICATION')),
 label TEXT NOT NULL CHECK(label='CONTROLLED_MERCHANT_SCENARIO'), created_at TEXT NOT NULL
);
CREATE INDEX scenario_runs_user ON scenario_runs(user_id);
CREATE TABLE scenario_run_orders (order_id TEXT PRIMARY KEY REFERENCES merchant_orders(id), run_id TEXT NOT NULL REFERENCES scenario_runs(id));
CREATE INDEX scenario_run_orders_run ON scenario_run_orders(run_id);
CREATE TABLE scenario_run_incidents (incident_id TEXT PRIMARY KEY REFERENCES incidents(id), run_id TEXT NOT NULL REFERENCES scenario_runs(id));
CREATE TABLE scenario_run_plans (plan_id TEXT PRIMARY KEY REFERENCES repair_plans(id), run_id TEXT NOT NULL REFERENCES scenario_runs(id));
CREATE FUNCTION ot_scenario_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN RAISE EXCEPTION 'scenario references are append-only; reset creates a new run'; END $ot$;
CREATE TRIGGER scenario_runs_immutable BEFORE UPDATE OR DELETE ON scenario_runs FOR EACH ROW EXECUTE FUNCTION ot_scenario_immutable();
CREATE TRIGGER scenario_run_orders_immutable BEFORE UPDATE OR DELETE ON scenario_run_orders FOR EACH ROW EXECUTE FUNCTION ot_scenario_immutable();
CREATE TRIGGER scenario_run_incidents_immutable BEFORE UPDATE OR DELETE ON scenario_run_incidents FOR EACH ROW EXECUTE FUNCTION ot_scenario_immutable();
CREATE TRIGGER scenario_run_plans_immutable BEFORE UPDATE OR DELETE ON scenario_run_plans FOR EACH ROW EXECUTE FUNCTION ot_scenario_immutable();
CREATE FUNCTION ot_scenario_reference_guard() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM evidence e JOIN payment_attempts a ON a.id=e.attempt_id
   WHERE e.seq=NEW.source_evidence_seq AND a.id=NEW.payment_attempt_id AND a.state='captured'
   AND e.evidence_class='PAYPAL_API_READBACK' AND e.http_status=200 AND e.summary_json::jsonb->>'provenance'=NEW.provenance)
 THEN RAISE EXCEPTION 'scenario requires its original captured-payment observation'; END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER scenario_runs_reference BEFORE INSERT ON scenario_runs FOR EACH ROW EXECUTE FUNCTION ot_scenario_reference_guard();
CREATE FUNCTION ot_scenario_order_guard() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM merchant_orders m JOIN scenario_runs r ON r.payment_attempt_id=m.attempt_id WHERE m.id=NEW.order_id AND r.id=NEW.run_id)
 THEN RAISE EXCEPTION 'scenario order must reference its run payment'; END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER scenario_run_orders_reference BEFORE INSERT ON scenario_run_orders FOR EACH ROW EXECUTE FUNCTION ot_scenario_order_guard();
CREATE FUNCTION ot_scenario_case_guard() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF TG_TABLE_NAME='scenario_run_incidents' THEN
   IF NOT EXISTS(SELECT 1 FROM incidents x JOIN scenario_runs r ON r.payment_attempt_id=x.attempt_id WHERE x.id=NEW.incident_id AND r.id=NEW.run_id)
   THEN RAISE EXCEPTION 'scenario incident must reference its run payment'; END IF;
 ELSE
   IF NOT EXISTS(SELECT 1 FROM repair_plans p JOIN scenario_run_incidents x ON x.incident_id=p.incident_id WHERE p.id=NEW.plan_id AND x.run_id=NEW.run_id)
   THEN RAISE EXCEPTION 'scenario plan must reference its run incident'; END IF;
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER scenario_run_incidents_reference BEFORE INSERT ON scenario_run_incidents FOR EACH ROW EXECUTE FUNCTION ot_scenario_case_guard();
CREATE TRIGGER scenario_run_plans_reference BEFORE INSERT ON scenario_run_plans FOR EACH ROW EXECUTE FUNCTION ot_scenario_case_guard();
`;
