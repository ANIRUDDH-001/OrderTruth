# Hosted application

The [public workspace](https://order-truth.vercel.app) is a static Vercel frontend. Same-origin API requests go to the existing Render API, backed by Neon PostgreSQL. [The execution ledger](EXECUTION_LEDGER_PHASES_7_11.md) records exact qualified sources and deployments.

## Deployment and cost boundary

- Node 22.18.0, schema 9; one owner-upgraded Render 0.5 CPU / 512 MB instance, automatic deployments disabled. No new worker, queue, disk or database was provisioned.
- Vercel builds the static frontend; Render uses the frozen lockfile. SERVE_FRONTEND=false keeps Render API-only.
- Release operator: scripts/release.ts FULL_SHA --database-env PRIVATE_ENV --render RENDER_PATH --approved-groq-rollout. Run --plan first. The rollout flag is separately owner approved, not a default permission.
- HOLD disables AI and closes application traffic. NORMAL explicitly preserves Groq's approved 12 attempts/UTC day, three/session, 65-second spacing and one in flight. No automatic inference retry, paid fallback or key rotation.
- Releases require exact-source CI, financial writer drain, compatible schema, unchanged payment/receipt fingerprints, verified frontend assets and matching readiness on both ingress paths in two rounds. Failures return to verified HOLD and record the failed stage without raw provider payloads.
- Private configuration: Neon connection, auth secret/owner IDs, Sandbox app credentials/webhook ID and provider keys. Never copy owner passwords into hosted configuration or browser code.

Neon's direct endpoint uses verified TLS and a maximum of four connections per application pool. Statements and idle transactions time out after 15 seconds, lock waits after five seconds; connection acquisition is bounded. Existing owner-approved hosting is not a zero-price hosting claim. No additional service purchase is authorized here.

## Judge and owner access

Judges choose **Inspect a payment outcome** without credentials. Each maintained anonymous session owns its isolated controlled merchant cases. Creation references genuine Sandbox evidence and never clones a payment. Duplicate correction requires exact approval and verifies a persisted receipt. Missing-order inspection deliberately omits the reference merchant row, waits at least five minutes from both continuous payment confirmation and case creation, and offers investigation only.

Owner checkout is under the account menu. Payment writes require an owner sign-in less than 15 minutes old. Explicit expiry preserves the order/key and offers password confirmation; it is distinct from a payment timeout. Stored completed payments remain readable after payment-write freshness expires. Guests cannot create, capture or refund payments.

## Reliability and recovery

Durable operation identities reconcile uncertain creation. Concurrent approvals/execution converge on one persisted outcome. AI cache identity includes evidence, model and policy; stale in-flight results are withheld. Provider failures consume reservations and trigger persisted cooldown. Optional AI/history/diagnostic failures preserve case and receipt access. Receipt reads verify current merchant state; service-worker caching excludes APIs and never queues mutations.

Guest allocation is bounded to 30 new identities/minute; session reuse does not consume another allocation. This controls capacity, not unique-human fairness. Model and merchant-action allowances are server enforced. Structured logs contain request IDs, route templates, status and elapsed time, not cookies, raw paths, bodies or credentials.

Measured local qualification: 12 concurrent isolated merchant journeys, 156 HTTP requests, 12 independently verified receipts and 12 cross-session refusals; p50 190 ms, p95 319 ms, maximum 352 ms. This is Windows/PG18 loopback evidence, not hosted throughput. Isolated tests cover commit uncertainty and pool replacement. Whole-host disaster recovery and an uptime guarantee are not established.

## Reproduce locally

Use [PostgreSQL setup](POSTGRES_LOCAL.md), Node 22 and the pinned package manager. Local owner/database identities are separate from hosted accounts. [Judge recovery](JUDGE_RECOVERY.md) documents interrupted-action semantics. Never reset existing data to fix startup. No keep-alive traffic or aggressive hosted load test is required.
