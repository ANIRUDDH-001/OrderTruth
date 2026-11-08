# Phase 6 AI architecture/privacy

**Decision: synthetic-only pilot boundary; hosted AI disabled.** No general model discovery or live inference occurred. Initial candidates remain Groq `openai/gpt-oss-120b` and Gemini `gemini-3.5-flash-lite`. Documentation supports the IDs; authenticated account acceptance is NOT TESTED. Other owner-supplied candidates are alternatives, not automatic failovers.

## Implemented boundary

Private evidence → strict preflight → durable allowance/circuit → private adapter → response schema → request-issued citation check → private citation restoration → hypothesis UI. Hosted startup uses `private-investigator.ts`; original `investigation.ts` and its frozen evaluator remain unchanged.

Nested allowlists reject unknown fields, arbitrary descriptions, raw metadata, credentials and unbounded text. Random references change per request. Exact amounts, currencies, timestamps, merchant row IDs and key fingerprints are removed; timing becomes interval relationships. No model receives tools, SQL, payment authority or approval.

All genuine PAYPAL_SANDBOX_OBSERVATION inputs are currently rejected before reservation. Even reduced relationships may identify a transaction; they are not asserted anonymous. Simply enabling a key cannot export genuine financial evidence through this path.

Historical evidence/results remain in the existing private database. No historical deletion or new retention duration is claimed. Reference mappings are process-local; existing operational logs omit bodies and sensitive identifiers. Dedicated payload-free outbound audit events and a tested retention/deletion policy are still NOT IMPLEMENTED. Do not claim full lifecycle compliance.

## Provider terms

[Google unpaid-service terms](https://aistudio.google.com/docs/terms), fetched 8 November (effective 23 March 2026), describe product/model improvement and potential human review, and prohibit sensitive/confidential/personal submissions. The [logging policy](https://ai.google.dev/gemini-api/docs/logs-policy), checked through Context7, reinforces these boundaries. Real financial evidence is unsuitable for this free-tier pilot.

[Groq data controls](https://console.groq.com/docs/your-data) describe default inference non-retention with reliability/abuse exceptions up to 30 days and configurable ZDR. This is a documented policy, not proof of the connected account's settings or a blanket privacy guarantee. Account controls and training/contract terms need review before a pilot.

[Groq structured outputs](https://console.groq.com/docs/structured-outputs), checked through Context7, supports the strict schema transport. The scaffold uses a fixed endpoint, one request, body bound and 1024 output tokens. It is absent from hosted provider selection. [Gemini candidate documentation](https://aistudio.google.com/docs/models/gemini-3.5-flash-lite) supports the exact candidate identifier without broader discovery.

F6-04 remains OPEN: valid citations do not prove prose grounding. Keyword filtering alone cannot establish semantic safety. Independent factual/unsafe-action scoring and constrained checkable claims must precede live enablement.
