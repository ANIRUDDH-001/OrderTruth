# Gate 2D — Engineering investigation results

> **Superseded (21 October 2026).** The standalone `/investigation` screen, its build, `pnpm investigation` host and synthetic demo were retired and folded into the console's incident page (Engineering lens: Evidence with per-record scope and "Used by check" links, Repair record with stored columns). Old `/investigation/<id>/` links redirect to `/console/incidents/<id>?lens=eng`. The evidence boundary moved to `web/console/evidence.ts`; the Gate 2D tests now target it and the console loader. The record below is historical.

STATUS: PASS for this scoped local Engineering vertical slice. Production readiness and authenticated access are NOT_TESTED.

Starting commit: `2bb3438575f4f271c4d62bfae47471f484564569`. The delivery commit containing this report identifies the final implementation; delivery SHA and remote verification are recorded in the chat and ignored local ledger.

## Implemented

The approved `.work/design-review/flagship-reset/index.html` Truth Gap prototype was located and its desktop screenshot inspected before implementation. Its navy canvas, light shell, typography, connection diagram and docked inspector supply the visual system. Rejected Engineering A/B and Operations layouts were not used. The implementation uses native TypeScript, HTML, CSS and SVG with the existing Vite architecture; no dependencies were added.

The screen has distinct selectable provider, invariant and merchant entities; separate opening and latest snapshots; evidence inspection with timestamps, references, trust categories and limitations; deterministic hypothesis guidance; and an inspectable recovery journal. Latest switching updates counts, node effective states and connection styling together. Physical merchant rows remain visible after a local void. The retained branch is determined by effective status rather than response order. On mobile, selection opens a modal inspector without scrolling through the page. Escape closes it and restores focus.

The incident API now additionally projects existing append-only voids and incident-specific resolution records with their linked postcondition evaluation. These are organization-scoped read queries. No schema, checker, approval, repair execution, checkout or provider behavior changed. The existing successful synthetic repair regression was strengthened with assertions for these read projections; no existing assertion was weakened.

## Routes and setup

Requirements: repository's existing Node 22 and pnpm dependencies installed. No secrets, provider accounts, AI quota or historical database are needed for the synthetic showcase.

```powershell
Set-Location D:\Projects\OrderTruth
pnpm build
pnpm investigation
```

Open `http://127.0.0.1:3004/investigation/?mode=demo`. The unqualified `/investigation/` route is an explicit source chooser. The demo is persistently labelled **SYNTHETIC DEMO**, deterministic and illustrative. It makes zero API requests. This standalone host imports no Store, credentials, provider or repair service. Stop with Ctrl+C. The final acceptance servers were stopped after evidence capture; launch the command to use the screen.

To verify the real API transport without accessing historical evidence, run this bounded acceptance host in another terminal:

```powershell
pnpm exec tsx tests/helpers/gate2d-fixture-server.ts
```

It creates a **NEW disposable synthetic SQLite database** in the OS temporary directory, seeds a duplicate incident, and prints its precise URL at `http://127.0.0.1:3005/investigation/<incident-id>/?mode=local&org=org_reference`. It terminates and cleans up after five minutes or Ctrl+C. This fixture has an open incident and no repair history. It proves API transport and mapping, not provider truth or a real repair.

For an explicitly user-configured, non-protected local database:

```powershell
pnpm build
pnpm incidents --db 'D:\path\to\your-disposable-synthetic.sqlite' --port 3003
```

Open `/investigation/<incident-id>/?mode=local&org=<developer-org-id>` on `http://127.0.0.1:3003`. Direct navigation and reload work. The API and built assets share an origin. The incident service stays on `127.0.0.1`, with GET/HEAD only; no wildcard CORS, public hosting or mutation route was added. Only the dedicated build's index and `assets/` directory are served. Project files, `.env` and databases are not static content. The three historical database paths forbidden by this task, including filesystem aliases, are refused before Store construction. Other existing files are **not** certified safe to migrate: Store still uses existing startup migrations, so use new disposable fixtures for this task.

The checkout remains its separate existing service and build. Incident data is not mounted on the checkout server.

## Source and trust boundaries

- LOCAL INCIDENT API uses a same-origin GET with the explicitly configured `x-ordertruth-org`. This is developer organization scoping, **NOT authentication**, RBAC or an authorized public deployment.
- API failure, invalid identity, cross-organization response, malformed data or timeout never substitutes synthetic data. Requests have an eight-second timeout; response/presentation limits reject oversized top-level data.
- Provider completion requires linked opening readbacks with agreeing capture/order IDs, completion status, source times and valid agreeing USD amounts. Multiple readbacks of one capture render one capture entity. Shared domain money parsing/formatting preserves integer minor-unit precision. Missing or contradictory provider evidence is unavailable/unverified.
- At detection, merchant status comes from linked opening observations; current projection cannot fill a missing historical snapshot. Latest merchant projection and latest evaluation are separately labelled. Contradictions receive visible warnings; an older latest evaluation is rejected.
- A latest `HOLDS` result is the intent's latest recorded check, **not automatic resolution of this incident**. Resolution/postcondition links are inspected separately in the receipt. Stored history is not independently reverified by the browser.
- The receipt exposes plans, declared approvals, execution outcomes, append-only void rows, linked resolution/postcondition records and audit entries when available. It does not invent absent approval identity, keeper, postcondition or preservation evidence. Equal stored before/after provider hashes concern preservation of recorded provider snapshots, not a fresh readback or fulfillment proof.
- AI remains unavailable. Hypotheses are explicitly unproven deterministic guidance with supporting source IDs, missing proof and a safe read-only next-test specification. No model is called or represented as available.
- Every API-derived value is rendered through DOM text nodes, never HTML interpolation. CSP restricts scripts, styles and connections to the same origin. No payment, repair, checker execution, web approval or provider controls exist.

## Verification evidence

VERIFIED on 19 October 2026:

| Check | Outcome | Evidence |
|---|---|---|
| Starting `pnpm test` | 516 passed; 0 failed/skipped | `.work/runs/gate2d/01-baseline.txt` |
| Final `pnpm test` | 546 passed, 24 files; 0 failed/skipped | `.work/runs/gate2d/12-final-tests.txt` |
| Final `pnpm typecheck` | exit 0 | `.work/runs/gate2d/13-final-typecheck.txt` |
| Final `pnpm build` | exit 0, separate checkout and investigation builds | `.work/runs/gate2d/14-final-build.txt` |
| Browser acceptance | 55 checks passed; 0 script errors | `.work/runs/gate2d/15-final-browser.txt`, `browser/results.json` |
| Independent read-only review | 122 focused tests and typecheck passed; initial amount conflict found and fixed; no remaining blockers in reviewed scope | `.work/runs/gate2d/16-independent-review.md` |

Browser runner: `tests/helpers/gate2d-browser.cjs`, using an existing bundled Playwright and installed Edge, headless, reduced-motion emulation, desktop 1440×900 and mobile 390×900. It adds no dependency. Override `PLAYWRIGHT_MODULE` and `EDGE_PATH` on other machines. With both local hosts running:

```powershell
$env:SYNTHETIC_API_URL='http://127.0.0.1:3005'
node tests/helpers/gate2d-browser.cjs
```

Verified actual interactions: graph selections; different keeper/duplicate identities; keyboard Enter activation; detection → latest → detection; selected inspector synchronization; voided row retention; source trust and limitations; hypothesis switching; read-only diagnostic specification; detailed receipt; modal Escape and focus return; deep-link reload; no horizontal page overflow at either width. The real read-only API transport was exercised on the new persisted synthetic fixture, including selected order identity, missing receipt, cross-org 404, and reload. Explicit adversarial browser responses checked literal hostile HTML, malformed payload and HTTP 500 with no synthetic fallback. Browser requests were all local GETs. Unit tests additionally cover missing evidence, conflicting readbacks, stale/contradictory evaluations, wrong incident identity, timeout, USD precision and reversed merchant response order. Persisted-fixture API tests prove restart and unchanged `total_changes()` for read requests, plus refused writes.

The RED logs `02`, `03`, `04`, `05`, `06`, `11` record missing modules/behavior and reproduced defects before implementation/fixes. The first browser run exposed an overly tall desktop inspector; it was bounded and visually rechecked. A development rebuild also invalidated cached asset names; index loading now reads the current dedicated build. No transient failure is counted as a pass.

## Screenshots and visual review

All are actual implementation captures, ignored by Git under `.work/runs/gate2d/browser/`:

- `1440-detection.png`: desktop first viewport/detection.
- `desktop-full.png`: full desktop page.
- `1440-latest.png`: latest state.
- `1440-duplicate-inspector.png`: distinct duplicate selection.
- `1440-receipt.png`: recovery journal dialog.
- `390-detection.png`, `mobile-full.png`: mobile viewport/full page.
- `390-latest.png`, `390-duplicate-inspector.png`, `390-receipt.png`: mobile state and inspector sheets.
- `local-api-synthetic-fixture.png`: actual API mode on the explicitly synthetic database.

Visual self-review inspected desktop detection/latest, full page and mobile selection. The canvas remains above the desktop fold, the inspector no longer expands it, mobile uses a compact vertical relationship graph and modal inspection, and text/control overflow was checked. This is not a comprehensive accessibility certification.

## Exact changed files

`package.json`; `tsconfig.json`; `vite.investigation.config.ts`; `src/merchant/api-main.ts`; `src/merchant/api.ts`; `src/merchant/investigation-main.ts`; `src/merchant/investigation-static.ts`; `web/investigation/index.html`; `web/investigation/main.ts`; `web/investigation/model.ts`; `web/investigation/style.css`; `web/investigation/synthetic.ts`; `tests/gate2d-view.test.ts`; `tests/gate2d-serving.test.ts`; `tests/stage1d-repair.test.ts`; `tests/helpers/gate2d-fixture.ts`; `tests/helpers/gate2d-fixture-server.ts`; `tests/helpers/gate2d-browser.cjs`; this report.

## Limitations, cost and Operations handoff

NOT_TESTED: current real-provider evidence, live AI performance, real-human usability, screen-reader behavior, full WCAG 2.2 AA audit, public access, production authentication, authenticated approvals, fulfillment or financial outcomes. Historical payment databases and `.env` were not opened or modified. No new payment, refund, provider/AI API call, human approval, recovery against historical data, deployment or paid service was performed. Existing repair regressions execute only their synthetic test fixtures, never through the new interface. Incremental service spend: ₹0; agent inference accounting unavailable. DevRelay research was attempted but unavailable because the connector was not signed in; no community claim was inferred.

Operations can reuse the same incident/evidence/receipt response and presentation boundary. Preserve source labels, recorded-vs-current distinctions, incident-specific resolution references and absent-evidence states. Keep business actions behind separately approved contracts and real authentication/RBAC; this screen is inspection only. No Operations implementation, new incident class or further redesign was started. STOP at the Engineering vertical slice.
