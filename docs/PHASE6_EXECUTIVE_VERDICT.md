# Phase 6 executive verdict — 8 November 2026

**STATUS: Phase 6 / AT-RISK. Local recovery qualification PASS; submission and live AI HOLD.**

OrderTruth has a defensible narrow product: connect a recorded payment observation to an inconsistent reference-merchant outcome, require exact approval, and independently re-read a durable correction receipt. That loop has engineering substance. It is not a qualified universal merchant platform. Current AI value does not yet support a strong PayPal + AI competition claim.

## Changes and evidence

- Fixed preapproval GET stranding checkout, and interrupted/malformed provider responses bypassing failed-readback evidence. Actual PostgreSQL regressions verify recovery refuses an older observation after these failed fresh GETs.
- Added strict synthetic-only egress, per-call opaque citations, safe Groq transport scaffolding, durable provider cooldown, conservative hosted allowances, and explicit model configuration.
- Grouped account controls, explained password-free guest entry, moved Lab to technical evidence, and fixed drifting slow-request notices.
- Patched Fastify/Zod and allowed transitive fixes. Audit: 12 findings including one high → two moderate, no high/critical. This is not exploitability certification.

Node 22.18.0: **1,306 offline, 64 V2 PostgreSQL, 114 V3 PostgreSQL tests passed**, plus typechecks, frozen install and frontend build. Actual Codex browser completed synthetic detection→diagnostic→approval→repair→receipt→reload with AI honestly unavailable. Independent SQL found one active order, one voided duplicate, one original observation/capture intact and one successful receipt with equal stored provider hashes.

## Material weaknesses

1. P1/HOLD: citation-valid free prose can contradict financial evidence or instruct a refund. No model has execution authority, but semantic grounding is unproven.
2. P1/HOLD: no current comparative live-model value result; hosted inference is disabled.
3. P1/HOLD: end-to-end judge availability through 15 December, hosted admission fairness, genuine webhook qualification and final video/submission remain unqualified.

No P0 exploit was confirmed; absence of a finding is not certification. Three independent read-only reviewers inspected payment, AI and product/system concerns; the integrator checked their findings.

## Evidence index

- [Findings](PHASE6_FINDINGS_LEDGER.md), [payment/security](PHASE6_PAYMENT_SECURITY.md)
- [AI privacy](PHASE6_AI_ARCHITECTURE_PRIVACY.md), [AI value](PHASE6_AI_VALUE_BENCHMARK.md)
- [Reliability/hosting](PHASE6_SYSTEM_DESIGN_RELIABILITY.md), [UX](PHASE6_UX_PRODUCT_REVIEW.md)
- [V3 preservation](PHASE6_V3_INTEGRATION_REVIEW.md), [competition](PHASE6_COMPETITION_SCORECARD.md)
- [Qualification](PHASE6_FINAL_QUALIFICATION.md), [release/submission](PHASE6_RELEASE_AND_SUBMISSION_ROADMAP.md)

Source base: `575433adfe6ba15e593241898f55a962f77e1fec`. Integrated source is the commit on `phase6/adversarial-qualification`; use `git rev-parse HEAD` and its exact CI. Production remains at the base. External service spend introduced ₹0; payment calls 0, live model calls 0. Assistant inference billing is unavailable.
