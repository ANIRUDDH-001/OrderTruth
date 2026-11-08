# Phase 6 findings ledger

VERIFIED means observed in the specified local test or read-only response; it never implies live payment qualification.

| ID | Severity / final state | Reproduction, cause, impact | Correction and regression |
|---|---|---|---|
| F6-01 | P1 VERIFIED; fixed locally | CREATED GET changed awaiting approval to uncertain; later APPROVED could not recover, stranding capture. | Preserve correlated preapproval state without reapproving uncertain claims. Real PG CREATED→APPROVED→one-capture regression in checkout-service.integration.ts. |
| F6-02 | P1 VERIFIED; fixed locally | Body disconnect threw TypeError outside transport catch; invalid JSON/nonobject/nested orders and malformed503 details could omit failed-readback evidence, leaving old capture eligible. | Normalize errors, bound detail iteration, validate consumed response fields. Body unit test and five PG service→persisted-error→repair-refusal cases. |
| F6-03 | P1 VERIFIED; boundary fixed | Original transport serialized unrestricted facts; stub sent unknown email/secret fields. Arbitrary customer-row exposure through HTTP was NOT demonstrated. | New strict gateway/private transport; reject unknown nested fields before reservation/transport. Genuine financial provenance blocked. Frozen original remains historical evaluation code. |
| F6-04 | P1 VERIFIED; OPEN HOLD | Valid schema and citation accepted completion/refund prose against pending evidence. IDs do not prove entailment. | AI remains disabled; no semantic-safety claim. Constrain supported claim categories and independently score before enabling inference. No execution authority exposed. |
| F6-05 | P2 VERIFIED; fixed locally | Exact timer equality/modulo missed notices under normal callback drift. | Crossed thresholds and deliberate drift regression in judge-slow-notice.test.ts. |
| F6-06 | P2 VERIFIED; improved locally | Signed-in owner still saw owner sign-in; guest/owner/Lab mixed in primary navigation. | Grouped account actions, owner checkout link, guest explanation, technical appendix. Unit and browser focus checks. |
| F6-07 | P1 HYPOTHESIS; OPEN | Socket-peer auth throttling may group unrelated judges behind Vercel/Render. Local shared-IP limit proven; hosted distribution NOT TESTED. | Retain spoof protection; measure trusted boundary or redesign guest admission. Never blindly trust forwarded headers. |
| F6-08 | P2 VERIFIED; fixed locally | Missing AI_MODEL silently selected legacy fallback. | Require explicit configured model. Groq scaffold accepts supplied candidate set and is unwired from hosted startup. |
| F6-09 | P2 VERIFIED; improved locally | No provider cooldown across service instances. | Durable model-scoped429/transport circuit. PG regression checks new-instance cooldown, no extra reservation/call, recovery probe. |
| F6-10 | P1 dependency risk VERIFIED; partial fix | Audit12 findings, including Zod4.6.5 pinned transitively by auth. App exploitability NOT TESTED. | Zod4.6.6 including override, Fastify5.12.6 and allowed transitive updates. Two moderate glob/minimatch advisories remain. |
| F6-11 | P2 HYPOTHESIS; OPEN | Shared payment-row locks may serialize independent case reads. | Correctness locks retained; throughput/capacity unmeasured. |
| F6-12 | P2 HYPOTHESIS; OPEN | Inference may complete against superseded merchant evidence. | Snapshot recorded and UI describes it; add two-tab inference/repair race before enabling live AI. |

Raw red/green evidence is in ignored `.work/runs/phase6/`. No frozen fixture labels, assertions or Lab reports were rewritten to improve results.
