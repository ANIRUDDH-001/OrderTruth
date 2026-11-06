# OrderTruth — current engineering handoff (6 November 2026 IST)

**Status addendum, not a production release approval.** This note supersedes *status claims*, not immutable historical evidence, in `docs/G0_G3_TEAMMATE_HANDOFF.md`, `docs/TEAMMATE_HANDOFF.md`, and previous V3 checkpoints. Read those documents and `AGENTS.md` before working. Facts in **Remote** were checked through the GitHub connection on 6 November; **Owner/Claude-reported** evidence has not been re-executed here.

## Verified remote state

- Public repository: `ANIRUDDH-001/OrderTruth`. `main` = `eb39f1549b34f67f2acb67a52d87e28be62cfb1b` (V2 fallback; GitHub CI passed on 29 October).
- `fixes` = `acf0b5fb562f25b6a55687310ba99944e6068cdf` (as checked); 20 commits ahead and 3 behind `main`; **not a merge-ready deployment**. No open pull requests found.
- Latest CI, `https://github.com/ANIRUDDH-001/OrderTruth/actions/runs/42214424732`, failed: Windows `offline` job had **1 failed, 1,245 passed**, TypeScript check passed, frontend build skipped. Linux/Postgres job passed.
- Failure: `tests/code-investigation.test.ts` compares `pilot-freeze-v4-r2.json` with a computed manifest. All 12 pinned implementation file hashes, evaluator digest and freeze digest differ on Windows. Hypothesis: Git checkout CRLF changes; confirm with Git byte hashes before fixing. **Do not regenerate/modify the frozen manifest to turn CI green.**
- Public production deployment, latest hosted source SHA, local dirty/untracked files and live judge flow were not inspected or validated through this read-only GitHub audit.

## Gate status

| Gate | Status and boundaries |
| --- | --- |
| G0 | Preservation GO (historical evidence, owner/agent reported). Preserve ignored archives; a GitHub clone is not sufficient. |
| G1 | GO only within the synthetic reference-merchant Lab contract. Does not prove a naturally occurring PayPal race. |
| G2 | Claude reported **offline live-readiness GO** at source SHA-256 `802f758dab677c864ed022609b800e8c82e06ab7c07efe1de20910f00fff2702`. The isolated workflow's real Sandbox pre-approval payee readback, buyer approval/capture and genuine signed webhook remain **NOT TESTED**. No new G2 payment authorization is implied. |
| G3 | The owner ran four one-shot Gemini API `gemini-3.5-flash-lite` requests (H1–H4); all HTTP 200 and execution evidence reportedly intact. Claude graded all four **INVALID** under frozen JSON-only formatting and reported no counted correct diagnosis or patch. **AI benefit not demonstrated.** This is an exploratory four-case result; grading was performed by the holdout author, and a separate external source-level grading recheck is not claimed. |
| G4/G5 | Owner has **not authorized** new development. |
| Hosted V2 | Preserve the existing functional fallback. Current availability, deployed revision, full anonymous judge session, and final video remain to be qualified. |

G3 result manifest SHA-256: `022a422a26cbb8479b6375e73c175f8976b99b9427fceefe3d1051530ee623b6`.

Owner-verified grading SHA-256 identities: `GRADING_HASHES.txt`: `33b0e58cd5b29be3ce9464ac848a6004cb1f724cf68eca8b69ef9420eb66efb0`; `G3_GRADES.json`: `ac620bfb89cb64e1121418f7cebdbc6b39db4beb6db25f79166dc3c4bacf5dae`; `G3_GRADING_REPORT.md`: `4c8ba297076c88fc31fa2453a3701ab1b5c35f14a9e26355ed21ac5c77bf32cf`. These are non-secret hashes only. The holdouts are consumed; do not reuse them for a new blind comparison. Earlier potential access to the private answer key through Codex-related Windows identities remains a disclosed custody limitation; direct named ACLs were removed and temporary key copies removed, but absence of historical access was not proven.

## Transfer the actual source and preserved evidence

The owner’s Windows repository is `C:\projects\ordertruth`. The complete portable transfer lives under the **Git-ignored** `.work/portable-handoff-20261106/`; copy that directory as a unit through a separately approved **private** channel. Do not expect the Git clone to include it. Reconstruct in a new empty directory following its `README_TRANSFER.md` and independently check its manifests before applying any changes.

Required published SHA-256 references from the earlier owner/agent closeout:

| Artifact | SHA-256 |
| --- | --- |
| `g2-g3-v4-review.zip` | `204e1360aedb050593b5bfb146f643997cd6a955ff1af90aa196f087307580f4` |
| `g2-preapproval-payee-delta.zip` | `0e7a5a36fd431bed9eeb1315fa6ff14f1b7bb406080e55d6e9a73035fa7e9f21` |
| `g0-g3-review.zip` | `616b1ce9ba8a1df654b34cf7836baa9325ea097be8fb6c5d7e352bff95f44571` |
| `implementation.patch` | `ed01fbdc0774263a316d7f9cdcdbc357e11d61a57bc69d8d274d8dcce47509f1` |
| `preserved-original-dirty.zip` | `4ae75f1838de4520d3c0f3a0c264a70002b51a98b253739abdf7977e08ea6659` |

**Never publish or transfer in a general teammate repository:** `OrderTruth-Private-Evidence/g3-holdout`, `answer-key.json`, private grading annex, G3 private owner kit, raw model responses, `.env`, tokens, credentials, local databases, private payments or account artifacts. Sharing anything private with a designated grader requires separate owner authorization.

## Priority decisions and implementation limits

1. **CI-only fix:** Confirm Windows CRLF conversion against expected LF SHA-256, then preserve exact blob bytes using narrow `.gitattributes` rules. Do not alter the frozen source, the v4-r2 JSON, test expectations or accepted hashes. Verify the fix on a clean checkout and require a new CI PASS before declaring the branch clean.
2. **G2 decision:** Only after exact source/budget/registration review may the owner authorize one genuine Sandbox test. No payment, webhook registration, tunnel mutation, retry or spending is authorized by this handoff. If unsafe or infeasible, preserve `G2 OFFLINE-GO / LIVE-NOT-TESTED`.
3. **AI product relevance:** The sealed G3 test was code-defect diagnosis, not a direct comparison of the hosted V2 investigator against a deterministic-only operator experience. Do not claim improvement; no further AI calls or reused holdouts authorized.
4. **Delivery:** Owner says the first Devpost entry was submitted with a placeholder video. Replace it on the existing entry with a real, public YouTube demonstration under three minutes. Keep the V2 demo working and label its injected duplicate as controlled. Verify exact hosted source, anonymous judge flow, API/AI fallbacks and receipt. Report no unshipped functionality as shipped.
5. **Time boundary:** Owner's planning cutoff for experimental work: 8 November 2026, 18:00 IST; teammate needs the source/evidence handoff now. Submission deadline recorded as 13 November 2026, 01:30 IST (verify official event schedule).

**No merge, force-push, deployment, payment, provider call, final video upload or Devpost edit is authorized by this note.** GitHub code publication should be confined to a reviewed handoff/CI branch, not `main`. If the local working tree contains additional uncommitted changes, inventory them first; do not reset/clean/stash them just to make the change.
