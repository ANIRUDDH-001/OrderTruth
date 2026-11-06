# Devpost text — draft, not submitted

W4 CP1 draft, 4 November 2026. Do not paste this unchanged into a final submission: the owner must replace the unresolved release fields and approve every claim. This text makes no current hosted-access, W2-qualification or AI-superiority claim.

## Project

**OrderTruth — payment evidence, merchant recovery and tested integration contracts.**

Audience: payment engineers tracing integration faults and merchant operators who need a precise, reviewable recovery path.

## Problem

A successful provider capture does not by itself establish correct merchant fulfillment. Under the reference merchant's single-order contract, concurrent handling can leave duplicate local orders. Operators need to distinguish payment evidence, application effects and competing explanations before approving a correction.

## What we built

The V2 workflow uses a recorded genuine PayPal Sandbox observation and isolated controlled merchant scenarios. A case links the stored provider observation to merchant effects. Evidence-grounded AI proposes hypotheses and a read-only diagnostic. An operator can approve an exact merchant-only correction and inspect its independently checked receipt. It does not refund or capture payments through the judge workflow.

The V3 Integration Lab publishes a different, synthetic experiment: the original reference handler duplicates under a forced race; a human-written SDK integration passes the tested fixed P1/T1 contract. Two matching accepted repetitions and nine intended-defect controls are recorded. The static build validates the publication inputs and rederives the displayed result. It does not rerun the experiment in the browser or claim independent execution attestation.

## How it works

The Sandbox-only REST client obtains an OAuth access token through `/v1/oauth2/token`, creates orders with `POST /v2/checkout/orders`, captures an approved order through its `/capture` endpoint and reads it back with `GET /v2/checkout/orders/{id}`. Requests for order creation and capture carry `PayPal-Request-Id`. The webhook code bounds untrusted headers/body and posts the event bytes to `/v1/notifications/verify-webhook-signature`; unavailable or malformed verification never counts as success. It can read a registration at `/v1/notifications/webhooks/{id}`. Certificate URLs must match allowed Sandbox hosts and `/v1/notifications/certs/`; OrderTruth forwards that URL to PayPal and never downloads the certificate itself. These are source-inspected capabilities in `src/paypal/client.ts`, `src/webhooks/event.ts` and `src/webhooks/verifier.ts`, not fresh hosted execution or delivery claims. Checkout/capture are owner-controlled paths, not judge repair actions.

TypeScript domain logic, explicit database transactions, scoped maintained sessions and exact approval bind evidence to permitted local actions. PostgreSQL uniqueness/transaction behavior and durable outcome records support the fixed-lab SDK. The UI keeps source evidence, hypotheses and outcomes distinct. The hosted/local interactive path and static Lab have different runtime and access requirements; see [reproduction](V3_REPRODUCTION.md).

## AI and engineering tool disclosure

The V2 investigation integration uses Google Gemini with explicit cached/unavailable states and bounded access. AI cannot approve a repair or trigger a payment action. The prior advisory evaluation tied on classification and beat the control on no preregistered metric; it had fewer citations and diagnostics. That advisory experiment did not evaluate the distinct hosted investigator prompt. The separate exploratory investigator analysis found no demonstrated incremental value under its disclosed limitations. See [claims](V3_CLAIMS.md) for methodology links.

Claude Code and OpenAI Codex assisted planning, implementation and review. Owner-controlled commits and separately relayed reviews govern checkpoints. This is development assistance, distinct from the shipped V2 inference feature. The human-written Gate A reference fix is not an applied AI migration patch. Final model/tool versions and actual owner asset declarations must be checked before submission; do not invent usage metrics.

## Current limits and next work

Gate A/W1 qualify a fixed synthetic reference experiment. W2 untrusted-candidate hardening is in progress, not accepted. W3 AI migration evaluation has not run. No production certification, general compatibility, universal exactly-once effect or undiscovered-path coverage is claimed. Human usefulness and the final deployed end-to-end journey remain unverified in W4 CP1. Keep synthetic, genuine recorded Sandbox and live inference labels separate in the demo.

## Owner-only completion fields

| Item | CP1 status / action before submission |
|---|---|
| Public source and license | Root MIT license exists; verify unauthenticated exact source S and final publication/release commit, then provide actual public repository URL. Exact Gate A source availability remains NOT_VERIFIED. |
| Functional access | Existing hosted URL is historical; final deployed V2 journey and `/lab/` not checked here. Provide approved tested access path and complete setup instructions. |
| Video | Not recorded/approved in this checkpoint; provide actual reviewed public URL after permission. |
| Form fields | Public requirements inspected; owner must review every authenticated Devpost field without treating these draft headings as the exact form schema. |
| Team, representative, rights | Owner confirms eligibility, representation and asset/tool rights; no claim of automatic eligibility. |
| Final result/status | Update only from independently reviewed and owner-committed checkpoints before the content lock. Do not wait for W3 or imply unfinished work passed. |

Use the dated [release gates](V3_RELEASE_GATES.md). No submission, account operation, upload or deployment has been performed by this draft.
