# OrderTruth

OrderTruth checks one rule for a merchant that takes PayPal payments: **one completed capture must produce exactly one live store order.** When the rule breaks, it opens an incident with linked evidence (a duplicate order, or a missing order after a grace period). For duplicates, it offers a narrow repair that needs an explicit approval and only changes the store's own records, never PayPal.

This is a hackathon-stage local reference build, not a production service. Read [What is not proven](#what-is-not-proven) before relying on anything here.

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

## Sandbox vs offline

| Mode | What it touches | How to run |
|---|---|---|
| Offline (default for judges) | Local SQLite only, with synthetic `DEMO…` identifiers | `pnpm check`, `pnpm console:demo`, `pnpm incidents`, `pnpm repair` |
| PayPal Sandbox | PayPal **Sandbox** Orders v2 API (virtual funds), using credentials you put in a local `.env` | Copy `.env.example` to `.env` and fill it in privately. Then use `pnpm start` (checkout on 127.0.0.1) and `pnpm cli oauth-check / create / readback / capture / reconcile`. |

- Production PayPal endpoints are not permitted (`PAYPAL_ENV=sandbox`).
- Webhook listening (`pnpm webhooks`) needs a registered Sandbox webhook and an HTTPS tunnel. It was proven live once in Gate 1B and is not part of the judge path.
- The tests never call PayPal or any model. They use local fakes.

## Trust boundaries and security limits

- **No authentication or RBAC.** The org scope is a development header, not a login. Anyone who can reach the port can read every org.
- All servers bind to `127.0.0.1`. Nothing is hosted.
- Repair approval is a typed name in a terminal. Separation of duties is not enforced.
- PayPal facts in the console come from readbacks stored at the time of the check, and are labelled "not re-read here".
- Controlled fault injections, such as the duplicate-order race `REF-BUG-1`, are labelled as lab faults, never as customer events.
- AI advisory is off by default (`AI_PROVIDER=disabled`). The console then shows rules-only guidance and says that no model was called. No model output can trigger any PayPal or store action.
- Secrets live only in your local `.env`, which is git-ignored, and are redacted in logs. Local databases (`*.sqlite`), `.work/` and `dist/` are git-ignored.
- The console runs under a strict CSP (`default-src 'self'`, no inline script) with `no-store`, `nosniff` and `no-referrer`.

## Tests

```bash
pnpm typecheck
pnpm test             # vitest; offline; 26 files / 585 tests at Gate 3A
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

- Real authentication, RBAC, multi-tenant isolation beyond a header, and CSRF/origin protection: **NOT_TESTED / not built**.
- Hosted judge access, public deployment, the public repository and the license: **not established**. See `docs/RELEASE_CHECKLIST.md`.
- AI quality versus the rules baseline: **not measured**. The live model evaluation is blocked (`docs/GATE2C_AI_RESULTS.md`).
- Screen-reader use, a full WCAG 2.2 audit, performance under load, and real users: **NOT_TESTED**.
- Merchant checks are not wired into the live Sandbox checkout flow. Detection and repair are proven on local and synthetic data, plus one recorded real-evidence run (`docs/STAGE1D_RESULTS.md`).
- Platforms other than Windows: **NOT_TESTED**.

The per-criterion status is in `docs/QUALITY_GATE_MATRIX.md`. The Gate 3A evidence is in `docs/GATE3A_RESULTS.md`.

## Repository map

| Path | Contents |
|---|---|
| `src/paypal`, `src/server`, `src/webhooks` | Sandbox checkout, readback, reconciler and webhook listener |
| `src/merchant` | Reference merchant, rule checker, incidents, repair, incident API and console host |
| `src/ai` | Optional advisory adapter and holdout evaluation |
| `src/db` | SQLite store and migrations |
| `web/console` | Console UI (vanilla TypeScript, no framework) |
| `tests` | Vitest suites |
| `docs` | Gate results, architecture decisions, quality matrix and release checklist |

`README_START_HERE.md` is the historical Gate 0 starter-pack note. Use this README instead.

## License

There is no license yet. One is pending the owner's decision; the options are in `docs/GATE3A_RESULTS.md`.
