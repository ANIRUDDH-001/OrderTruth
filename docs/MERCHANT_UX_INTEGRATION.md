# Merchant UX integration contract

Status: **VERIFIED by source inspection**, November 5, 2026. No UX changes delivered by this preparation. **G4 operator usability/build qualification remains NOT TESTED.** This document describes the current V2 judge path, rather than proposing new API behavior.

## Ownership and scope

Claude may own `web/judge/main.ts`, `web/judge/style.css` and `web/judge/index.html` in its separately authorized worktree. Codex must avoid concurrent edits to those files. Preserve the exports/behavior of `web/judge/recovery.ts`, `request.ts` and `diagnostics.ts`; changes there require explicit technical integration review. Leave `web/judge/lab/*`, owner UI, server handlers, database/recovery code, package manifests and dependencies outside the UX edit scope. No new grid/UI dependencies are needed.

Prioritize the incident overview, the recorded captured payment versus active merchant orders, origin labels, read-only investigation, explicit approval, and independently rechecked merchant outcome. Keep the existing failure/recovery controls usable throughout styling changes.

## Session and role boundary

Source: `src/server/session-api.ts`, `src/server/judge-api.ts` and `web/judge/main.ts`.

`GET /api/session` returns `{authenticated:false}` or an authenticated server-derived identity including user ID, owner status and session metadata. Sign-in/out uses `/api/auth/sign-in/anonymous`, `/api/auth/sign-in/email` and `/api/auth/sign-out`; same-origin POSTs and HttpOnly session cookies are required. Auth proxy responses return `{ok:true}` on successful sign-in without exposing a bearer token to application JavaScript.

Operations/engineering views are presentation modes in this judge UI. They are **not independently enforced production engineer/operator/approver RBAC**. The server scopes scenario reads/actions to the persisted session's user and owned run. Never label switching UI views as granting or revoking server privileges. An anonymous authenticated judge may operate its own isolated scenario. Owner identity is separate; do not route judge controls to owner/provider APIs.

## Judge endpoints

Source: `src/server/judge-api.ts`. IDs match `^[a-zA-Z0-9_-]{1,100}$`; action bodies are strict (extra keys rejected), at most 4096 bytes. All judge responses use `Cache-Control: no-store`; POST Origin must exactly match configured origin. Organization, source payment and monetary values come from the server, never browser overrides.

| Endpoint | Body | Response contract / side effect |
|---|---|---|
| `POST /api/scenarios` | `{}` | Creates private controlled merchant run against an eligible owner-approved stored observation; returns scenario snapshot. Does not create a payment. |
| `GET /api/scenarios/:runId` | none | Reads owned run, orders, payment reference and latest plan. |
| `POST /api/scenarios/:runId/duplicate` | `{}` | Deliberately introduces controlled merchant duplicate, returns snapshot. Must remain labeled fault injection. |
| `POST /api/scenarios/:runId/check` | `{}` | `{incidentId:string|null,result:string}`. Persists evaluation/incident as appropriate; this is not a GET-only operation. |
| `POST /api/scenarios/:runId/plan` | `{}` | Checks current incident then returns immutable `RepairPlan`; 409 if none actionable. |
| `POST /api/scenarios/:runId/approve` | `{planId,planSha256}` | `{approved:true,planId,planSha256}`; hash is 64 lowercase hex characters, approval bound to authenticated session and owned run. |
| `POST /api/scenarios/:runId/execute` | `{planId}` | Durable terminal repair outcome; repeated same plan returns stored result. No provider dependency. |
| `GET /api/scenarios/:runId/receipts/:planId` | none | Separate committed-state verification and durable receipt. |
| `GET /api/scenarios/:runId/investigation` | none | Saved investigation history or `null`; optional history must not block receipt recovery. |
| `POST /api/scenarios/:runId/investigate` | `{}` | `FRESH`, `CACHED` or `UNAVAILABLE`; when unconfigured, `freshModelExecution:false`, reason `AI_NOT_CONFIGURED`, evidence and deterministic baseline. May use configured AI: UI review must not invoke it without owner authorization. |
| `POST /api/scenarios/:runId/diagnostics` | `{kind}` | Evidence record for `HANDLER_TIMING`, `IDEMPOTENCY_KEYS` or `MERCHANT_WRITE_OUTCOMES`; merchant/provider state diagnosis only. |

Do not switch the judge frontend to `/api/recovery/*`: `src/merchant/postgres-api.ts` describes a distinct adapter and does not establish judge runtime mounting.

## Frontend data contracts

Source of the minimal UI types and runtime validators: `web/judge/recovery.ts`. Server returns additional fields; preserve forward-compatible reads.

- `Scenario`: `run:{id,label}`, `orders:[{id,effective_status,amount_minor,currency}]`, `paymentReference:{attemptId,evidenceSeq,observedAt,provenance,note}`, optional `latestPlan` with `approved` and `has_receipt`.
- `Plan`: `id`, `plan_sha256`, `keep_order_id`, `void_order_ids_json` (JSON string array), `expires_at`. Full `RepairPlan` in `src/merchant/repair.ts` also binds organization/incident/intent/contract, evaluation/fact hashes, requester and creation time. Preserve the server's exact hash and ID for approval.
- `Receipt`: `receipt:{execution_id,outcome,completed_at,provider_before_sha256,provider_after_sha256}`, `verifiedCurrent`, `current:{activeOrders,matchingKeeper,providerUnchanged}`. Additional server fields are allowed. Display verified recovery only when `verifiedCurrent` is true, not from a successful HTTP response alone.
- Investigation evidence: `{id,source,observedAt,facts}`; source values are `PAYPAL_SANDBOX_OBSERVATION`, `SYNTHETIC_PAYMENT_OBSERVATION`, `CONTROLLED_MERCHANT_STATE`, `MERCHANT_DIAGNOSTIC` (`src/ai/investigation.ts`). Hypotheses cite evidence IDs and remain hypotheses.

## Provenance and repair wording

Source: `src/merchant/postgres-scenarios.ts`, `postgres-recovery.ts`, `src/ai/investigation.ts`.

The run label is `CONTROLLED_MERCHANT_SCENARIO`. Payment reference provenance `PAYPAL_SANDBOX_GET` denotes an original, historical Sandbox API observation; show its timestamp and evidence reference. `SYNTHETIC_QUALIFICATION` denotes synthetic qualification, not a genuine provider payment. Merchant duplicate injection must be labeled `CONTROLLED_FAULT_INJECTION`; it is not proof a real webhook or overlap caused the duplicate. Handler timestamps/keys are diagnostic observations, and causal explanations remain hypotheses until separately demonstrated.

Plans expire after 15 minutes. The preview identifies the surviving order and duplicate order IDs. Approval authorizes the exact current plan, not a general recovery permission. Execution rechecks integrity, session approval, time, current facts and eligibility under database locks. It appends local duplicate-void records, verifies one surviving matching order, and retains evidence. It does not delete the original order history.

Outcome values: `SUCCEEDED`, `REJECTED_INTEGRITY`, `REJECTED_APPROVAL`, `REJECTED_EXPIRED`, `REJECTED_STALE`, `FAILED_POSTCONDITION`. A refusal is a durable outcome, not UI success. Receipt verification separately reads committed merchant state. Provider-before/after hashes compare **stored provider evidence**; they do not mean a fresh PayPal readback occurred during repair. No capture/refund is initiated. Stock, shipping and customer communications are not automatically repaired. Show those limitations beside approval/outcome.

## Failure and uncertain-result behavior

API errors: 400 invalid request; 401 missing session; 403 origin mismatch; 404 missing/unowned scenario; 409 changed/expired/hash/eligibility conflict; 429 admission/action allowance; 503 unavailable source/infrastructure. Show the returned safe message and retain existing case/receipt access. Do not manufacture an empty case or successful repair on error.

Preserve `web/judge/request.ts`: only GET requests retry, capped at six attempts within a shared read budget (90 seconds). POSTs send once (45-second budget). Optional history has an independent 8-second budget. A timeout/network/invalid POST response may follow a committed action. Preserve persisted mutation/creation uncertainty markers, disable dependent writes, and use Resume/Recheck Case to read saved state. Never automatically repeat approval, repair, injection or case creation. A check creates evaluation records, so do not label it purely read-only.

## Qualification handoff

After Claude supplies an authorized patch, Codex reviews the exact file manifest and API compatibility, then runs typecheck, relevant frontend recovery/request tests, frontend build and local integration with a disposable fixture. No live AI/provider calls are necessary for offline qualification. ChatGPT independently reviews operator terminology, evidence distinctions, keyboard/focus/contrast/loading/error/empty states and the full approval-to-receipt journey. Claude's own UX review does not satisfy that independent gate. Hosted judge qualification and submission remain outside Phases 0–5.
