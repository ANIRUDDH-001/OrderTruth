# Private AI configuration

Insert keys privately in `D:\Projects\OrderTruth\.env`:

```dotenv
GEMINI_API_KEY=
GROQ_API_KEY=
AI_PROVIDER=disabled
AI_MODEL=
```

Paste each key after its corresponding equals sign. The root `.env` is ignored by Git. Do not paste keys into chat, browser code, screenshots, reports or `VITE_` variables. Local hosted mode reads this root file while using its separate managed PostgreSQL/auth configuration. Restart the server after a private edit.

Key insertion does not enable AI. The integrated runtime supports explicit `gemini` or `groq` selection. Keep production disabled until the exact candidate and its bounded hosted qualification pass. Both providers have produced validated responses using the owner's free-only projects; this establishes working integration, not superiority over the deterministic baseline.

Gemini now accepts `GEMINI_API_KEY`. Existing `AI_API_KEY` remains a Gemini compatibility alias; clear it when migrating to a different dedicated key. Selecting Gemini with conflicting aliases fails with names-only configuration errors. Both provider keys join server-side log redaction even while disabled. Historical frozen evaluation commands still use their documented legacy alias; they are not the new comparative pilot.

`AI_MODEL` must be explicit before inference. Owner-supplied candidate IDs remain candidates until exact API/account support is verified; no default model, automatic provider fallback or live test is enabled by this change.

## Render private environment

For the existing backend service, add `GEMINI_API_KEY` and `GROQ_API_KEY` as private server environment variables through the authenticated Render interface when hosted AI is qualified. Keep `AI_PROVIDER=disabled`, `AI_DAILY_LIMIT=0`, and `AI_USER_DAILY_LIMIT=0` until then. Never place keys in Vercel frontend variables, build arguments, public release manifests or tracked configuration. The current release operator explicitly keeps hosted AI disabled; changing private keys alone does not override that gate.

No provider request is needed to insert or validate placeholders. The owner confirmed free-tier accounts with paid billing disabled. The authorized initial allowance is ten attempts per provider, including failed calls. Local ignored `.work/ai-pilot-total-allowance.json` is the authoritative aggregate counter: never reset it or retry consumed pilot cases. `scripts/ai-synthetic-pilot.ts` preserves the exact version-four experiment and intentionally refuses reruns after its predecessor allowance has changed; it is not a general benchmark command.

The current transport sends only validated merchant relationships and relative timing categories. All provider observations are recursively checked and then omitted, including financial facts, provider IDs and timestamps. Stable merchant IDs, key hashes and arbitrary text are not exported. The model chooses a pair of possible merchant causes; the backend supplies all factual wording, counterevidence, citations and an available relevant read-only diagnostic. Model output cannot authorize a correction or initiate a payment. Results are snapshot-bound, checked again under transaction locks before publication, and rejected when stale.

Initial privately selectable models: `gemini-3.5-flash-lite` and `openai/gpt-oss-120b`. No provider fallback or automatic retry. Hosted limits are capped at twelve reservations per UTC day, three per session, at least 65 seconds apart and one in flight. Failed or interrupted calls consume reservations. Configure lower limits for qualification; enabling ongoing hosted inference beyond the initial twenty-attempt allowance requires an explicit bounded rollout decision.

Local browser qualification is an explicit synthetic-only loopback helper (`scripts/ai-browser-qualification.ts`), with real PostgreSQL/auth and selected AI transport. It blocks every PayPal network request and consumes the same pilot counter. Its fixture owner credentials are public test inputs, never hosted credentials. Retain the owned schema and proof until review; do not delete unrelated data.
