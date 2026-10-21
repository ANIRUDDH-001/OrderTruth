export const POSTGRES_DEMO_LIMITS_V8 = String.raw`
CREATE TABLE demo_action_budgets(key TEXT PRIMARY KEY,used INTEGER NOT NULL CHECK(used>=0));
`;
