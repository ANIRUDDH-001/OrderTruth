# Hosted application

The public frontend is https://order-truth.vercel.app on Vercel. Render Free serves only the backend at https://ordertruth.onrender.com, using the existing Neon Free PostgreSQL project. Vercel forwards /api/* to that backend, preserving one browser origin and maintained secure cookies. Render does not serve frontend pages.

## Reproduce locally

Follow POSTGRES_LOCAL.md: Node22, pinned pnpm, PostgreSQL18, private Sandbox/free Gemini configuration, then db:local start, build:hosted, owner:local and hosted:local. Local mode uses its own database and owner credentials; it does not reuse the hosted owner's password.

## Deploy configuration

- Repository: ANIRUDDH-001/OrderTruth, main. Render automatic deployments are disabled; releases are deliberate.
- Runtime: Node22.18.0, one Free web service, Virginia; no disks, workers or Render database.
- Vercel build: `pnpm build:frontend`; output dist/judge includes the owner page. Render build: `corepack enable && pnpm install --frozen-lockfile && pnpm build:hosted` (the runtime does not serve those assets).
- Start: `pnpm hosted:start`; bind0.0.0.0 using Render's PORT.
- Private configuration: direct Neon DATABASE_URL, random AUTH_SECRET, OWNER_USER_ID, Sandbox PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET, and the free AI_API_KEY.
- Public configuration: APP_ORIGIN=https://order-truth.vercel.app and SERVE_FRONTEND=false on Render; PAYPAL_ENV=sandbox; PAYPAL_API_BASE=https://api-m.sandbox.paypal.com; AI_PROVIDER=gemini; AI_MODEL=gemini-3.5-flash-lite; AI_DAILY_LIMIT=60; AI_USER_DAILY_LIMIT=3.
- Bootstrap the hosted owner privately using owner:setup with that origin and database. Credentials stay in the ignored root.env. Public signup is disabled. Never transfer the owner password or deployment API key into the app environment.
- Use Neon's direct endpoint, not its transaction pooler: authentication and bounded startup settings require session connections. TLS certificate verification remains enabled; the application pool is capped at four.

Committed observations, sessions, cases, exact approvals, model inputs/results and receipts live in Neon. Render restarts do not reseed records. Apply only the application's additive migrations; do not reset a database to fix startup.

## Owner and judge entry

Use Owner access on the homepage, then Open owner Sandbox checkout. Only the owner can perform authorized genuine Sandbox checkout. A successful authoritative captured readback makes the original observation eligible for judge runs; payment rows are never cloned. Judges start anonymous maintained sessions and isolated controlled merchant scenarios. They cannot capture or refund.

A reset starts a new case and preserves the prior receipt. AI failures and exhausted allowances are labelled; cached results show their original generation time. Read-only receipts remain available when mutation limits are reached. Explicit checks/resume actions drive recovery; no always-running timer is assumed.

## Free-tier operation

Use Free plans only. No card or paid upgrade was authorized. Render can sleep after idle periods and suspend services when shared free allowances are exhausted. Neon and model allowances also apply; free availability is not guaranteed. Do not add keep-alive traffic, paid fallbacks or automatic key rotation. Keep the local workflow available for judging contingencies.

The split-host release is commitbd8a293, schema8. Live HTTPS startup/session/authorization checks are recorded privately; payment, AI and recovery acceptance must be confirmed through the deployed journey before submission claims are made. Do not publish private cookies, credentials or raw provider payloads in a demo recording.
