/** Migration 6: append-only local repair journal; original v3 database requires separate approval. */
const immutable = (t: string) => `CREATE TRIGGER ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT,'repair history is append-only'); END;
CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'repair history is append-only'); END;`;
export const REPAIR_MIGRATION = `
DROP TRIGGER merchant_orders_i;
CREATE TRIGGER merchant_orders_i BEFORE INSERT ON merchant_orders WHEN NEW.status<>'placed' OR NOT EXISTS (
 SELECT 1 FROM checkout_intents i JOIN payment_attempts a ON a.intent_id=i.id
 WHERE i.id=NEW.intent_id AND a.id=NEW.attempt_id AND i.organization_id=NEW.organization_id
 AND a.state='captured' AND a.capture_status='COMPLETED' AND a.captured_minor=i.amount_minor AND a.captured_currency=i.currency
 AND a.paypal_order_id=NEW.paypal_order_id AND a.capture_id=NEW.capture_id
 AND i.sku=NEW.sku AND i.currency=NEW.currency AND i.amount_minor=NEW.amount_minor)
 OR (NEW.fault_injection_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fault_injections f
 WHERE f.id=NEW.fault_injection_id AND f.intent_id=NEW.intent_id AND f.organization_id=NEW.organization_id))
BEGIN SELECT RAISE(ABORT,'merchant order must match COMPLETED captured payment and organization'); END;
CREATE TABLE repair_plans (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), incident_id TEXT NOT NULL REFERENCES incidents(id),
 intent_id TEXT NOT NULL REFERENCES checkout_intents(id), contract TEXT NOT NULL, evaluation_seq INTEGER NOT NULL REFERENCES invariant_evaluations(seq),
 keep_order_id TEXT NOT NULL REFERENCES merchant_orders(id), void_order_ids_json TEXT NOT NULL CHECK(json_valid(void_order_ids_json)),
 cause_at_plan TEXT NOT NULL, facts_json TEXT NOT NULL CHECK(json_valid(facts_json)), facts_sha256 TEXT NOT NULL CHECK(length(facts_sha256)=64),
 plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64), requester_name TEXT NOT NULL CHECK(length(trim(requester_name)) BETWEEN 1 AND 100),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 CHECK(julianday(expires_at)>julianday(created_at)), CHECK(json_array_length(void_order_ids_json)>0)
);
CREATE TRIGGER repair_plans_i BEFORE INSERT ON repair_plans WHEN NOT EXISTS (
 SELECT 1 FROM incidents x JOIN invariant_evaluations e ON e.seq=NEW.evaluation_seq JOIN merchant_orders m ON m.id=NEW.keep_order_id
 WHERE x.id=NEW.incident_id AND x.organization_id=NEW.organization_id AND x.intent_id=NEW.intent_id AND x.contract=NEW.contract
 AND e.organization_id=x.organization_id AND e.intent_id=x.intent_id AND e.result='VIOLATED'
 AND m.organization_id=x.organization_id AND m.intent_id=x.intent_id)
BEGIN SELECT RAISE(ABORT,'repair plan scope mismatch'); END;
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
CREATE TABLE incident_resolutions (incident_id TEXT PRIMARY KEY REFERENCES incidents(id), evaluation_seq INTEGER NOT NULL UNIQUE REFERENCES invariant_evaluations(seq),
 execution_id TEXT NOT NULL UNIQUE REFERENCES repair_executions(id), created_at TEXT NOT NULL);
CREATE TABLE repair_outcomes (execution_id TEXT PRIMARY KEY REFERENCES repair_executions(id),
 outcome TEXT NOT NULL CHECK(outcome IN ('SUCCEEDED','REJECTED_INTEGRITY','REJECTED_APPROVAL','REJECTED_EXPIRED','REJECTED_STALE','FAILED_POSTCONDITION')),
 reasons_json TEXT NOT NULL CHECK(json_valid(reasons_json)), provider_before_sha256 TEXT NOT NULL, provider_after_sha256 TEXT NOT NULL, completed_at TEXT NOT NULL);
CREATE TABLE repair_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT NOT NULL REFERENCES repair_plans(id),
 event TEXT NOT NULL CHECK(event IN ('PLANNED','APPROVED','SUCCEEDED','REJECTED_INTEGRITY','REJECTED_APPROVAL','REJECTED_EXPIRED','REJECTED_STALE','FAILED_POSTCONDITION')),
 detail_json TEXT NOT NULL CHECK(json_valid(detail_json)), created_at TEXT NOT NULL);
CREATE TRIGGER repair_approvals_i BEFORE INSERT ON repair_approvals WHEN NOT EXISTS (
 SELECT 1 FROM repair_plans p WHERE p.id=NEW.plan_id AND p.plan_sha256=NEW.plan_sha256
 AND NEW.approved_at>=p.created_at AND NEW.approved_at<p.expires_at
 AND NOT EXISTS(SELECT 1 FROM incident_resolutions r WHERE r.incident_id=p.incident_id)
 AND NOT EXISTS(SELECT 1 FROM repair_executions e WHERE e.plan_id=p.id))
BEGIN SELECT RAISE(ABORT,'approval requires current unconsumed plan and exact hash'); END;
CREATE TRIGGER merchant_order_voids_i BEFORE INSERT ON merchant_order_voids WHEN NOT EXISTS (
 SELECT 1 FROM repair_executions e JOIN repair_transitions t ON t.execution_id=e.id JOIN repair_plans p ON p.id=e.plan_id
 JOIN repair_approvals a ON a.plan_id=p.id JOIN merchant_orders m ON m.id=NEW.order_id
 JOIN checkout_intents i ON i.id=m.intent_id JOIN payment_attempts b ON b.id=m.attempt_id
 WHERE e.id=NEW.execution_id AND a.plan_sha256=p.plan_sha256 AND m.organization_id=p.organization_id AND m.intent_id=p.intent_id AND m.id<>p.keep_order_id
 AND EXISTS(SELECT 1 FROM json_each(p.void_order_ids_json) j WHERE j.value=m.id)
 AND b.intent_id=i.id AND b.state='captured' AND b.capture_status='COMPLETED' AND b.captured_minor=i.amount_minor AND b.captured_currency=i.currency
 AND m.paypal_order_id=b.paypal_order_id AND m.capture_id=b.capture_id AND m.sku=i.sku AND m.amount_minor=i.amount_minor AND m.currency=i.currency
 AND NOT EXISTS(SELECT 1 FROM repair_outcomes o WHERE o.execution_id=e.id)
 AND NOT EXISTS(SELECT 1 FROM incident_resolutions r WHERE r.incident_id=p.incident_id))
BEGIN SELECT RAISE(ABORT,'void requires executing approved scoped plan and matching non-keeper'); END;
CREATE TRIGGER incident_resolutions_i BEFORE INSERT ON incident_resolutions WHEN NOT EXISTS (
 SELECT 1 FROM repair_executions e JOIN repair_plans p ON p.id=e.plan_id JOIN incidents x ON x.id=p.incident_id JOIN invariant_evaluations v ON v.seq=NEW.evaluation_seq
 WHERE e.id=NEW.execution_id AND x.id=NEW.incident_id AND v.organization_id=p.organization_id AND v.intent_id=p.intent_id AND v.contract=p.contract
 AND v.result='HOLDS' AND v.active_order_count=1 AND v.seq>x.opened_by_evaluation_seq AND v.run_id=e.id
 AND json_array_length(json_extract(v.facts_json,'$.matchingOrderIds'))=1 AND json_extract(v.facts_json,'$.matchingOrderIds[0]')=p.keep_order_id
 AND NOT EXISTS(SELECT 1 FROM repair_outcomes o WHERE o.execution_id=e.id))
BEGIN SELECT RAISE(ABORT,'resolution requires later scoped HOLDS postcondition for keeper'); END;
CREATE TRIGGER repair_outcomes_i BEFORE INSERT ON repair_outcomes WHEN
 (NEW.outcome='SUCCEEDED' AND (NEW.provider_before_sha256<>NEW.provider_after_sha256 OR NOT EXISTS (SELECT 1 FROM incident_resolutions r WHERE r.execution_id=NEW.execution_id)))
 OR (NEW.outcome<>'SUCCEEDED' AND (EXISTS(SELECT 1 FROM merchant_order_voids v WHERE v.execution_id=NEW.execution_id) OR EXISTS(SELECT 1 FROM incident_resolutions r WHERE r.execution_id=NEW.execution_id)))
BEGIN SELECT RAISE(ABORT,'terminal outcome inconsistent with correction'); END;
${['repair_plans','repair_approvals','repair_executions','repair_transitions','merchant_order_voids','incident_resolutions','repair_outcomes','repair_audit'].map(immutable).join('\n')}
`;
