/**
 * OrderTruth Guard, production entry point (spec §5, §6.1). Never imports ./testing: the test capture authority is reachable
 * only from the explicit testing entry, and tests/v3/entrypoint.test.ts checks that statically.
 */
export { createGuard, type CreateOrderOutcome, type CreateOrderResult, type Guard, type GuardOptions, type RejectReason, type Resolution } from "./guard.ts";
export { CommitEvidenceInconsistent, CommitOutcomeUnknown, GuardRetryableError, NotCommittedEstablished, type Boundary, type EventualState } from "./commit.ts";
export { verifyMac, type CaptureCapability } from "./capability.ts";
export { ConfigError, validateConfig, type GuardConfig, type RegisteredStatement } from "./config.ts";
export { migrateGuard } from "./schema.ts";
