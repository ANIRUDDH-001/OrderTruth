# OrderTruth owner acceptance

Run this checklist on the exact candidate after its coordinated release. Record the build SHA, date, browser and any failed step. Keep the case links in your test notes. Guest cases write controlled merchant records. Only the separately authorized payment journey writes to PayPal Sandbox.

## Guest workspace

Start at the [OrderTruth overview](https://order-truth.vercel.app/?view=overview) in a clean browser profile. Open it on mobile and on desktop. Use Tab and Enter for the main flow at least once.

1. Choose **Resume/Recheck Case**. With a new profile the workspace should confirm the connection and explain how to start. Choose **Inspect a payment outcome** to create a guest session and an owned case. Expect one active merchant order and an original PayPal Sandbox observation with its recorded time and amount. Save the case URL.
2. Choose **Introduce duplicate**, then **Detect anomaly**. Expect two active orders and a finding explicitly attributed to the controlled scenario. Switch between Operations and Engineering. The same case and permissions should remain in effect, with technical evidence available in Engineering.
3. Run an available merchant diagnostic. Its observed results should appear on the case and survive a refresh. **Investigate with AI** is optional. A fresh result consumes one free attempt. Cached history, case reads and deterministic diagnostics consume no model quota. Expect either cited hypotheses with a useful available diagnostic or an explanation of the limit or outage. Continue with the deterministic workflow in either state.
4. Choose **Review exact repair plan**. Confirm that the plan identifies one keeper and one void, then select **Approve this exact merchant-only plan**. Confirm that both orders remain active until **Execute approved local repair**. Execute once. Expect one active order, one voided duplicate and a `SUCCEEDED` receipt. Prior diagnostics and saved advice remain available as history.
5. Refresh and open the saved URL in a second tab of the same profile. Both should recover the same receipt. Choose **Recheck committed receipt**, then export it if you want a local copy. Receipt recheck reads persisted evidence and uses zero PayPal or model calls. A current payment warning should leave a historically verified correction visible. A fresh correction requires a current eligible duplicate and a new exact approval.
6. Open the saved URL in a clean separate profile. Expect access to be refused. Return to the first profile to recover the receipt. If the original anonymous session has expired, retain the link and note that a new guest cannot take ownership of it.

If a request is interrupted, choose **Resume/Recheck Case** before another write. Recover the original operation or explicitly retry that same operation if the workspace offers it. An expired or stale plan requires a new review and approval. A changed receipt identity, duplicate execution, false green status, missing history, or cross-profile disclosure fails acceptance.

## Missing merchant order

Start from the [overview](https://order-truth.vercel.app/?view=overview) in the same guest profile. Open **Explore another integrity case** and choose **Inspect a missing-order case**.

1. Before the displayed grace deadline, choose **Check missing-order condition**. Expect zero merchant orders, a waiting state and no repair control.
2. After the deadline, check the condition again. With continuous matching payment evidence, expect the missing-order finding. Run the merchant write-outcome check. Expect zero committed controlled writes and wording that leaves the cause open.
3. Refresh. The finding and diagnostic should restore, with zero merchant orders and no correction plan. Missing or contradictory payment evidence should prevent a finding until the evidence and grace conditions are satisfied.

This journey creates an isolated case and persists its checks and diagnostic. It consumes zero PayPal and model calls. Any creation or fulfillment control on this case fails acceptance.

## Owner access and saved checkout

Open [Owner Sandbox checkout](https://order-truth.vercel.app/owner/) from a guest profile and verify that protected payment controls are refused. Return to the [overview](https://order-truth.vercel.app/?view=overview), choose **Owner access** and sign in privately. Open **Owner Sandbox checkout** from the account menu.

1. Confirm the owner workspace and Sandbox checkout clearly identify the reference purchase as USD 1.00. If the original checkout is saved in this profile, open it without starting a purchase. A previously completed checkout should reopen with its stored state. Record whether the saved order was available in this profile.
2. After the payment-action freshness window expires, revisit checkout. Expect **Confirm owner access** or the sign-in recovery link before a new financial action. Confirm access privately. The saved checkout identity should remain available. If an outcome is uncertain, keep the existing order and note the displayed next action.
3. Treat **Recheck PayPal evidence** as a separate, budgeted Sandbox GET. The regular guest receipt recheck is the read-only alternative for merchant evidence. Record a provider outage or conflicting readback as unresolved until an authorized recheck succeeds.

Owner sign-in creates an authenticated session. Viewing a saved checkout uses stored state. Stop if guest access reaches a financial action, authentication expiry discards an order, or an uncertain payment is shown as confirmed.

## Separately authorized genuine Sandbox checkout

Use [Owner Sandbox checkout](https://order-truth.vercel.app/owner/) only after approving one USD 1.00 Sandbox order and at most one capture of that order, with a bounded readback and signature-verification allowance. Use the established Sandbox seller and Sandbox personal buyer account. Keep the browser under your control for sign-in, buyer approval and capture.

1. Begin one new purchase. Record whether the official PayPal SDK opens the buyer flow and whether it returns the same order after approval. Keep the order if the presentation is interrupted.
2. If the SDK presentation fails and **Open saved order on PayPal Sandbox** is available, use that link for the same order. Record recovery and SDK-native outcomes separately. After buyer approval, follow the UI to verify that order. The SDK path may capture automatically after approval. Use **Capture approved Sandbox payment** only when the UI offers it for the approved, uncaptured saved order and the authorized capture remains unused.
3. Expect one completed USD 1.00 Sandbox capture and **Sandbox payment verified** only after matching authoritative readback. Reopen the same checkout. On timeout, hold the order and inspect its saved state before another action. A duplicate capture claim, different order, unverified green result or real card prompt fails acceptance.
4. Ask the engineer to correlate the order and capture with the persisted PayPal readback, the capture claim and authenticated webhook processing. Genuine webhook delivery may arrive later. Record delivery and processing as separate results.

## Optional integration evidence

Open the [Integration Lab](https://order-truth.vercel.app/lab/) from the workspace and verify that its verifier evidence is marked experimental and separate from your merchant cases. Use the return link to reopen the workspace. This is a read-only journey.

Return the case links and a pass, fail or skipped result for each journey. Include any unexpected message or retry. Owner acceptance is pending until you complete and confirm the checklist.
