# Interactive PostgreSQL application

The assembled application runs with pnpm hosted:local (managed loopback database) or pnpm hosted:start (configured persistent PostgreSQL). The opt-in integration suite uses synthetic fixtures and makes no actual PayPal or model calls.

## Start an isolated database

Install PostgreSQL 18 from its official distribution. On Windows, the helper uses `C:\Program Files\PostgreSQL\18\bin` by default; elsewhere it uses the executables on `PATH`. Set `ORDERTRUTH_PG_BIN` to the installed binary directory if needed.

```powershell
pnpm install --frozen-lockfile
pnpm db:local start
pnpm test:postgres
pnpm db:local stop
```

The helper manages only `.work/postgres/data` on `127.0.0.1:55432`. It does not use or stop an existing system PostgreSQL service. It generates private random credentials in ignored `.work/postgres/.env`, uses SCRAM authentication, and refuses an unmanaged directory or a symlink/junction. `stop` retains committed data; there is no destructive reset command. Do not print, commit or upload the credential file.

If startup fails, verify the binary directory and that port 55432 is available. The PostgreSQL log is `.work/postgres/server.log`. Do not move or delete a nonempty directory merely to make startup pass.

`pnpm db:local check` checks the database identity and local durability settings. These checks are specific to local PostgreSQL; Neon's distributed storage and TLS proxy require separate qualification.

## What the explicit integration command checks

`pnpm test:postgres` opens this managed loopback database and creates unique disposable `qual_…` schemas. It refuses to use the application's `DATABASE_URL`, a remote database, or a different local port. It closes its loopback HTTP listener and removes only its own qualification schemas and fault triggers.

The ordinary `pnpm check` remains offline. The opt-in PostgreSQL suite exercises actual database transactions and HTTP requests, including:

- stable checkout/request identities and a single concurrent capture claim;
- atomic readback observation and accepted interpretation, with conflicting identities retained as uncertainty;
- schema transition, evidence and merchant matching guards;
- plan, exact simulated approval, merchant-only correction and SQL receipt verification;
- concurrent same-plan execution and competing plans;
- stale facts, actual connection termination before commit, and actual TCP response loss after commit;
- recurrence and a concurrent late merchant insert, preserving the prior receipt.
- durable integrity refusals without following corrupted plan references;
- synthetic provider orchestration with read-before-capture, one durable claim across service instances, and GET-only recovery after response loss;
- concurrent verified-event deduplication, expired leases, stale-worker refusal, and PostgreSQL-backed webhook intake/processing;
- maintained guest sessions, expiry/sign-out, origin checks, forged-header refusal and persistent sign-in limits.

All financial observations in these fixtures are explicitly synthetic. Lower-level fixtures label simulated approvals; judge API fixtures exercise maintained sessions and BROWSER_SESSION approval. The application has no public qualification/fault endpoint. PostgreSQL recovery routes are not mounted by the legacy runtime.

## Remaining migration boundaries

The asynchronous checkout, webhook and duplicate-repair paths now have local integration coverage. Better Auth 1.7.12 supplies anonymous judge identities and server-side sessions; its five generated tables are an explicit third migration. Authentication must initialize after migration, with its pool search path bound to the owned schema. Public email registration is disabled. Owner authorization requires an explicit server-side allowlist of non-anonymous user IDs; owner:local and owner:setup privately bootstrap a maintained password account with public signup disabled.

The judge API now binds maintained sessions to immutable scenario-run ownership, exact browser approval and independently checked receipts. Runs reference the original observation and payment rows; they own only controlled merchant orders and case history. A reset creates a new run. Production admission refuses synthetic source evidence. Diagnostic records expose actual controlled-handler timing, deduplication keys and committed writes; model input excludes injected cause/oracle fields. AI reservations, completed results, usage and error states persist in PostgreSQL. Matching snapshots are explicitly cached, and unavailable AI retains labelled rules-based guidance.

Webhook-linked recovery now checks the persisted delivery, evidence and audit chain and binds that graph into its provider hash. Corrupt or contradictory links are refused. This is a consistency check of existing proof, not fresh signature verification. Webhook writers share the payment/intent lock order with repair.

The interactive runtime and judge UI are assembled. Payment-provider tests remain synthetic; genuine Sandbox checkout/signature proof and all deployed-session qualification remain separate gates. Proxy trust and secure-cookie behaviour must be qualified on the actual host before public access.

Legacy commands reject a PostgreSQL `DATABASE_URL` instead of treating credentials as a SQLite filename. For the existing offline console, continue using its explicit synthetic SQLite `--db` workflow documented in the README. Historical SQLite databases are never imported or modified by this checkpoint.

The migration retains explicit PostgreSQL SQL for review rather than translating SQLite statements at runtime. The original 23 tables and 60 translated guards are followed by PostgreSQL identity/write locks, maintained auth tables, immutable scenario references, session approval and bounded investigation records. Every transaction binds one client; external PayPal/model requests must finish outside that transaction. Hosted correctness must be established separately on the final deployed application.


## Interactive setup and deployment

After starting the managed database, run `pnpm build:hosted`, `pnpm owner:local`, then `pnpm hosted:local`. Privately open `.work/local-app/.env` to obtain generated owner credentials. They never appear in command output. Local mode preserves the root Neon DSN and historical SQLite data. Do not run the older console on the same port.

For hosting, configure the private Neon DATABASE_URL, HTTPS APP_ORIGIN, random AUTH_SECRET, Sandbox client credentials and free Gemini key/model. Run `pnpm owner:setup` against that database privately before assigning OWNER_USER_ID on the host. Build with `corepack enable && pnpm install --frozen-lockfile && pnpm build:hosted`; start with `pnpm hosted:start`. Use Node22 and Free compute only. No local filesystem is used for committed application records.

AI defaults to60 application reservations/day,3/user/day,one in-flight request and15-second spacing. Account entitlement was user-reported15RPM/250KTPM/500RPD; no guarantee of provider availability is implied. Original model inputs and results are immutable records; reload history is cached and labelled, never fresh. Guest merchant mutations are limited to100/user/day,250/run lifetime and5000/day globally; read-only receipts remain available. Webhook intake has a pre-persistence global token bucket.

Internal qualification boundary: owner capture interrupted after claim but before POST can remain pending; do not recapture through a new checkout or claim full capture crash recovery. Repair commit interruption/replay is independently tested. Genuine Sandbox checkout, genuine webhook verification, proxy behaviour and actual hosted qualification remain release gates. Free Render idle wake-up and shared workspace limits can affect availability; no artificial keep-alive is used.

Use Neon's direct (unpooled) connection string for this long-lived backend. Its four-connection application pool and maintained authentication use session startup settings; Neon's transaction pooler rejects those settings. Keep TLS certificate verification enabled. The corrected split deployment serves the frontend on Vercel and only the API on one Render Free service in Virginia, with the existing Free Neon project. Set APP_ORIGIN=https://order-truth.vercel.app and SERVE_FRONTEND=false on Render. No disk, worker or separate database service is provisioned.
