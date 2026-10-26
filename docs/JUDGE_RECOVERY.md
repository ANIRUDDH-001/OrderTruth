# Judge recovery and local waiting limits

The judge UI restores the session, scenario, latest plan and any committed receipt
through read-only endpoints. Saved AI history loads separately; failed or stalled
history does not block the case or trigger inference. History failures are labelled
unavailable. These behaviors are locally verified, not hosted qualification.

`Resume/Recheck Case` rechecks session access and persisted case/receipt state.
Interrupted writes block further mutations until this succeeds. It never replays
an approval, repair or other POST and never creates a replacement plan. An absent
receipt is not proof of rollback; the server still validates each explicit action.
Successful case mutations also refresh authoritative state rather than trusting an
unvalidated mutation response as a new scenario or plan.

Session access is UNKNOWN/CHECKING until a valid response confirms authentication
or sign-out. A failed/lost sign-in response is recovered by discovery, not a second
anonymous identity. A confirmed expired session keeps its run link; a newly chosen
anonymous session cannot own the old case or approvals. A 403 is an authorization
or origin refusal, not automatically a session expiry. Foreign/missing cases retain
their link and require an explicit choice to start a different case.

Local request budgets are 90 seconds for essential reads, 45 seconds for writes,
and 8 seconds for optional history. Each includes fetch, response-body parsing and
all retry/backoff time. GETs alone retry, at most six attempts; POSTs are sent once.
The read budget accommodates a previously recorded approximately 73-second health
response; that observation did not establish a cold start or a service guarantee.
Writes use a shorter wait because the server may commit after the browser stops
waiting. Timeout or disconnect therefore means uncertain outcome, never rollback.
Sequential session/case/receipt reads have separate budgets, so these are not a
90-second whole-journey guarantee. The 2-second/90-second planning goals remain
unqualified on the host. Browser suspension can delay JavaScript timer delivery.

Malformed successful JSON is rejected. Essential session/case/receipt shapes are
checked before they become UI state. Payment state, ownership, exact approval,
expiry, idempotency and receipt postconditions remain server-authoritative.

Local evidence: `.work/runs/recovery-fix-2026-10-26/` (ignored, sanitized). Historical
payment observations and AI study evidence are unchanged. No production, provider
inference, payment action or deployment is part of this qualification.

## Independent-audit corrections

Foreign/missing-case access is not an exception to uncertain-write reconciliation.
An uncertain case mutation retains its original run ID; neither a subsequent404
nor sign-out clears that obligation. Only a successful read of the affected case
permits further writes. Starting another case is blocked while that outcome is
unreconciled.
The run ID is marked in browser storage before the mutation POST so the obligation
survives reload when storage is available; no payment payload or credential is saved.

Creation responses use the same complete required scenario parser as case reads,
before assignment to UI state. An invalid response leaves the prior view and run
link intact, labels creation uncertain and never repeats the POST automatically.
A browser-storage marker preserves this warning across reload when storage works.
If creation committed but no validated case ID was received, the current API has
neither an owned-case listing nor a creation-request lookup. Rechecking an older
case or session cannot locate/reconcile that creation. Writes stay blocked; a
separately authorized read-only investigation is needed. No case ID is invented,
and no reset/clear-uncertainty control is added. With browser storage unavailable,
the warning survives only in the current page; this is a disclosed limitation,
not a claim of durable creation idempotency.

Optional history completion updates only its investigation panel. Active owner
inputs and focus remain in place; passwords are never persisted for this purpose.
If focus is inside the investigation panel itself, only its status text changes;
the loaded history is displayed on the next explicit case-view update.
