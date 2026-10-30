# OrderTruth v3 — roadmap after Gate A

Date: 2026-10-30. Baseline: `fixes` at `fc85ac3`.
Status: proposed roadmap; W1 planning authorized. The owner explicitly selected **review the W1 plan before building**. This document does not authorize implementation of W2–W4, live calls, deployment or Git writes.

## Outcome and evidence boundaries

Finish a judge-visible, reproducible explanation of the verified SDK slice; then establish a defensible verifier boundary before measuring AI migration value. Gate A already passed for the fixed synthetic P1/T1 V-A experiment. It did not establish production readiness, hostile-code safety or AI value.

Authority and contracts remain in `AGENTS.md`, the full handoff, and the v3 design spec. This roadmap sequences their remaining work; it does not replace them. Estimates in the handoff are planning guesses, not delivery promises. Target the existing November feature/demo/submission milestones; cut unproven scope instead of inventing evidence.

## Chosen sequence

| Stage | Concrete outcome | Checkpoint / stop condition |
|---|---|---|
| W1 | Integration Lab publishes the accepted Gate A experiment as checked static evidence within the judge build | Short plan reviewed first; implement a complete bounded vertical slice; stop for Claude PASS and owner commit |
| W2 | The verifier can evaluate an untrusted merchant candidate without trusting its writable records or surviving processes | Separately authorized plan; review the trust-boundary design; adversarial controls; two full runs; fresh reproduction before broadening claims |
| W3 | A preregistered comparison establishes whether an AI migration adds value beyond deterministic baselines | Separately authorized Gate B; independently frozen held-outs before prompt work; offline agent first; owner separately authorizes each bounded live run |
| W4 | README, demo and submission text accurately show the delivered paths and their evidence | Begin a separately authorized small documentation checkpoint alongside W1; finalize claims only from completed gates |

Every implementation checkpoint ends at `.work/v3/<stream>/<checkpoint>/REPORT.md`, Claude review, fixes/recheck if necessary, and owner commit. Do not silently advance after tests pass. Plans and reports must list dependencies, deviations and what remains NOT_TESTED.

## Brainstorm decisions

| Question | Options considered | Direction / reason |
|---|---|---|
| Publish evidence now or start with AI? | Static Gate A view; migration agent first | W1 first: uses existing evidence and gives judges a complete path without claiming unmeasured AI value |
| Where should the lab live? | Rewrite judge UI; new API-backed page; separate static page in the existing build | Static `/lab/` entry with a judge-header link: no new API, credentials or investigation-state changes |
| Which results should be published? | Old dirty-tree run; successful committed clean reproduction | The clean reproduction at `fc85ac3`; preserve source commit S separately from publication/build commit P |
| How is publication checked? | Browser fetch plus neighboring hash; checked build-embedded records | Build checks all artifact bytes and recomputes acceptance before embedding records; explicitly no independent attestation claim |
| How should W2 constrain writes? | Column grants/triggers; trusted SQL API; separate trusted guard process | Decide in W2's reviewed design/spike. A credential or signing key in an untrusted process is not protected by calling its code “trusted” |
| How is AI value judged? | Attractive example; deterministic baselines plus frozen held-outs | The latter; an honest tie or NO-GO remains an acceptable outcome |

## W1 — Integration Lab

Detailed execution plan: `2026-10-30-v3-w1-integration-lab.md`.

Deliver one complete read-only path: accepted run directory → deterministic public evidence → checked web build → labeled lab page. Include the original duplicate, reference outcomes, all nine controls, ladder, T1 exercised paths, provenance, limitations and reproduction instructions. Keep the genuine Sandbox judge case separate. No CI verifier job or deployment is included.

Plan revision 2 makes final qualification/cleanup records mandatory committed inputs, bound to reviewed historical hashes and recomputed acceptance. W1 validation gets its own disposable Node22 image containing a hashed snapshot of the exact new source; Gate A's historical images stay unchanged. Check the packaged `/lab/` route and source-commit public reachability before claiming external reproducibility. None of these checks authorizes a push, visibility change or deployment.

## W2 — hardening before untrusted or AI-generated candidates

These are requirements and design questions, not an approved implementation plan:

1. Reproduce each current bypass with a one-defect negative control: rewriting order identity to hide a duplicate, forging markers/journals, and leaving work running across candidates or after timeout.
2. Choose a boundary that candidates cannot bypass with their own database credentials. Evaluate immutable order/effect observations plus constrained writes, trusted SQL operations, or a separate trusted guard bridge. Do not assume a `SECURITY DEFINER` label or column grants alone establish this property. A candidate must not obtain observer/setup credentials or trusted signing authority.
3. Keep the original-race positive control meaningful. Reject unexpected or relabeled effects as well as missing expected rows; never “fix” the original merchant's fault with the harness schema.
4. Use fresh candidate containers/temporary storage and scoped database roles. Terminate and verify the whole container/process tree on timeout. Keep trusted verifier sources and control credentials outside the candidate image.
5. Target `REJECTION_AUDIT` faults separately: lost acknowledgement, dropped/held COMMIT, restart reconstruction, and unavailable database. Derive NC6/NC9 reasons from durable trusted evidence rather than candidate stdout.
6. Pin the complete offline test inventory, close the clone's temporary PUBLIC CONNECT window, and prove the new boundaries with intended-failure NCs.
7. Regenerate the verifier manifest; require two complete accepted matching runs and a clean reproduction. Publish a new record instead of relabeling the old fixed-lab result as hardened.

Stop if the chosen design cannot demonstrate that candidate-visible authority is insufficient to forge a pass. Present that result and a narrower alternative for review; do not begin W3 execution.

## W3 — Gate B / AI migration value

Follow the spec's ordering, with separately reviewed checkpoint plans:

1. Freeze Gate B's development scope and metrics after W2 passes. Develop V-B and V-C with human reference fixes and verifier controls.
2. Aniruddh/owner freezes and hashes independent held-out variants **before any agent prompt work**. Codex never opens the holdout directory or reads its contents. The custodian supplies only permitted manifests, hashes and later result summaries.
3. Implement B1 static discovery and B2 deterministic wrapping under the same context and policy as the agent. The handoff specifies ts-morph; decide in that plan whether to authorize a pinned dependency or review an equivalent implementation using the already installed TypeScript API. No dependency or lockfile change is authorized here.
4. Build the CLI and deterministic policy gate against development variants and mocked model output: allowlisted merchant files, bounded patch size, no harness/oracle/tests/config/dependency changes, no new network or PayPal access, and parser/typecheck validation. These checks supplement W2 isolation.
5. Freeze a preregistration: corpus IDs/hashes, A versus B2 primary endpoint, B1 comparison, repetitions, invalid/infra handling, context parity, stop rules, costs, call/token/time caps and permitted claims. Set numerical budgets explicitly in that reviewed preregistration; live call allowance remains zero until owner authorization.
6. Only then request authorization for one exact bounded live evaluation. Runtime may use the approved `AI_API_KEY`; never read credential files, use `AI_API_KEY2`, or ask the owner to paste a key. Have the custodian execute the held-out evaluation without exposing contents to the implementer.
7. Report success, tie, failure or unavailable honestly. A tie supports “SDK plus verifier”; it does not support AI superiority. Gate B PASS authorizes considering product integration, not deployment or financial actions.

## W4 — documentation and demo

- First checkpoint: truthful README setup/reproduction, an evidence/limitations section, and a draft short demo narrative using existing functionality. Keep hosted v2 release qualification on the owner's separate track.
- Show the synthetic lab and genuine Sandbox observation as separate evidence sources. Do not imply the lab protected or repaired the judge's transaction.
- Revise AI claims only after Gate B's frozen result. No speculative screenshots, fake successful controls, or invented links/metrics.
- Final checkpoint: run the published instructions, verify every demonstrated control and source link, record skipped checks, and prepare the submission text/video checklist. Publishing/submission/deployment each requires its own authorization.

## Environment and owner inputs

- **Needed now for W1: none.** Existing source, local Gate A archive and pinned dependencies are enough. Docker is needed only for supported Node22 validation; no database credentials or new service are needed for the lab page.
- Existing local evidence: `.work/v3/gate-a/checkpoint-4/reproduction-evidence/`. It must become committed public artifacts for builds from a fresh clone; the page must not depend on `.work/` at runtime/build time.
- W2 needs Docker and disposable local PostgreSQL, not hosted database credentials.
- W3 eventually needs the custodian's frozen manifest and explicit live-run approval; any runtime key setup stays local and private. No model call is needed for planning, UI or offline agent development.
- W4 may later need owner-provided submission assets and access decisions. No new account, payment card, paid tier or production API is part of this roadmap.

P2, T2, consumers, ingest, legacy reconciliation and broader lifecycle/coverage features remain deferred. No `.env`/`.env.*`, `AI_API_KEY2`, or holdout content will be accessed; Git mutations require per-action permission and owner identity without agent trailers.
