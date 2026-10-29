# OrderTruth

OrderTruth checks one rule for a merchant that takes PayPal payments: **one completed capture must produce exactly one live store order.** When the rule breaks, it opens an incident with linked evidence (a duplicate order, or a missing order after a grace period). For duplicates, it offers a narrow repair that needs an explicit approval and only changes the store's own records, never PayPal.

The interactive prototype combines isolated merchant scenarios, evidence-grounded AI investigation, exact browser approval and independently checked recovery receipts. Payment observations and controlled merchant faults are labelled separately. Merchant recovery never changes PayPal financial records.

## Hosted application

**https://order-truth.vercel.app** — open it and choose *Start judge experience*. No account is needed.

| Layer | Host | Notes |
|---|---|---|
| Frontend | Vercel (static build of `web/judge` and `web/owner`) | Rewrites `/api/*` to the API host, so the browser stays same-origin. |
| API | Render, one Free web service (`pnpm hosted:start`) | API only (`SERVE_FRONTEND=false`). Free services sleep when idle: the first request after a sleep took **53 s** in a measurement on 2026-10-23; warm requests were under 1 s. |
| Database | Neon PostgreSQL (Free) | Sessions, cases, approvals, AI inputs/results and receipts persist across restarts. |
| Payments | PayPal **Sandbox** only | The API refuses any non-Sandbox base URL. |
| AI | Google Gemini (`gemini-3.5-flash-lite`, free tier) | Bounded allowance; see limits below. |

Each judge gets an anonymous, server-side session and their own isolated merchant run. All runs point at one original, owner-captured PayPal Sandbox observation. Judges can introduce a controlled duplicate order, detect it, investigate with AI, run read-only diagnostics, approve the exact repair plan, execute it, and re-check or export the receipt. Judges cannot create, capture or refund payments.

Deployment details: [hosted application](docs/HOSTED_APPLICATION.md).

## Interactive application (local)

See [interactive setup](docs/POSTGRES_LOCAL.md) for the PostgreSQL workflow:

```powershell
pnpm db:local start
pnpm build:hosted
pnpm owner:local
pnpm hosted:local
```

Open `http://127.0.0.1:3003`. Owner credentials are generated only in ignored `.work/local-app/.env`; open that file privately and use Owner access. Genuine Sandbox checkout requires the owner's manual approval through `/owner/`. Judge admission requires an authoritative captured Sandbox observation; synthetic fixtures cannot satisfy it. Judges work in their own controlled merchant run, with no capture or refund access.

Fresh, cached and unavailable AI states are explicit. The configured free-model allowance is bounded; rules-based guidance and receipt access continue when inference is unavailable. Historical investigations retain the exact evidence originally supplied to the model. Deployment qualification is tracked separately from local tests.

The older offline console below remains available for synthetic exploration; stop it before using the interactive application on the same port.

## Offline console (legacy, synthetic data)

Everything from here to "Console" describes the earlier SQLite console. It is kept for offline exploration and as a judging fallback. It is not the hosted application.

## Requirements

| Tool | Version | Notes |
|---|---|---|
| Node.js | `>=22.13.0 <23` (verified on 22.18.0) | Uses the built-in `node:sqlite` module. Node prints an `ExperimentalWarning` for it; that is expected. |
| pnpm | `11.4.0` (pinned in `packageManager`) | `corepack enable` will select it. |
| OS | Verified on Windows 11. | Other platforms are NOT_TESTED. |

No database server, Docker, paid service or account is needed for the offline demo.

## Quick start (offline, synthetic data)

```bash
pnpm install --frozen-lockfile
pnpm check            # typecheck + full test suite (offline)
pnpm build            # builds the checkout page and the console into dist/
pnpm console:demo     # seeds a NEW synthetic database at .work/console-demo/console.sqlite
pnpm incidents --db .work/console-demo/console.sqlite
```

Open `http://127.0.0.1:3003/console/`. The console starts in the `org_reference` scope.

What the demo database contains:

- 8 synthetic checkouts with readbacks labelled `DEMO…`. No PayPal call is made.
- 3 open incidents: 2 duplicate orders, created by a labelled controlled fault, and 1 missing order.
- 1 payment that is still inside its 5 minute grace period.

About 5 minutes after seeding, run the checker again:

```bash
pnpm console:demo --recheck --out .work/console-demo/console.sqlite
```

The waiting payment then becomes a missing-order incident. Before you re-run, the Overview says the deadline passed without a re-check; it never claims an all-clear.

`--recheck` refuses any file that is not an unmodified demo database built by this tool. It also refuses the protected historical databases. It checks this before it writes or migrates anything.

### Repairing a duplicate order

```bash
pnpm repair plan    --db <isolated.sqlite> --org org_reference --incident <inc_id> --requester "<your name>"
pnpm repair approve --db <isolated.sqlite> --org org_reference --plan <rp_id> --plan-sha256 <sha> --operator "<your name>"
pnpm repair execute --db <isolated.sqlite> --org org_reference --plan <rp_id>
pnpm repair history --db <isolated.sqlite> --org org_reference --incident <inc_id>
```

- `approve` needs an interactive terminal and a typed confirmation. It refuses to run without a TTY.
- The approver's name is declared, not authenticated.
- `execute` voids the extra order in the store and re-checks the rule. It does not contact PayPal: no refund and no capture. The stored PayPal evidence hash is compared before and after.
- Approvals created by test fixtures are stored with `approval_mode = SIMULATED_TEST`, and the console labels them "simulated in a test".

## Console

`pnpm incidents --db <file> [--port 3003]` serves two things on `127.0.0.1` only:

- the read-only incident API (`/api/incidents`, `/api/incidents/:id`, `/api/incidents/:id/advisory`, `/api/evaluations`)
- the console at `/console/`

Every request is scoped by the `x-ordertruth-org` header. The console sets this header from its scope picker or from `?org=` in a link.

| Page | Shows |
|---|---|
| Overview | A headline verdict. Captured value counts only captures confirmed by a stored PayPal readback. It also lists open incidents and payments waiting for an order, with their grace status. |
| Incidents | Open, resolved and all incidents. Incidents are never deleted. |
| Checkouts | The latest rule check for every checkout, with the reason for its result. |
| Incident | **Operations lens:** a reconciliation ribbon, a timeline, affected orders, the next step and the receipt. **Engineering lens:** the contract check, linked evidence, the repair record, rules-only guidance and identifiers. |

Old `/investigation/<id>?org=…` links redirect into the Engineering lens and keep the org. A malformed or repeated org gets a 400 and is never replaced by a default.

The console shows **stored** checks. It never runs the checker, never re-reads PayPal, and never shows sample data in place of real records. If the API is down, it says so.

## Modes

| Mode | What it touches | How to run |
|---|---|---|
| Hosted (default for judges) | Vercel + Render + Neon, one original PayPal Sandbox observation, isolated merchant runs | https://order-truth.vercel.app |
| Local interactive | Managed local PostgreSQL on `127.0.0.1:55432` | See "Interactive application (local)" above |
| Offline console | Local SQLite only, with synthetic `DEMO…` identifiers | `pnpm check`, `pnpm console:demo`, `pnpm incidents`, `pnpm repair` |
| PayPal Sandbox CLI | PayPal **Sandbox** Orders v2 API (virtual funds), using credentials you put in a local `.env` | Copy `.env.example` to `.env` and fill it in privately. Then use `pnpm start` (checkout on 127.0.0.1) and `pnpm cli oauth-check / create / readback / capture / reconcile`. |

- Production PayPal endpoints are not permitted (`PAYPAL_ENV=sandbox`).
- Webhook listening (`pnpm webhooks`) needs a registered Sandbox webhook and an HTTPS tunnel. It was proven live locally once, in Gate 1B. The hosted API mounts `/api/paypal/webhook` only when `PAYPAL_WEBHOOK_ID` is configured, and hosted webhook delivery is **NOT_TESTED**. Webhooks are not part of the judge path.
- The tests never call PayPal or any model. They use local fakes.

## Trust boundaries and security limits

### Hosted application

- **Sessions:** Better Auth 1.7.12 with server-side sessions stored in PostgreSQL. Judges sign in anonymously; sessions last 60 days. Cookies are `HttpOnly`, `SameSite=Lax` and `Secure` over HTTPS. No bearer token reaches page scripts.
- **Owner:** one password account, created privately with `pnpm owner:setup`, and allow-listed by user ID on the server. Public sign-up is disabled. Payment actions (create order, capture) require an owner session that signed in within the last 15 minutes.
- **Judges:** a run is bound to the session that created it; another session gets `404`. Judge routes have no payment or refund capability. All state-changing browser requests require the app's own `Origin`.
- **Repair approval:** binds the exact plan hash to the approving session (`BROWSER_SESSION`). The repair voids extra merchant orders only. It never calls PayPal, and the stored PayPal evidence hash is compared before and after.
- **AI:** the model only proposes hypotheses and a read-only diagnostic. It cannot execute repairs or payment calls. Model input excludes the injected cause. Results are labelled *fresh*, *cached* or *unavailable*; when unavailable, rules-based guidance is shown instead.
- **Limits** (shared across restarts, stored in PostgreSQL): AI 60 calls/day for the app and 3 per user per day, one call in flight, 15 s spacing; merchant actions 100 per user per day, 250 per run, 5,000 per day globally; anonymous sign-in 5/min and auth calls 60/min. Read-only receipts never consume an allowance.
- **Known limitation:** the API does not trust proxy headers (`trustProxy: false`), so sign-in rate limits are keyed to the hosting proxy's address. In practice, all visitors share one sign-in bucket.
- **Secrets** live only in host environment settings and the ignored local `.env`. They are never sent to the browser, except the public PayPal Sandbox client ID for the owner's checkout.

### Offline console (legacy)

- **No authentication or RBAC.** The org scope is a development header, not a login. Anyone who can reach the port can read every org.
- The console and its CLI tools bind to `127.0.0.1` only.
- Repair approval is a typed name in a terminal. Separation of duties is not enforced.
- PayPal facts in the console come from readbacks stored at the time of the check, and are labelled "not re-read here".
- Controlled fault injections, such as the duplicate-order race `REF-BUG-1`, are labelled as lab faults, never as customer events.
- AI advisory is off by default (`AI_PROVIDER=disabled`). The console then shows rules-only guidance and says that no model was called. No model output can trigger any PayPal or store action.
- Secrets live only in your local `.env`, which is git-ignored, and are redacted in logs. Local databases (`*.sqlite`), `.work/` and `dist/` are git-ignored.
- The console runs under a strict CSP (`default-src 'self'`, no inline script) with `no-store`, `nosniff` and `no-referrer`.

## Tests

```bash
pnpm typecheck
pnpm test             # vitest; offline; latest local check: 36 files / 761 tests
pnpm check            # both
```

The tests cover:

- capture and readback state machines
- restart and concurrency (two OS processes sharing one SQLite file)
- webhook signature and deduplication against a mocked PayPal
- duplicate and missing-order detection, including negative controls
- the repair flow and its postconditions
- the console model, serving and deep links
- demo-recheck provenance (`tests/gate3a-console-correctness.test.ts`)

## What is not proven

- A full judge rehearsal on the final deployed version, on desktop and mobile: **NOT_TESTED**. Startup, session and authorization checks on the live HTTPS deployment were recorded privately; the full browser journey has not been re-run on the final version.
- Hosted webhook delivery (genuine signed event, duplicate retry, interruption): **NOT_TESTED**.
- AI value: **not demonstrated.** The older Gate 2C advisory evaluation tied the stronger no-model control at 10/10; see `docs/GATE2C_AI_RESULTS.md`. The separate 16-case investigator analysis is now complete: both AI reviewers' comparisons against both deterministic controls return **REGRESSION** under the frozen rules. Those are AI-reviewed, post-hoc exploratory results, with substantial reviewer disagreement, missing historical rubric definitions and disclosed blinding/checkpoint limitations—not confirmatory evidence of general model inferiority. See [investigator results](docs/INVESTIGATOR_EVAL_RESULTS.md). Human merchant usefulness remains **NOT_TESTED**.
- Free-tier availability through the judging period (Render sleep and suspension, Neon and Gemini allowances): **not guaranteed**. Availability is checked manually; no keep-alive traffic is used.
- Role-based access beyond owner/judge, and multi-tenant isolation beyond per-session run ownership: **not built**.
- Screen-reader use, a full WCAG 2.2 audit, performance under load, and real users: **NOT_TESTED**.
- Real Sandbox checkouts do not trigger merchant checks automatically. Hosted detection and repair run on isolated, controlled merchant runs that reference one genuine Sandbox observation. The offline console uses local and synthetic data, plus one recorded real-evidence run (`docs/STAGE1D_RESULTS.md`).
- Platforms other than Windows for local development: **NOT_TESTED**.

The per-criterion status is in `docs/QUALITY_GATE_MATRIX.md`. The Gate 3A evidence is in `docs/GATE3A_RESULTS.md`.

## Repository map

| Path | Contents |
|---|---|
| `src/paypal`, `src/server`, `src/webhooks` | Sandbox checkout, readback, reconciler, webhook listener, hosted app, sessions and judge API |
| `src/merchant` | Reference merchant, rule checker, incidents, repair, scenarios, recovery, incident API and console host |
| `src/ai` | Investigation (Gemini + rules baseline), advisory adapter and holdout evaluation |
| `src/db` | PostgreSQL schema and migrations; legacy SQLite store |
| `web/judge` | Hosted judge and owner UI (vanilla TypeScript) |
| `web/console` | Legacy offline console UI (vanilla TypeScript, no framework) |
| `tests` | Vitest suites |
| `docs` | Gate results, architecture decisions, quality matrix and release checklist |

`README_START_HERE.md` is the historical Gate 0 starter-pack note. Use this README instead.

## License

Original OrderTruth code is licensed under [MIT](LICENSE).

Copyright (c) 2026 Aniruddh Vijayvargia and Prachi Agarwalla.

Dependencies and provider services retain their own licenses and terms. See [third-party rights verification](docs/THIRD_PARTY_RIGHTS.md).
