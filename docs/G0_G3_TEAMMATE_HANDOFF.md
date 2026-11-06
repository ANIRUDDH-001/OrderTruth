# OrderTruth — final G0–G3 teammate handoff

Date: November 6, 2026 IST. Scope: documentation, preservation packaging and portable transfer only. No functionality, Git writes, publication, deployment, PayPal/model calls or private G3 owner-kit access is authorized by this closure.

## Gate status and evidence boundaries

| Gate | Accepted scope | Evidence status / exclusions |
| --- | --- | --- |
| G0 | GO: preservation and source isolation | RECORDED_NOT_REPRODUCED acceptance; historical evidence preserved. |
| G1 | GO within the frozen Lab contract | RECORDED_NOT_REPRODUCED: eight matrix cases, earlier Node22 PostgreSQL 100/100. Synthetic local causation, not genuine G2 webhook proof. |
| G2 | Offline live-readiness GO at the accepted source below | RECORDED_NOT_REPRODUCED: Claude acceptance supplied by owner. Genuine Sandbox/native HTTP, actual app/payee, tunnel/registration, full buyer/capture session and signed delivery remain NOT_TESTED. |
| G3 | Methodology READY | AI VALUE NOT_TESTED. No private evaluation or usefulness acceptance, model/provider unspecified; no pilot authorization inferred. |

VERIFIED in this closure means hashes, archive manifests and documentation/source inspection. Historical experiments and independent acceptance are RECORDED_NOT_REPRODUCED; no accepted experiment was rerun. Historical G0/G1 PayPal evidence does not qualify the isolated G2 path. `G2_G3_V4_REVIEW.md`, frozen protocols and older bundle documents retain historical candidate wording; this closure supplies current status without rewriting immutable evidence.

## Product and Lab boundaries

OrderTruth compares provider evidence with merchant outcomes, supports evidence-grounded investigation and human-approved merchant-only repair, and checks receipts/regressions. Model output cannot authorize repair or trigger capture/refund. V2 repair uses stored provider evidence, not fresh PayPal readback on every repair; shipping/inventory/communications remain external.

The TypeScript modular monolith has separate owner/judge frontends. Isolated PostgreSQL Lab stores (`shop.intents`, `shop.orders`, `lab_reference`, `lab_webhook`, `ordertruth_guard`), V2 SQLite `merchant_orders` and hosted PostgreSQL `merchant_orders` are different stores. No Lab-order synchronization, incident bridge or hosted repair integration exists. Lab causation is not the V2 controlled-recovery demo; separate role tabs are not RBAC.

G1 preserves race overlap evidence (both existence checks before insert), sequential cross-path failure, corrected idempotency and two legitimate independent purchases using separate intents. Guard capture uniqueness plus merchant/intent/primary-unit uniqueness rejects another capture on the same intent as IDENTITY_CONFLICT. Split/partial/multiple-capture lifecycles and arbitrary outside-guard legacy rows are not covered. See `G1_FROZEN_EVIDENCE.md` for exact test names and LF/CRLF tested-byte caveats.

## Accepted source identities — never redefine on drift

- G2 accepted source SHA-256: `802f758dab677c864ed022609b800e8c82e06ab7c07efe1de20910f00fff2702`.
- G3 evaluator digest: `8ed5d0994cfe78e354e78bebee697561b929f38a7a525c0cf3bbe6dead1f89bc`.
- G3 scaffold freeze digest: `58fdca5857bd1b97d71fe318002358e962195d839a389e98f7869437f19ab04c`.
- `src/ai/code-investigation/pilot-freeze-v4-r2.json` byte SHA-256: `ed871b9d47232a989f587633712e8a701d0866c26f378f94db217fb0acc96acb`.
- Current local HEAD: `02e06ec7475bab2f0365144aea65655e31681a61`. Recorded public-main ref: `eb39f1549b34f67f2acb67a52d87e28be62cfb1b`; not fresh public/CI verification.

Both edited documents are outside the G2 source manifest and G3 frozen-input set. The G3 protocol is inside the frozen set and was deliberately left byte-identical. Recompute before and after documentation edits; mismatch blocks transfer/integration, never regenerate a baseline to conceal it. G2 source hashing uses raw bytes and a sorted JSON manifest; line-ending normalization can invalidate identity.

## G2 readiness and execution limits

`G2_BOOTSTRAP.md` describes the accepted native fixed-host, no-redirect Sandbox client, durable request budgets, source-bound/expiring/action-specific approval, fresh local stores and persistent stdin session. It reuses an existing approved webhook registration; missing registration requires a separate setup decision. Initialize is local-only and was qualified with zero provider-client constructions.

Accepted purchase sequence: budget guard → durable create claim → create → counted trusted GET/exact order+payee verification → both intent registrations → flushed source/run/order/intent/payee receipt → approval URL release → manual buyer approval → receipt gate → fresh pre-capture GET → guarded capture. The recorded mock shape file cannot satisfy genuine readback. Failed or uncertain work retains claims and consumed budget across restart; no financial retry/reset or second purchase. Actual pre-approval `merchant_id` availability is NOT_TESTED and may halt the run.

Proposed execution scope remains separately owner-controlled: one USD1.00 Sandbox purchase, at most one capture; OAuth3/create1/capture1/orderGET12/signature5/registrationGET1/total23, registration mutations0, real-money ceiling ₹0. No execution is authorized here. Known exact authenticated webhook bytes may retry stored evidence without a new signature postback; this is not verification of a new transmission. Changed bytes need verification. Corrected-writer/journal crash recovery relies on capture-idempotent reuse, not cross-transaction atomicity.

## G3 methodology and private boundary

Eight exposed synthetic cases are development smoke only. Frozen evaluator retains invalid/missing/schema/parser/UNSCORABLE attempts, supports substantive multiple labels and separately counted abstention, and requires independent explanation/identity/minimality review. The lexical comparator is a bounded subset and can abstain; it is not a complete parser or production semantic proof. Recorded development smoke: eight rows, three abstentions, five repair proposals, zero clean false positives; no AI advantage follows.

Keep 64 finite-interpreter checks separate from 28 assertions executing four pinned shipped JavaScript programs in restricted children against an in-memory adapter. Neither qualifies arbitrary/model patch execution, PostgreSQL atomicity or production behavior. Model text is inert; no automatic install, execution or repair authorization.

Private cases, answers, grading keys and owner kit remain solely with their authorized custodian. Do not request labels or give Codex sealed material. Any future authorized public-input transfer may contain only `{id, code}`; the frozen `sealRelayedHoldouts` helper requires oracle fields and must not be used for that transfer. Custodian-side scoring, public-input packaging and any future provider/call allocation require their own reviewed authorization. Historical pilot metadata in the frozen implementation is not a current call budget or permission. This handoff assigns no new pilot budget and performs no private-data discovery.

## Preservation and concrete portable location

Portable directory: `C:/projects/ordertruth/.work/portable-handoff-20261106/` (Git-ignored, outside tracked sources). Copy this directory as a unit to teammate storage; keeping it only on this disk is not an independent backup. Original dirty/untracked sources, ignored evidence and immutable archives remain in place. No reset, cleanup, staging, commit or publication occurred.

Required payload: unchanged v4 review ZIP, focused pre-approval payee delta ZIP, original G0/G1 review ZIP, `implementation.patch`, and `preserved-original-dirty.zip` containing all ten original `handoff-20261105/preserved/` files. `preservation.json` and `preexisting.patch` retain original provenance. The dirty archive is review material, not an automatic overlay. Evidence inventory and SHA-256 values are below and in `SHA256SUMS.json`; `bundle-verification.json` records checks. No private G3 material, actual environment files, database files, credentials, tokens, `.git` or dependencies are added.

Read `README_TRANSFER.md` in the portable directory for exact SHA verification and reconstruction order. Extract only into a NEW empty directory; never an owner's checkout. Use the v4 full source snapshot, selectively overlay the payee delta full source files, then these two corrected documentation files. Preserve all old documents/patches as historical review evidence, not current instructions. `implementation.patch` and original dirty files are separate preservation evidence, not patches to apply blindly to the newer snapshot. Verify reconstructed G2/G3 identities before integration. Frozen dependency/runtime guidance is Node22.18.0/pnpm11.4.0; no install, runtime qualification or live session is performed by this closure.

## Remaining work — scoped definitions, no invented milestones

The local G0–G5 labels in `PHASE_0_5_ENGINEERING_REPORT.md` differ from the older master-plan Gate0–3 numbering. The matrix below uses those local labels; Ask scoring G4/G5 and W4 are not substitute milestone definitions. Missing owner acceptance criteria remain unresolved, not invented here.

| Workstream | Current evidence/status | Exact remaining work / exit evidence | Authority / blocker |
| --- | --- | --- | --- |
| G4 merchant UX | NOT_TESTED; source contracts in `MERCHANT_UX_INTEGRATION.md`, no delivered UX patch | Deliver UX against existing endpoint/recovery contracts; build/contract validation and independent operator usability review. Keep stored-evidence and role-tab limitations visible. | Teammate implementation scope and owner acceptance needed; no additional G4 definition found in the cited report. |
| G5 local candidate | RECORDED_NOT_REPRODUCED baseline-only qualification; AT-RISK | Select a clean main-based candidate and exact approved delta; qualify that exact source with frozen install, typecheck, offline/PG tests and frontend build/package; retain failed probes and public CI evidence. | Baseline snapshot is a fallback, not integrated release; no final new-feature candidate selected. |
| Product integration | NOT_TESTED / absent | Decide whether Lab and G3 remain separate demonstrations or enter the product. Any incident/store/repair bridge needs explicit architecture, contracts, implementation and independent evidence before promotion. | Owner product/architecture decision; no integration work authorized. |
| Release selection / security | BLOCKED on final selection and review | Preserve V2; exclude unqualified Ask/W2/W3/Lab/AI deltas unless separately qualified. Assess recorded 12 advisories (including Zod high), authorize remediation if needed, validate actual release auth/security/a11y/setup/license/public-source boundaries. | Audit findings are historical, exploitability NOT_TESTED; final commit/publication approval absent. |
| Hosted qualification | NOT_TESTED | After owner selects/authorizes release and hosting, qualify deployed source/runtime, Sandbox and judge access, failure behavior and availability responsibility through December15. Keep secrets private. | No deployment or hosted writes authorized; free access, operator and final hosted criteria unconfirmed. |
| Final demo recording | NOT_TESTED | Qualify chosen demo route, rehearse and record truthful English public video under three minutes, distinguish genuine provider evidence, synthetic Lab and AI hypotheses; verify final export/link. | Final route/source and recording authorization needed; existing scripts are drafts, no final recording claimed. |
| Devpost delivery | UNKNOWN / NOT_TESTED | Owner verifies current official rules/dates, team eligibility, authenticated fields, public licensed repo/access/video links; authorize final submission, retain confirmation and access plan. | No account inspection or submission here; current requirements/deadline not freshly verified. |

Recorded requirements and owner-supplied deadline remain RECORDED_NOT_REPRODUCED, not a fresh rules check. `ORDERTRUTH_MASTER_PLAN.md`, `V3_RELEASE_GATES.md`, `V3_DEMO_SCRIPT.md` and `V3_SUBMISSION_DRAFT.md` supply existing criteria/drafts; they do not grant execution/publication permission. Recheck authoritative rules before external action.

## Closure checkpoint

STATUS: G0–G3 documentation/preservation closure; GO only if final identity checks match. VERIFIED: archive hashes/internal manifests and preserved-file hashes; exact receipts in portable directory. NOT_TESTED: genuine G2, AI value, integration/UX/release/hosted/demo/submission. IMPLEMENTED: these two documents and ignored transfer artifacts only. TESTS: integrity checks only; accepted experiments not rerun. RISKS: live payee compatibility, unmeasured AI value, unqualified final candidate/access; require separate approval and evidence. COST / QUOTA: no external calls or spend in this task; chat inference usage not metered here. BLOCKING QUESTIONS: owner decisions in matrix; none needed for this documentation-only closure. NEXT ACTION: teammate independently verifies transfer hashes and preserved identities. GIT: dirty worktree retained; no agent commits or Git-state writes.

## Verified evidence transfer inventory

| Portable file | Bytes | SHA-256 |
| --- | ---: | --- |
| `g2-g3-v4-review.zip` | 1794133 | `204e1360aedb050593b5bfb146f643997cd6a955ff1af90aa196f087307580f4` |
| `g2-preapproval-payee-delta.zip` | 85201 | `0e7a5a36fd431bed9eeb1315fa6ff14f1b7bb406080e55d6e9a73035fa7e9f21` |
| `g0-g3-review.zip` | 1660702 | `616b1ce9ba8a1df654b34cf7836baa9325ea097be8fb6c5d7e352bff95f44571` |
| `implementation.patch` | 69016 | `ed01fbdc0774263a316d7f9cdcdbc357e11d61a57bc69d8d274d8dcce47509f1` |
| `preserved-original-dirty.zip` | 39052 | `4ae75f1838de4520d3c0f3a0c264a70002b51a98b253739abdf7977e08ea6659` |
| `preservation.json` | 1347 | `6cff0f2aaf39c2479f0a7c890239128113b2938963fa3088657b284eaa3f84c5` |
| `preexisting.patch` | 6584 | `5334e22ccbcd57abf834385ff435e67478df25090fca8c01a751bd464eb3e8ad` |
