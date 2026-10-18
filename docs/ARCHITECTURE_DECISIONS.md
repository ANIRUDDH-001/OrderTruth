# OrderTruth — Architecture decision record

Store **only durable, non-sensitive** decisions here. Detailed local agent scratch notes belong in ignored `.work/ledger.md`. Each new ADR must include date, status (`proposed/accepted/reversed`), decision, alternatives, evidence, consequences and user approval when needed.

## ADR-001 — Two complete workspaces, shared incident domain
**Status:** Accepted by product owner 2026-10-18. Engineers are the initial target buyers; merchant operators are full-featured secondary users, not a toy extension. Shared truth store; role-appropriate views/actions. Separate independent OrderTruth branding.

## ADR-002 — No production money or external repair in prototype
**Status:** Proposed safety contract; verify with user before Gate 1. Sandbox PayPal checkout only; corrections permitted only in the controlled reference merchant under explicit approval. No AI-authorized financial API mutations.

## ADR-003 — Single service and SQLite first
**Status:** Proposed, not final. Favor a modular monolith and SQLite for reproducible local demo; must test persistence, concurrent access and restart. Reconsider based on measured requirements, not scale speculation.
