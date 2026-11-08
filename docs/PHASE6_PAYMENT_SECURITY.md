# Phase 6 payment/security

**Local regressions PASS; fresh genuine Sandbox/webhook qualification NOT TESTED.**

F6-01/F6-02 are reproduced correctness defects, now fixed locally. Authoritative capture remains a matching captured GET, not POST status, webhook simulation, merchant count, AI or HTTP success alone. Tests cover body disconnect, invalid JSON, null/nonobject, malformed purchase units and malformed error details. Failed fresh GETs persist nonauthoritative evidence and block planning through the old completed observation.

Preapproval preservation applies only to correlated capture-less CREATED/PAYER_ACTION_REQUIRED orders still awaiting buyer approval. It cannot return an uncertain claimed attempt to approved. Lost-response and concurrent service-instance tests pass; no genuine PayPal operation occurred.

## Guarantees and boundaries

- Durable capture claim arbitrates application processes. No universal provider exactly-once guarantee. Crash after claim but before POST can remain pending; inspect/readback rather than blindly repeat payment.
- Recovery checks session/run ownership, exact plan hash, approval, expiry, stale evidence and current merchant state. Existing payment→intent→run lock ordering is retained.
- Repair has no PayPal dependency and locally voids only the approved duplicate set. Receipt verification re-reads merchant state and stored provider evidence, not a fresh PayPal GET.
- Actual PG tests cover concurrency, stale plans, rollback/connection loss, uncertain response, repeated execution, cross-session access, webhook inbox processing and integrity guards.
- Same-origin protections and maintained session authorization remain intact. PWA bypasses APIs and never replays writes.

Genuine HTTPS signature→merchant effects, owner capture crash liveness, split fulfillment/multiple captures, other merchants, shipping/inventory effects, backup/restore and production-money flows remain unqualified. No hosted financial record was mutated.

Separately reviewable future plan: one owner-approved USD1.00 Sandbox purchase; at most one capture POST after manual buyer approval; read-only reconciliation; at most five signature-verification postbacks. Temporary webhook registration/deletion and free HTTPS listener require explicit scope. Use disposable experiment data. Stop on live host, identity/amount disagreement, uncertainty or cost. This report authorizes none of those actions.
