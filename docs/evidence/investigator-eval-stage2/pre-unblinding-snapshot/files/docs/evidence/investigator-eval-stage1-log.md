# Investigator evaluation: Stage 1 evidence log

| | |
|---|---|
| **Run** | `investigator-eval-live-2026-10-23T08-26-02-339Z` |
| **Log created** | 2026-10-23, from hashes computed at 2026-10-23T10:39:17Z (UTC) |
| **Prepared by** | Claude Code (Opus 5.5), the coordinator session. The coordinator did not score any sheet. |
| **Status** | Uncommitted when written. Additive record only: no artifact listed here was modified, moved, regenerated or deleted. |
| **Required by** | Preregistration line 294: each Stage 1 copy is "SHA-256 hashed and timestamped into the evidence log before stage 2". |

This log is created late. Until now no evidence log existed: `docs/evidence/` held only Gate 2C files, and no file in the repository recorded a Stage 1 sheet hash. The earliest hashes of the sheets were taken by the coordinator at 2026-10-23T09:06:05Z (Sheets A and B), 09:30:03Z (C) and 09:46:00Z (D). Those were recorded in the coordinator's session and the draft provenance note, not in a committed log.

## 1. How to read this log

- **SHA-256** values were computed from the file bytes at 2026-10-23T10:39:17Z and re-checked when this log was validated (section 10).
- **"Modified (UTC)"** is the filesystem modification time.
  - It is **not** when a reviewer created, scored, submitted or first saw a sheet.
  - For files described as *copies*, it is when the copy was made.
- **Chronology sources** (section 8):
  - **[git]**: commit metadata in this repository.
  - **[fs]**: filesystem modification time.
  - **[session]**: timestamps of messages and tool calls in the coordinator's local Claude Code session transcripts, which are recorded automatically.
  - **[reported]**: statements by the operator or by ChatGPT that cannot be independently verified.
- **"not verified"** means no reliable record was found.

## 2. Code identifiers

| Item | Value | Verified |
|---|---|---|
| Commit the live run was sealed on | `e72556ef775b540a4ba09436326689f4b91c12ee` ("eval: preregister judge-facing investigator evaluation (Revision 3) with offline evaluator"; author date 2026-10-23T08:08:54Z) | [git]; named in `SEAL-MANIFEST.txt` |
| Seal time | 2026-10-23T08:28:51Z, as written inside `SEAL-MANIFEST.txt` | the manifest's own statement; its file time matches [fs] |
| Amendment A1 (pack instructions carry the preregistered J2, U1 and H definitions) | `edd634e725651c369e4872eb40ef11dd0da0aa67`. Author prachi7104, 2026-10-23T10:15:23Z. Files: `docs/INVESTIGATOR_EVAL_PREREGISTRATION.md`, `src/ai/investigator-eval/blind.ts`, `tests/investigator-eval.test.ts` | [git]. HEAD of branch `fixes` when written; not pushed (1 ahead of `origin/fixes`) |

A1 changes only future packs. The live pack below was generated before A1, without the full definitions, and every sheet in section 4 was scored against it.

## 3. Stage 1 inputs

| File | SHA-256 | Size (bytes) | Modified (UTC) |
|---|---|---|---|
| `.work/metrics/investigator-eval-live-2026-10-23T08-26-02-339Z/stage1-pack.md` (live pack) | `83c1dab0755c1901ad773d6430ebf7e2cf9b26c7011166f53b9802fe67835f28` | 76908 | 2026-10-23T08:28:09Z |
| `.work/metrics/investigator-eval-live-2026-10-23T08-26-02-339Z/stage1-sheet.csv` (blank template) | `689907f9681a27806f65cfae22dc1d32fd1ec65c281b75e1047c5792efb1a191` | 732 | 2026-10-23T08:28:09Z |
| `.work/metrics/investigator-eval-live-2026-10-23T08-26-02-339Z/SEAL-MANIFEST.txt` | `c77ca74266e0bf9e70d81dd7924a90092868c3d90b046640f521c0d230365d11` | 958 | 2026-10-23T08:28:51Z |

- **Match to the seal manifest:** the pack and template hashes above equal the values listed in `SEAL-MANIFEST.txt`.
- **Review-folder copies:** the copies placed in the B, C and D review folders (`C:\projects\ordertruth-stage1-codex-review\`, `…-codex2-review\`, `…-claude-review\`) are byte-identical to the live pack and template (same SHA-256). Their modification times are the copy times: 08:59:24Z, 09:26:13Z and 09:41:46Z.
- **Sheet A input:** not verified. The input ChatGPT received for Sheet A has no hash record.

## 4. Reviewer sheets

| Sheet | File | SHA-256 | Size | Modified (UTC) | Status |
|---|---|---|---|---|---|
| A | `E:\stage1_review_chatgpt.csv` | `056d2e94fee2c87b5270826222023fd0948d8ff66c173f478a092b72c74a6954` | 14301 | 2026-10-23T08:50:52Z | **EXCLUDED FROM ACTIVE ANALYSIS — RETAINED FOR AUDIT** |
| B | `C:\projects\ordertruth-stage1-codex-review\stage1-sheet-codex.csv` | `3d64511a9260ddf7892ba14f254af610a9cd9c9a2d013453dbffd571b31b0601` | 7581 | 2026-10-23T09:02:28Z | ACTIVE: one of the two AI reviewer sheets in the operator-designated pair (post hoc; not a preregistered human review) |
| C | `C:\projects\ordertruth-stage1-codex2-review\stage1-sheet-codex2.csv` | `d5ccc05b56f71e1deefb0f24bb471b73a2d139ede04566be6a77e33c32f77298` | 10392 | 2026-10-23T09:29:47Z | **REPEATABILITY CHECK ONLY — EXCLUDED FROM AGREEMENT ANALYSES** |
| D | `C:\projects\ordertruth-stage1-claude-review\stage1-sheet-claude.csv` | `4576c21881356f39baa1181538d2efe6bce300e7767d3ab6cfb95201752ae9d5` | 11169 | 2026-10-23T09:45:21Z | ACTIVE: one of the two AI reviewer sheets in the operator-designated pair (post hoc; not a preregistered human review) |

No Stage 1 sheet by either preregistered human reviewer (Prachi Agarwalla, Aniruddh Vijayvargia; preregistration line 291) is recorded here. Whether one exists outside the locations searched is not verified.

### 4.1 Sheet A: ChatGPT

**Provenance.**

| Item | Record |
|---|---|
| `reviewer` column | `ChatGPT` |
| Model / version | not verified. ChatGPT self-reported "GPT-6" [reported]. |
| Operator | not verified. Generated in the user's ChatGPT conversation [reported]. |
| Inputs actually supplied | not verified. Output-specific terms in Sheet A's notes occur in the live pack and not in the dry-run pack. That is consistent with scoring the live outputs, but does not prove ChatGPT had the byte-identical pack. |
| When created, scored or submitted | not verified. The file's modification time is 08:50:52Z [fs]. It was first shared with the coordinator at 09:01:50Z [session]. |

**Exposure.**
- ChatGPT disclosed that it had inspected a Stage 2 dry-run pack in the same conversation [reported; disclosure pasted to the coordinator at 09:05:33Z, session].
- It later stated that the pack was label-revealed and that the inspection happened before the completed sheet was returned [reported; 09:21:35Z, session].
- The operator states that ChatGPT "already had exposure to all the repo" [reported; 10:21:14Z, session].
- The dry-run and live Stage 1 packs cite the same evidence IDs, so the two runs appear to share cases. The coordinator did not open the dry-run Stage 2 pack.

**Exclusion.**
- **Decided by:** the operator (Prachi Agarwalla), at 2026-10-23T10:21:14Z [session].
- **Reason, quoted:** "i want codex and claude because chatgpt already had exposure to all the repo so i dont want it biased in any way thats i wanna remove all the results of chatgpt sheet as well".
- **Timing:** the decision was made **after** both the A/B and the D/B agreement results had been computed and seen (section 8).
- **Not preregistered.** This is a post-hoc exclusion on blinding grounds.

**Meaning of the status.** Sheet A's scores and the A/B agreement results are **excluded from active analysis, not erased from history**. The file is unchanged and retained for audit; the preregistration forbids discarding Stage 1 entries (line 289).

### 4.2 Sheet B: Codex

| Item | Record |
|---|---|
| Tool and model | OpenAI Codex CLI `0.157.1`; model `gpt-6-luna` (account default); reasoning effort high |
| Session | `01a167fc-c40f-7792-ad44-d6c520d03741` |
| Sandbox | `workspace-write`: writes were confined, but reads were **not** technically confined |
| Launched | 2026-10-23T08:59:38Z [session], in a folder containing only the live pack and template copies |
| Requested by the operator | 08:53:50Z [session] |
| Commands | The run log records 11 commands, all referencing only the pack, the template and the output sheet. |

- **Independence from Sheet A.** The brief was written before Sheet A was shared with the coordinator (09:01:50Z) and contains no Sheet A data.
- **Failed attempts.** Two earlier runs produced no sheet: run 1 was rejected because the model was unsupported, and run 2 could not find the files. Their logs are listed in section 6.

### 4.3 Sheet C: Codex, second account

| Item | Record |
|---|---|
| Tool and model | Codex CLI `0.157.1`; `gpt-6-luna`; reasoning effort high |
| Session | `01a16816-d25c-7342-85c1-2530c0b65bef` |
| Sandbox | `workspace-write`, with `-c windows.sandbox="elevated"` passed on the command line only |
| Launched | 09:28:06Z [session], after a failed read-only attempt (C1) |
| Brief | Same as Sheet B except for paths, output name and reviewer ID |
| Account | which account the second login belongs to: not verified |

Sheet C uses the same model and brief as Sheet B, so it is a repeatability check, not an independent reviewer.

### 4.4 Sheet D: Claude

| Item | Record |
|---|---|
| Tool and model | Claude Code CLI `2.1.308`; model `claude-opus-5-5`; effort high |
| Session | `d77a00e1-b378-4bbe-8df3-7ba687988c25` |
| Session settings | Fresh, non-interactive session with no access to the coordinator's conversation. Flags: `--restricted --tools Read,Write --strict-mcp-config --permission-mode acceptEdits --no-session-persistence --disable-slash-commands` |
| Launched | 09:41:54Z [session] |
| Requested by the operator | 09:40:35Z [session] |
| Tool calls | 5: Read pack, Read template, Read pack, Write sheet, Read sheet. All inside its own folder; no tool errors. |

- **Isolation.** The file tools were technically confined to the working folder.
- **Why a fresh session.** The coordinator had already seen Sheet A, so it could not score blind itself; it launched this separate session instead.

## 5. Agreement reports

| Report | SHA-256 | Size | Modified (UTC) | Status |
|---|---|---|---|---|
| `C:\projects\ordertruth-stage1-codex-review\stage1-agreement.txt` (Sheet A vs Sheet B) | `4c19d0a4a801baffaaaf82c1a5d48c69159bab5920ff4dc981c91843bbf72a51` | 4032 | 2026-10-23T09:03:43Z | **EXCLUDED FROM ACTIVE ANALYSIS — RETAINED FOR AUDIT** (it depends on Sheet A) |
| `C:\projects\ordertruth-stage1-claude-review\stage1-agreement-claude-vs-codexB.txt` (Sheet D vs Sheet B) | `f1e58bd089d477a75c4dfceff8e1f94339de2c832ba76be1dd2119b8b3e5c31a` | 4439 | 2026-10-23T09:47:38Z | ACTIVE, **exploratory and post hoc** |

The D/B pair was designated at 09:47:06Z [session], after the A/B results (computed at 09:03:42Z) and the Sheet A exposure disclosure had been seen, and before the D/B agreement was computed (09:47:37Z) [session]. D/B comparisons are therefore exploratory and post hoc. Neither report is evidence about which arm performs better.

## 6. Run evidence and analysis scripts

The files in `codex-run-evidence\` and `claude-run-evidence\` are **copies** made by the coordinator after each run. Their modification times are copy times.

| File | SHA-256 | Size |
|---|---|---|
| `C:\projects\ordertruth-stage1-codex-review\codex-run-evidence\codex-brief.md` | `7c82723113a99ed220ca21ce4ad136342db56163d1ffe31eda61105701e6c69e` | 3009 |
| `…\codex-run-evidence\codex-run3-log.txt` (Sheet B run) | `ccf61e086559f0b5f3c79305eddc992703807989e3239ec0c539b7b1b28cd4b4` | 182068 |
| `…\codex-run-evidence\codex-run3-final-message.md` | `86dbaffe7468fb200fe0e0ba4a86206231b1e463ffc39b1ab01cc751dcf1d59e` | 373 |
| `…\codex-run-evidence\codex-run2-failed-log.txt` | `04d212a9f2d817d4bb926d0a3e17ea5c63068363533a22efe10f61d6e3f293a4` | 6254 |
| `…\codex-run-evidence\codex-run1-failed-log.txt` | `62e3ea53faeb6089e997610473ec2674f77b1fc5edad26beacd0acaefa19a086` | 3598 |
| `…\codex-run-evidence\validate.py` | `dc6f7cf876d14d938639227dd07dc13794cdd662b482291d51941b76a9d7e14c` | 2036 |
| `…\codex-run-evidence\agreement.py` | `50e01d493fd5044ffb84944098ffca5cd2be027798a40dcd6f922df12b8a82dc` | 2764 |
| `C:\projects\ordertruth-stage1-codex2-review\codex-run-evidence\codex2-brief.md` | `992b6f60c33eb80f08f743009fc6ff36960c1178e4c152ae72a7f6d4a16fcab9` | 3017 |
| `…\codex-run-evidence\codex2-run-log.txt` (Sheet C run) | `09e25a6a8a86dce863f88cc5b081aadf1fbacbfac3fe74cd099b9076720b8d4f` | 167542 |
| `…\codex-run-evidence\codex2-final-message.md` | `23a25e87e67647d0a252ffb8389f3da4a562824a267b870f436c61d466363754` | 296 |
| `…\codex-run-evidence\codex2-failed-readonly-log.txt` | `454bf5e009b5afb36eb9798bc932d53e4dc6d2f610ff40c5180c4f0c4224f366` | 4256 |
| `C:\projects\ordertruth-stage1-claude-review\claude-run-evidence\claude-brief.md` | `c7ee310d5598e272352acd73d45ff4db8f0cd7b0300331694c1bd2fa5c15b1db` | 3025 |
| `…\claude-run-evidence\claude-run-stream.jsonl` (Sheet D session event log) | `a4aff0b0e6f6cdf8037a5d7df7b4feff84e77f749378d28487939e0f7c38f329` | 345667 |
| `…\claude-run-evidence\claude-run-audit.txt` | `e569eaa56916d1ac9a23564315e109f1de874863ca6c2f89a55ab7f94f5c29a2` | 3813 |
| `…\claude-run-evidence\audit_claude_stream.py` | `070a50626be058013f5cb8ebd4833430d93bb510bad09c9700df8ed6a8311990` | 2130 |
| `…\claude-run-evidence\agreement_claude_codexB.py` | `94791e69bacd93d5e2f742d793684ddf8eb4eb0c79b1df96105447138323ec4c` | 2852 |

## 7. Provenance documents and session records

| File | SHA-256 | Size | Modified (UTC) | Notes |
|---|---|---|---|---|
| `C:\projects\ordertruth-stage1-codex-review\STAGE1_PROVENANCE_AND_DEVIATION_NOTE.md` | `57b4ddde6f1bba17d0a07f85c2b7a2cc8da5f5229489dc3fc476baa8ea804d5c` | 44254 | 2026-10-23T10:22:42Z | Current provenance and deviation note. DRAFT, outside the repository, uncommitted. |
| `E:\STAGE1_PROVENANCE_AND_DEVIATION_NOTE_with_codex2.md` | `3a6d5b21d664c3259f73e6259d32526463386a7f03c0b704a7339831c05401e2` | 23763 | 2026-10-23T09:35:37Z | Superseded ChatGPT-drafted version. It contains Sheet A/B agreement figures; retained for audit, not authoritative. |
| `~\.claude\projects\C--projects-ordertruth\3c23ec90-3122-4615-81c3-6a74cf82840d.jsonl` | `92936e4b58b323e2ae471947aa671577ae957246e17be211588c68ca2ecc4a80` | 2924573 | 2026-10-23T09:53:51Z | The coordinator's first session transcript, the [session] source for events up to 09:47Z. It contains Sheet A's full contents. |
| `~\.claude\projects\C--projects-ordertruth\0137c7c4-a2b6-40dd-9373-461e262fe1bf.jsonl` | not recorded | | | The coordinator's current session transcript, the [session] source for events from 09:57Z. It was still being written when this log was created, so it has no stable hash. It contains Sheet A's full contents. |

## 8. Chronology (2026-10-23, UTC)

| Time | Event | Source |
|---|---|---|
| 08:08:54 | Revision 3 committed (`e72556e`) | [git] |
| 08:28:09 | Live Stage 1 pack and template written | [fs] |
| 08:28:51 | Live run sealed on `e72556e` | `SEAL-MANIFEST.txt`, [fs] |
| not verified | ChatGPT inspects a label-revealed Stage 2 dry-run pack, "before the completed sheet was returned" | [reported] |
| not verified | ChatGPT produces Sheet A | — |
| 08:50:52 | `E:\stage1_review_chatgpt.csv` last modified | [fs] |
| 08:53:50 | Operator asks for Codex as "the second reviewer from my side" | [session] |
| 08:54:56 | Codex run 1 launched (`gpt-6-astra`; rejected, no output) | [session] |
| between 08:54:56 and 08:59:38 | Codex run 2 (default model; could not find files, no output) | [session], log in section 6 |
| 08:59:38 | Codex run 3 launched (Sheet B) | [session] |
| 09:01:50 | Sheet A shared with the coordinator. Codex run 3 already running; Sheet A was never given to Codex. | [session] |
| 09:02:28 | Sheet B written | [fs] |
| 09:03:42–09:03:43 | A/B agreement computed and seen (`stage1-agreement.txt`) | [session], [fs] |
| 09:05:33 | ChatGPT's Stage 2 dry-run exposure disclosure pasted to the coordinator | [session]; disclosure [reported] |
| 09:06:05 | First coordinator hashing of Sheets A and B (not a committed log) | [session] |
| 09:21:35 | ChatGPT's statements pasted: exposure before return, pack label-revealed | [session]; content [reported] |
| 09:26:01 | Operator requests the second-account Codex review | [session] |
| 09:28:06 | Codex run C2 launched, after the failed read-only attempt C1 | [session] |
| 09:29:47 | Sheet C written | [fs] |
| 09:40:35 | Operator requests a Claude review instead of ChatGPT | [session] |
| 09:41:54 | Claude Sheet D session launched | [session] |
| 09:45:21 | Sheet D written | [fs] |
| 09:47:06 | Operator designates Sheets D and B as the reviewer pair | [session] |
| 09:47:37–09:47:38 | D/B agreement computed (`stage1-agreement-claude-vs-codexB.txt`) | [session], [fs] |
| 09:57:11 | Operator requests the A1 pack-instruction fix | [session] |
| 10:15:23 | A1 committed (`edd634e`) | [git] |
| 10:21:14 | Operator decides to exclude Sheet A and all its results | [session] |
| 10:22:42 | Provenance note updated to record the exclusion | [fs] |
| 10:39:17 | Hashes for this log computed | this log |

**Stage 2 status.** The coordinator has not opened any sealed file. No unsealed Stage 2 file exists in the live run folder. Whether anyone else has opened a sealed file is not verified (section 9).

## 9. Sealed artifacts: integrity only

At log time, all five sealed files matched `SEAL-MANIFEST.txt`, checked by hash only, without displaying content: `sealed/arm-key.json`, `sealed/consensus.csv`, `sealed/report.json`, `sealed/stage2-pack.md` and `sealed/stage2-sheet.csv`.

**Unchanged hashes show these files were not modified. They do not show the files were never read.**

The manifest says to open `stage2-pack.md` and `stage2-sheet.csv` only "after BOTH stage-1 sheets are submitted and hashed". Which two sheets count as "both" is not defined in any committed document yet; it is for the pending amendment.

## 10. Limitations and facts not verified

1. **Late log.** No evidence log existed before this one, and the earliest sheet hashes were recorded only in the coordinator's session and the draft note.
2. **Sheet A details.** Its model, operator, exact inputs, creation time, and the timing and full scope of ChatGPT's exposure are not verified. They are self-reported by ChatGPT or stated by the operator.
3. **Sealed files.** Whether any sealed file has been read is not verified; hashes prove only that the files are unchanged.
4. **Human reviews.** Whether any preregistered human Stage 1 sheet exists outside the searched locations is not verified.
5. **Codex isolation.** Sheets B and C were not technically confined for reads; their blindness rests on their command logs. Sheet D's reads were technically confined.
6. **Second Codex account.** Which account produced Sheet C is not verified.
7. **Session timestamps.** These come from local transcripts written by the coordinator's own tooling. They are not externally attested.
8. **No protocol decisions.** This log decides nothing about Option A or B or the reviewer amendment. Sheet A's exclusion and the D/B designation are operator decisions made after results were seen. They are not preregistered.
9. **Other copies of Sheet A.** Copies of Sheet A's contents also exist outside the files listed above: in both session transcripts, in the superseded `E:\` note (A/B figures), and presumably in the ChatGPT conversation. Deleting the listed files would not remove those copies.

## 11. Stage 2 continuation — 2026-10-24 (partial; no unblinding)

This section is additive. Sections 1–10 describe the historical checkpoint; their statements about an amendment pending at that time are not current execution instructions. A2 and this original evidence log were subsequently committed together in `09fbde56864b91ef9dce67a72bea5f9cd2fbaf5f`.

### 11.1 Preflight and opening

- **VERIFIED:** all seven artifact hashes in `SEAL-MANIFEST.txt` matched before Stage 2 preparation. Original Stage 1 Sheets B and D matched the A2.1 hashes. The evaluator's committed blob identities match the live freeze except the documented A1 changes (`blind.ts`, its original tests) and A1/A2 preregistration amendments. The decision/scoring/fixture/runner implementation remains unchanged.
- The permitted Stage 2 pack and blank sheet were opened for copying at **2026-10-24T12:08:27.748Z**. Their SHA-256 values are respectively `cb6bddb5b347db225c3d8aaf0457c3983efcd6b0231e07b41cd49c456336cd43` and `513c1e12e45b7ded0b8a875aa236e52f46e6847f878a02387b41a7fda0a9ee1c`, matching the original manifest.
- Copies and briefs were prepared in `.work/reviews/stage2-claude/` and `.work/reviews/stage2-codex/`. Each brief contains the P1, P1k, P4 and P5 definitions copied verbatim, requires retention of that reviewer's own unchanged Stage 1 sheet and keeps arms hidden. Original live artifacts were not rewritten.
- **Codex held by the user:** the current CLI reports a ChatGPT login, but the user answered **"No or unsure—hold the Codex review"** when asked whether it was the account used for Sheet B. No Codex Stage 2 session was launched. No substitute account/model is assumed.

### 11.2 Claude Stage 2 return

| Item | Recorded observation |
|---|---|
| Output | `.work/reviews/stage2-claude/stage2-sheet-claude.csv` |
| SHA-256 | `f40daa0ae886d6641247ffb79173e87b5b23294f94fa5bb5990111e3f6043994` |
| Reviewer | Fresh Claude Code session `f6e9cfb8-3c04-4cd4-83c9-d0d384df84b5` |
| Model | `claude-opus-5-5`, as recorded in initialization |
| CLI | `2.1.301`; this differs from Stage 1's `2.1.308`, and is not presented as the same binary |
| Invocation | Restricted, Read/Write only, strict MCP configuration, acceptEdits, no session persistence, slash commands disabled, effort high, maximum 16 turns, outer 15-minute deadline |
| Started / finished | `2026-10-24T12:13:59.740Z` / `2026-10-24T12:16:40.854Z` |
| Execution | Success, exit 0, seven turns |
| Structural validation | 48 case/output rows, 12 transition rows, expected identities, no missing rows, blank scoring fields or explicit UNRESOLVED values |

The user expressly approved sending the Stage 2 pack, blank sheet, Claude's own Stage 1 sheet and scoring instructions to Anthropic through the existing Pro login. The initial launch was rejected by automatic approval review before execution; the approved launch then ran once. No retry or replacement scoring was performed.

**Access evidence and limits.** Initialization exposed only Read and Write tools, with no MCP servers. The tool log records six calls: reads of the brief, template, own Stage 1 sheet and Stage 2 pack (twice), followed by a write of the new Stage 2 sheet. Every recorded file-tool path is inside the designated reviewer folder. Restricted mode confines file tools to working directories. Automatic startup context is not independently attested by this tool log; the folder is nested in the repository and the invocation did not explicitly disable `CLAUDE.md` discovery. Do not infer absence of all automatically supplied context from the permitted file-tool paths. The return is preserved unchanged; this limitation is recorded rather than silently replacing the review.

Local execution records: `.work/runs/ai-analysis-completion/{preparation.json,freeze-identity-check.json,claude-stage2-execution.json,claude-stage2-audit.json,claude-stage2-validation.json,claude-stage2-stream.jsonl}`. The stream is preserved locally; no credentials or root `.env` were intentionally supplied to the reviewer. Structural validation does not judge correctness or identify arms.

### 11.3 Current gate

**Stage 2 is incomplete.** Claude's return has been hashed; the required Codex return is held. The two-sheet commit gate has not been satisfied. A synthetic-only adapter and tests are being prepared outside the frozen evaluator directory; their presence is not an adapter commit or permission to unblind. `sealed/arm-key.json`, `sealed/report.json` and `sealed/consensus.csv` remain unopened by this coordinator, and no live decision result has been computed. Unknown prior access by other actors remains unverified.

**Adapter checkpoint (uncommitted).** `src/ai/reviewer-analysis/{adapter,cli}.ts` and `tests/reviewer-analysis.test.ts` implement synthetic-tested parsing, complete reviewer records, conservative unresolved handling and separate calls to the unchanged decision function. Focused tests passed 31/31; type checking passed. An independent read-only code reviewer found and then verified the correction of missing A2.2–A2.5 disclosures; no scoped code blocker remained. The full offline run initially recorded 695 passes and one legacy child-process timeout, that unchanged file passed 23/23 alone, and a full two-worker rerun passed **696/696 in 32 files**. All attempts are retained locally; no timeout/assertion was relaxed. This validates code against synthetic/local fixtures only, not the live reviewer decisions. The adapter commit gate is still pending, and the forward-only P3 fix remains deferred until the historical analysis is finalized.

## 12. Codex Stage 2 and pre-unblinding evidence — 2026-10-24

The user released the hold and explicitly approved the exact permitted materials being sent to OpenAI through the current ChatGPT login, with historical account identity remaining unverified. A3 records that prospective deviation and stronger session controls. The initial launch was rejected by automatic approval review before execution; after the user's specific consent, one review ran. No failed or inconvenient score was replaced.

| Item | Recorded observation |
|---|---|
| New thread | `01a16de3-e2c9-78d3-80df-e45bf6c93e1c` |
| Invocation | Codex CLI `0.157.1`; requested `gpt-6-luna`, high effort; no fallback configured |
| Account | Current ChatGPT CLI login; relation to original Sheet B account **UNVERIFIED** |
| Started / finished | `2026-10-24T12:30:12.088Z` / `2026-10-24T12:30:53.649Z` |
| Original return SHA-256 | `35820663a4292d9a9c81f9890035ee0bfdfe3b43f398bf25c2727bdfde38c9c0` |
| Original return | `docs/evidence/investigator-eval-stage2/codex-stage2-original.csv` (byte-identical preserved copy) |
| Derived CSV SHA-256 | `1abfb656537cf4a229f66e739564502ed0b45262a2713eba81c71e7eec736bcc` |
| Derived CSV | `docs/evidence/investigator-eval-stage2/codex-stage2-normalized.csv` |
| Structural result | 48 case/output rows and 12 transition rows; expected identities and no blank scoring fields |
| Usage reported by CLI | 45,725 input tokens, including 3,968 cached input tokens; 3,684 output tokens, including 2,831 reasoning output tokens. These are recorded CLI fields, not billing verification. |

**Blinding evidence.** The harness supplied only the scoring brief, blank Stage 2 template, own Stage 1 Sheet B and Stage 2 pack. The input hashes match the original manifest and Sheet B hash. A new session ran outside the repository, without `resume`/`fork`, with strict configuration, user-config/rules disabled, zero project-document bytes, memory use/generation disabled, web search disabled, shell tool disabled and ephemeral storage. The returned stream contains a new-thread event, one agent message and completion, with **zero recorded tool events**. No arm key, automated report, Claude sheet or coordinator conversation was supplied. The CLI stream does not independently attest the responding provider model identity; it records successful completion under the requested-model invocation. Cached-token counts do not establish previous-conversation exposure. Account identity, provider-side state and perfect blinding are not independently established; style-based arm inference remains possible.

**Formatting defect preserved.** The original return had an unquoted comma in transition `T2/P`'s final note (row 54 when blank lines are omitted). A derived copy rejoins that note and quotes it. The first four identity/scoring fields remain exactly the same values. The original return is untouched. `codex-csv-normalization.json` records the sole affected row and both hashes. The generic normalizer validates all fixed scoring/identity fields before accepting overflow and rejects missing columns or ambiguous invalid prefixes. Its behavior and the adapter's explicit P3 label-plus-explanation parsing were fixed and tested before unblinding; no live arm mapping or outcome was available during those corrections.

**Portable inputs.** The evidence directory also preserves byte-identical Stage 1 B/D sheets and the Claude Stage 2 sheet. `stage2-input-manifest.json` lists their hashes; `.gitattributes` preserves exact CSV/JSON bytes across platforms. `codex-review-audit.json` records invocation controls and event evidence without credentials. Neither account authentication files nor root `.env` were read.

**Gate at this checkpoint:** both Stage 2 returns now exist and are hashed. The Stage 2 evidence and tested adapter still require separate commits before opening the live arm key/report. `consensus.csv` remains unopened and unused. No four live decisions or final usefulness result has been computed yet.

## 13. A4 uncommitted checkpoint — 2026-10-25, before unblinding

The user declined the two local commits on 2026-10-24. On 2026-10-25 the user explicitly selected **"Approve A4 and continue uncommitted"** for the proposed replacement: a dated, verified SHA-256 snapshot instead of the two Git checkpoints. A4 was appended to the protocol before the arm key/report were opened. No staging, commit or push is authorized or performed.

The snapshot implementation received independent, read-only inspection with no remaining concrete blocker. Eight synthetic integrity/tamper/path checks passed; the current adapter's 35 synthetic tests passed. The prior full offline run remains 700/700. No assertion, case or decision threshold changed. The snapshot preserves protocol, adapter/tests/dependencies, both selected Stage 1 sheets, both original Stage 2 returns, the derived Codex CSV/audit, and validation records. The manifest hash will be published in the conversation and appended here before semantic unblinding. Source and preserved-copy hashes must verify before the analysis runs.

This replacement is a disclosed prospective protocol deviation, not a claim that the original two-commit condition was met. Timestamp and prior-access limitations remain. `consensus.csv` may be read as bytes for integrity hashing only; it remains unparsed and unused.
