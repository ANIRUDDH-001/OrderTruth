# Private AI configuration

Insert keys privately in `D:\Projects\OrderTruth\.env`:

```dotenv
GEMINI_API_KEY=
GROQ_API_KEY=
AI_PROVIDER=disabled
AI_MODEL=
```

Paste each key after its corresponding equals sign. The root `.env` is ignored by Git. Do not paste keys into chat, browser code, screenshots, reports or `VITE_` variables. Local hosted mode reads this root file while using its separate managed PostgreSQL/auth configuration. Restart the server after a private edit.

Key insertion does not enable AI. Leave `AI_PROVIDER=disabled` while semantic grounding, provider account controls and bounded synthetic evaluation remain unqualified. The current hosted runtime supports Gemini only; the Groq transport is scaffolded but is not yet selectable in hosted startup. Both private key slots are ready without any source edit by the owner.

Gemini now accepts `GEMINI_API_KEY`. Existing `AI_API_KEY` remains a Gemini compatibility alias; clear it when migrating to a different dedicated key. Selecting Gemini with conflicting aliases fails with names-only configuration errors. Both provider keys join server-side log redaction even while disabled. Historical frozen evaluation commands still use their documented legacy alias; they are not the new comparative pilot.

`AI_MODEL` must be explicit before inference. Owner-supplied candidate IDs remain candidates until exact API/account support is verified; no default model, automatic provider fallback or live test is enabled by this change.

## Render private environment

For the existing backend service, add `GEMINI_API_KEY` and `GROQ_API_KEY` as private server environment variables through the authenticated Render interface when hosted AI is qualified. Keep `AI_PROVIDER=disabled`, `AI_DAILY_LIMIT=0`, and `AI_USER_DAILY_LIMIT=0` until then. Never place keys in Vercel frontend variables, build arguments, public release manifests or tracked configuration. The current release operator explicitly keeps hosted AI disabled; changing private keys alone does not override that gate.

No provider request is needed to insert or validate placeholders. Free-tier eligibility, billing controls, account limits and data terms must be verified before the authorized bounded synthetic pilot. Genuine Sandbox data remains blocked by the current egress boundary.
