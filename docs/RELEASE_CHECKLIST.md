# OrderTruth submission and judge-access checklist — NOT READY

Source: https://paypalaihackathon.devpost.com/rules ; recheck before submission.
Status updated after the hosted deployment (2026-10-23). A ticked box needs evidence; see `docs/GATE3A_RESULTS.md` and `docs/HOSTED_APPLICATION.md`.

- [ ] Verify Devpost hackathon joined and eligibility confirmed by user.
- [ ] Meaningful real PayPal Sandbox integration and meaningful independently measured AI role. *(Sandbox: VERIFIED-LIVE in Gates 0/1B. AI value versus baseline: NOT measured; live evaluation BLOCKED.)*
- [ ] Truthful functional demo: actual app, not mock; clearly identify controlled fault injection and PayPal readback. *(Gate 3A: the console labels controlled faults, synthetic `DEMO…` readbacks, stored-not-re-read PayPal facts and SIMULATED_TEST approvals. False all-clear and grace-display defects fixed. Demo video not yet recorded.)*
- [x] Clean checkout instructions written: `README.md` (Gate 3A). Clean-export install → check → build → seed → console → repair → restart VERIFIED locally on Windows. See `docs/GATE3A_RESULTS.md` §4.
- [ ] All relevant test and product limitations disclosed. *(README "What is not proven" and the quality matrix are current as of Gate 3A; re-check at submission.)*
- [ ] Public GitHub/GitLab/Bitbucket repository, license approved by user and visible at root/About; secrets scanned, no private buyer accounts. *(License: DONE — MIT `LICENSE` at the root, naming Aniruddh Vijayvargia and Prachi Agarwalla. Still open: re-run a secret scan of the final commit and confirm the repository is public. The Gate 3A scan of the clean export found 0 real secrets.)*
- [ ] Functional access via clear local reproducible setup or hosted URL; free judge access through Dec 15, 2026. *(Hosted: https://order-truth.vercel.app (Vercel) → Render API → Neon, on Free plans. Live `/api/health` returned 200 on 2026-10-23; cold start 53 s. Still open: a full rehearsal on the final deployed version, cold-start and quota drills, and availability checks through Dec 15. Local setup is documented in `docs/POSTGRES_LOCAL.md`.)*
- [ ] Hosted webhook path qualified, or explicitly scoped out of submission claims. *(Neon held 0 webhook deliveries at the 2026-10 independent review. The route mounts only when `PAYPAL_WEBHOOK_ID` is set on the API host.)*
- [ ] Public CI green on the release commit.
- [ ] English project description, tools/model details, publicly visible YouTube demo strictly less than 3 minutes.
- [ ] Video recorded from functioning app; no unlicensed trademarks/music/assets.
- [ ] Submission made ahead of 12 Nov 2026 12 PM PST / 13 Nov 2026 01:30 IST; save confirmation.
- [ ] User/Codex/approved Antigravity handles Git commits; **Claude never commits**.
