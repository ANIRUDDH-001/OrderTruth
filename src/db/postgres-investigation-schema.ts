export const POSTGRES_INVESTIGATION_V6 = String.raw`
CREATE TABLE scenario_handler_attempts (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES scenario_runs(id), handler TEXT NOT NULL CHECK(handler IN('capture_return','webhook_capture_completed')),
 idempotency_key TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
 merchant_order_id TEXT NOT NULL UNIQUE REFERENCES merchant_orders(id) DEFERRABLE INITIALLY DEFERRED,
 UNIQUE(run_id,idempotency_key)
);
CREATE FUNCTION ot_handler_attempt_guard() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF TG_OP='DELETE' OR OLD.finished_at IS NOT NULL OR NEW.finished_at IS NULL
 OR (NEW.id,NEW.run_id,NEW.handler,NEW.idempotency_key,NEW.started_at,NEW.merchant_order_id)
 IS DISTINCT FROM (OLD.id,OLD.run_id,OLD.handler,OLD.idempotency_key,OLD.started_at,OLD.merchant_order_id)
 THEN RAISE EXCEPTION 'committed merchant handler observations are immutable'; END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER scenario_handler_attempts_guard BEFORE UPDATE OR DELETE ON scenario_handler_attempts FOR EACH ROW EXECUTE FUNCTION ot_handler_attempt_guard();
CREATE TABLE scenario_diagnostics (
 id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES scenario_runs(id),kind TEXT NOT NULL CHECK(kind IN('HANDLER_TIMING','IDEMPOTENCY_KEYS','MERCHANT_WRITE_OUTCOMES')),
 facts_json TEXT NOT NULL CHECK(ot_json_valid(facts_json)),created_at TEXT NOT NULL,UNIQUE(run_id,kind)
);
CREATE TRIGGER scenario_diagnostics_immutable BEFORE UPDATE OR DELETE ON scenario_diagnostics FOR EACH ROW EXECUTE FUNCTION ot_scenario_immutable();
CREATE TABLE ai_budget_days(day TEXT PRIMARY KEY,reservations INTEGER NOT NULL DEFAULT 0 CHECK(reservations>=0),last_reserved_at_ms BIGINT NOT NULL DEFAULT 0);
CREATE TABLE ai_investigations (
 id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES scenario_runs(id),user_id TEXT NOT NULL REFERENCES ot_auth_user(id),snapshot_sha256 TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('RESERVED','FRESH','UNAVAILABLE')),model TEXT NOT NULL,requested_at TEXT NOT NULL,completed_at TEXT,
 result_json TEXT,usage_json TEXT,error_kind TEXT,
 CHECK((status='RESERVED' AND completed_at IS NULL) OR (status<>'RESERVED' AND completed_at IS NOT NULL))
);
CREATE INDEX ai_investigations_snapshot ON ai_investigations(run_id,snapshot_sha256,status);
CREATE FUNCTION ot_ai_result_guard() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.status<>'RESERVED' OR NOT EXISTS(SELECT 1 FROM scenario_runs r WHERE r.id=NEW.run_id AND r.user_id=NEW.user_id)
   THEN RAISE EXCEPTION 'AI reservation requires its owned scenario'; END IF;
 ELSE
   IF TG_OP='DELETE' OR OLD.status<>'RESERVED' OR NEW.status NOT IN('FRESH','UNAVAILABLE')
   OR (NEW.id,NEW.run_id,NEW.user_id,NEW.snapshot_sha256,NEW.model,NEW.requested_at)
   IS DISTINCT FROM (OLD.id,OLD.run_id,OLD.user_id,OLD.snapshot_sha256,OLD.model,OLD.requested_at)
   OR (NEW.status='FRESH' AND (NEW.result_json IS NULL OR NEW.usage_json IS NULL))
   THEN RAISE EXCEPTION 'AI terminal result and reservation identity are immutable'; END IF;
 END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER ai_investigations_guard BEFORE INSERT OR UPDATE OR DELETE ON ai_investigations FOR EACH ROW EXECUTE FUNCTION ot_ai_result_guard();
`;
