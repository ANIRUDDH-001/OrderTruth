# Payment API / Security Checklist — design only

This file is not proof of implementation. The full contract is `docs/ORDERTRUTH_MASTER_PLAN.md` §4–9.

**Trust boundaries:** browser ↔ OrderTruth API ↔ PayPal Sandbox; webhook sender ↔ verified receiver ↔ durable event inbox; AI is untrusted explanatory compute; merchant data has explicit organization scope; recovery needs human approval.

**Mandatory:** sandbox-only API host, server credentials, server-calculated integer money, stable idempotency keys, capture readback after unknown status, webhook signature verification, dedup/inbox, append-only evidence and recovery audit, role-scoped auth, local-only recovery, redacted logs, safe UI escaping, controlled AI JSON schemas, valid evidence reference checks, multi-tenant tests, fail-closed errors.

**Forbidden until explicitly approved:** live financial operations; automated PayPal captures/refunds by agents; real merchant credentials; external tunnel requiring billing; public credentials for judging; storing raw sensitive customer data; unreproducible demo-only shortcuts.

**Public docs to re-check:**
- https://developer.paypal.com/sdk/js/set-up/
- https://developer.paypal.com/checkout/integrate
- https://developer.paypal.com/api/rest/requests/
- https://developer.paypal.com/api/rest/webhooks/rest/
- https://developer.paypal.com/negative-testing/request-headers/
