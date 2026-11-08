# Phase 6 system design/reliability

**Modular monolith retained; no extra infrastructure.** Vercel frontend, Render API, PostgreSQL durable state. Read-only production metadata reported matching `575433adfe6ba15e593241898f55a962f77e1fec`, schema9, readiness true, maintenance false. This is an observation, not continuous availability.

## Implemented controls

Durable reservations finish before provider calls. Global arbitration bounds one in-flight request. New model-scoped circuit survives service reconstruction:429 → 60 s; three latest transport/outage failures → 30 s. Failed attempts retain their reservations; privacy rejection precedes reservation. No automatic retry or provider failover.

Hosted allowances are clamped to12/day, 3/session/day, 60 s spacing. The unwired Groq adapter does not independently enforce daily quotas: future hosted wiring must use the shared service. Request-byte bounds are conservative inputs, not measured tokenizer entitlement.

Cache identity includes policy version, model and private evidence snapshot. Historical results remain labelled; PWA does not cache API/payment/receipt state or replay writes. In-flight superseded evidence needs F6-12 qualification. Crossed timer milestones now preserve read/write uncertainty messages despite drift. Cancellation never implies rollback. Correctness locks remain; throughput/pool saturation unmeasured.

## Render decision

Account response: compute plan **free**, one instance, autodeploy off; start command forces AI_PROVIDER=disabled and limits0. buildPlan:starter describes build capacity, not a service upgrade. No upgrade occurred.

[Free docs](https://render.com/docs/free) document15-minute idle spin-down, roughly one-minute wake-up and shared limits/suspension. [FAQ](https://render.com/docs/faq) distinguishes paid always-on compute and overages. [Compute-plan docs](https://render.com/docs/compute-plans) use updated plan identifiers; do not blindly rely on a legacy Starter ID/quote.

Always-on compute is recommended only after actual quote, credit coverage through 15 December, no card, no out-of-pocket/overage risk and rollback are verified. Owner-reported approximately$50 credit/expiry is RECORDED_NOT_REPRODUCED. Available account responses do not establish billing eligibility. Upgrade HOLD; no measured before/after latency or cost guarantee. Hosting credit does not pay external inference.

Open: hosted proxy/admission fairness, judge concurrency, cold start, continuous access, backup/restore, retention, alerts and whole-host crash recovery. Two moderate glob/minimatch advisories remain; no unsupported major override was forced for green audit. Operator-assisted coordinated release remains necessary. This branch disables its Vercel Git deployment; no preview or production release is requested.
