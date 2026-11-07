/** Additive V9: durable operation identity and immutable, expiring admission.
 * No historical payment, scenario, approval or receipt is changed/deleted. */
export const POSTGRES_CREATION_V9 = String.raw`
CREATE TABLE scenario_operations (
 user_id TEXT NOT NULL REFERENCES ot_auth_user(id),
 operation_id TEXT NOT NULL CHECK(operation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 run_id TEXT NOT NULL UNIQUE REFERENCES scenario_runs(id),
 PRIMARY KEY(user_id,operation_id)
);
CREATE FUNCTION ot_scenario_operation_owner() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM scenario_runs WHERE id=NEW.run_id AND user_id=NEW.user_id)
 THEN RAISE EXCEPTION 'operation must reference its owned scenario'; END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER scenario_operations_owner BEFORE INSERT ON scenario_operations FOR EACH ROW EXECUTE FUNCTION ot_scenario_operation_owner();
CREATE TRIGGER scenario_operations_immutable BEFORE UPDATE OR DELETE ON scenario_operations FOR EACH ROW EXECUTE FUNCTION ot_scenario_immutable();
CREATE TABLE scenario_admissions (
 run_id TEXT PRIMARY KEY REFERENCES scenario_runs(id), expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX scenario_admissions_expiry ON scenario_admissions(expires_at);
INSERT INTO scenario_admissions(run_id,expires_at) SELECT id,created_at::timestamptz + interval '1 hour' FROM scenario_runs;
CREATE TRIGGER scenario_admissions_immutable BEFORE UPDATE OR DELETE ON scenario_admissions FOR EACH ROW EXECUTE FUNCTION ot_scenario_immutable();
`;
