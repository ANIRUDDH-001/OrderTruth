# Evidence and competitor research register

**No uniqueness or demand claim becomes fact merely because a Devpost entry or forum commenter asserted it.** Add a row for each independently inspected source; distinguish first-hand report, published research, vendor claim, and demonstrated code.

| Source | Claim or demonstrated behavior | Evidence tier | Competing explanation | Reproduced? | Product consequence |
|---|---|---|---|---|---|
| https://github.com/woocommerce/woocommerce-paypal-payments/issues/4173 | Reported duplicate merchant orders despite single capture under concurrency | First-hand issue report, not our test | Plugin-specific race / version dependent | NO | Controlled merchant race scenario candidate |
| https://developer.paypal.com/api/rest/webhooks/rest/ | Webhook verification and retry guidance | Primary vendor documentation | Endpoint/version differences | Not an execution proof | Signed inbox + idempotent consumer required |
| https://paypalaihackathon.devpost.com/rules | Submission criteria and judging | Primary event rules | Terms may be amended | Read only | Keep product, evidence and 3-minute video complete |

Add competitors with code/demo evidence, not scores assigned from descriptions. Do not send accounts, secrets or private data to this file.
