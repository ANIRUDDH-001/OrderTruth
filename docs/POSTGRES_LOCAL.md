# Local PostgreSQL migration checkpoint

The hosted execution plan is being implemented. This checkpoint does not replace the current application runtime yet. It uses synthetic qualification fixtures only and makes no PayPal or model calls.

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

All financial observations in these fixtures are explicitly synthetic. Approvals persist `SIMULATED_TEST`; the qualification identity adapter is not real owner/judge authentication. The application has no public qualification/fault endpoint. PostgreSQL recovery routes are not mounted by the legacy runtime.

## Remaining migration boundaries

The asynchronous checkout and duplicate-repair slice is under qualification. The real checkout gateway, webhook provenance/processing, scenario-run ownership, maintained session authentication, AI investigation and current console still need wiring and qualification. Webhook-linked recovery fails closed until its PostgreSQL provenance implementation is qualified.

Until the application runtime is migrated, legacy commands reject a PostgreSQL `DATABASE_URL` instead of treating credentials as a SQLite filename. For the existing offline console, continue using its explicit synthetic SQLite `--db` workflow documented in the README. Historical SQLite databases are never imported or modified by this checkpoint.

The migration retains explicit PostgreSQL SQL for review rather than translating SQLite statements at runtime. Its 23 base tables and 60 translated guards are followed by four PostgreSQL write-lock/identity guards. Every transaction binds one client; external PayPal/model requests must finish outside that transaction. Hosted correctness must be established separately on the final deployed application.
