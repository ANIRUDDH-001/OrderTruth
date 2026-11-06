# OrderTruth claims and evidence

Status at W4 CP1, 3 November 2026: documentation draft for review; not release approval. `VERIFIED` below means this documentation checkpoint inspected the cited source/record, not that it repeated the historical experiment. `RECORDED_NOT_REPRODUCED` identifies prior execution. Current hosted service, new inference, payment operations and video recording are NOT_TESTED here.

## Two evidence paths

**V2 investigation and recovery:** a judge scenario references an existing genuine PayPal Sandbox observation. Its duplicate merchant orders are a controlled fault. Evidence-grounded AI proposes hypotheses and a read-only diagnostic; the user approves an exact merchant-only repair. This is neither an automatic PayPal correction nor proof of AI advantage.

**V3 Integration Lab:** a separate synthetic P1/T1 reference-merchant concurrency experiment. The original handler duplicates; a human-written SDK integration fixes the tested defect. No real PayPal capture, model call or applied AI migration patch forms part of Gate A. The lab did not protect or repair the V2 case's payment.

## Claim register

| ID / status | Bounded claim and source | Exclusion |
|---|---|---|
| C01 / RECORDED_NOT_REPRODUCED | Gate A clean reproduction at source `fc85ac3db1388bd84a3a55b8198d9dc3b2ad6c86`, run `gate-a-2026-10-30T15-58-19-399Z`: two accepted matching repetitions with successful final cleanup. [Summary](evidence/lab/gate-a-final-summary.json), [cleanup](evidence/lab/gate-a-final-cleanup.json), [reports](evidence/lab/manifest.json). | No fresh Gate A execution in W4; timestamps/report bytes need not repeat. |
| C02 / VERIFIED records, execution RECORDED_NOT_REPRODUCED | Original forced race records two orders; reference forced race and eight-process stress record one. Nine negative controls failed their intended checks. [Derived proof](evidence/lab/gate-a-proof.json); build rederives it using the pinned historical verifier. | A tested fixed-lab result, not arbitrary untrusted-code safety or universal exactly-once fulfillment. |
| C03 / VERIFIED provenance | Reference origin is human-written; source comparison is [published](evidence/lab/gate-a-reference-source.json). No applied migration patch was recorded. | Never present this comparison as AI-authored code or an applied migration diff. |
| C04 / VERIFIED current integrity | W1's 33 sealed source-file hashes matched at this checkpoint intake. [Publication inputs](evidence/lab/README.md) are public build inputs; hashes/semantic validation reject altered historical records. | Hash consistency is not independent execution authenticity or external attestation. |
| C05 / RECORDED_NOT_REPRODUCED runtime | Gate A candidate Node 22.18.0; host controller Node 24.11.0; PostgreSQL 18.6; pnpm 11.4.0. [Reports](evidence/lab/manifest.json). W1 separately recorded current-source Node 22 validation. | Host tests and orchestration are distinct from supported candidate-runtime evidence. |
| C06 / RECORDED_NOT_REPRODUCED Sandbox | [Gate1 closeout](GATE1_CLOSEOUT.md), [actual-evidence repair](STAGE1D_RESULTS.md), [hosted workflow](HOSTED_APPLICATION.md). Genuine capture/readback and controlled merchant effects are distinct records. | Stored capture evidence is not a new GET readback. No current payment or hosted rehearsal occurred here. |
| C07 / RECORDED_NOT_REPRODUCED AI | [Advisory results](GATE2C_AI_RESULTS.md): tied on classification and beat the control on no preregistered metric, with fewer citations and diagnostics. That experiment did not evaluate the distinct hosted investigator prompt. Separate [investigator analysis](INVESTIGATOR_EVAL_RESULTS.md) reports four REGRESSION decisions with post-hoc/AI-review limitations. | No demonstrated AI superiority, general model-inferiority conclusion, or human-usefulness proof. Existing V2 AI is separate from unmeasured V3 migration value. |
| C08 / BLOCKED public reproduction claim | Public availability of exact Gate A source S is NOT_VERIFIED. Publication/build commit P is separate. [Reproduction](V3_REPRODUCTION.md). | A local commit or authenticated repository view does not establish public access. W1's fixed label remains unchanged. |
| C09 / NOT_TESTED release | Hosted URL in README is a historical entry point. [Release gates](V3_RELEASE_GATES.md) require final clean build, access rehearsal and owner approval. | No claim `/lab/` is deployed or current hosted app/AI is available. |
| C10 / NOT_TESTED W2/W3 outcome | Reviewed W2 plan and capacity configuration are prerequisites, not sandbox qualification. W3 execution is unauthorized. | No hardened verifier acceptance, AI candidate execution or migration-value result. Update only after separately reviewed and owner-committed evidence. |

## Stable identities

These describe the historical result, not a new W4 image or runtime:

| Identity | SHA-256 |
|---|---|
| Historical canonical verifier manifest | `b9e880ee0970c0bd0fb4bbd63086dc86beab1e179690fb4fe52f594309e44f72` |
| Guard subject tree | `7bef5fc5e0c5eaa5ac9bdcf16f6fa7c8bca86f5df83637d2e3c80f4e61f70f42` |
| Public publication manifest, raw bytes | `5638722290de26bc49bb6e8b55652e260ec3d35eb55269ce96637c70e01003a2` |
| Final summary, raw bytes | `23ee9fb1742797aa445855db48ae35482065b437c088ef31fc3430d97638116d` |
| Final cleanup, raw bytes | `f43e787ed824a362e2748770897b5af7cab733944ef84c215d723f3a6dabcefe` |

Other artifact hashes are enumerated in [the publication manifest](evidence/lab/manifest.json). Canonical manifest identity differs from the hash of its serialized JSON bytes; do not compare them as if they were the same quantity. Build publication identity reflects its actual checkout; unrelated untracked files legitimately produce “Uncommitted preview”. Do not remove that label by altering Git status or evidence.

## Language boundaries

The one-capture/one-order rule applies only to the documented reference-merchant lifecycle. P2/T2, consumers, ingest, historical coverage, broad integration discovery, production security and external financial exactly-once effects remain deferred. OrderTruth is independent and not endorsed by PayPal. Keep unavailable/cached AI and unresolved outcomes visible. Do not turn a prior test pass, a clean hash or a planned release step into a present-tense service claim.
