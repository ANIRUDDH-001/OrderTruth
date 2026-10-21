export const POSTGRES_BROWSER_APPROVAL_V5 = String.raw`
ALTER TABLE repair_approvals DROP CONSTRAINT repair_approvals_identity_assurance_check;
ALTER TABLE repair_approvals DROP CONSTRAINT repair_approvals_approval_mode_check;
ALTER TABLE repair_approvals ADD COLUMN session_user_id TEXT REFERENCES ot_auth_user(id);
ALTER TABLE repair_approvals ADD CONSTRAINT repair_approval_identity_pair CHECK(
 (approval_mode IN ('INTERACTIVE_TTY','SIMULATED_TEST') AND identity_assurance='LOCAL_DEMO_DECLARED_OPERATOR' AND session_user_id IS NULL)
 OR (approval_mode='BROWSER_SESSION' AND identity_assurance='SESSION_AUTHENTICATED' AND session_user_id IS NOT NULL AND operator_name=session_user_id));
CREATE FUNCTION ot_browser_approval_scope() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
BEGIN
 IF NEW.approval_mode='BROWSER_SESSION' AND NOT EXISTS(SELECT 1 FROM scenario_run_plans p JOIN scenario_runs r ON r.id=p.run_id
   WHERE p.plan_id=NEW.plan_id AND r.user_id=NEW.session_user_id)
 THEN RAISE EXCEPTION 'browser approval must belong to its session scenario'; END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER repair_approvals_01_session BEFORE INSERT ON repair_approvals FOR EACH ROW EXECUTE FUNCTION ot_browser_approval_scope();
CREATE FUNCTION ot_void_scenario_scope() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $ot$
DECLARE order_run TEXT; plan_run TEXT;
BEGIN
 SELECT run_id INTO order_run FROM scenario_run_orders WHERE order_id=NEW.order_id;
 SELECT r.run_id INTO plan_run FROM repair_executions e JOIN scenario_run_plans r ON r.plan_id=e.plan_id WHERE e.id=NEW.execution_id;
 IF order_run IS DISTINCT FROM plan_run THEN RAISE EXCEPTION 'repair cannot cross scenario runs'; END IF;
 IF order_run IS NOT NULL THEN PERFORM 1 FROM scenario_runs WHERE id=order_run FOR UPDATE; END IF;
 RETURN NEW;
END $ot$;
CREATE TRIGGER merchant_order_voids_01_scenario BEFORE INSERT ON merchant_order_voids FOR EACH ROW EXECUTE FUNCTION ot_void_scenario_scope();
`;
