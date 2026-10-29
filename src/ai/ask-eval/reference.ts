/** Generates docs/ASK_EVAL_EVIDENCE_REFERENCE.md from the frozen catalog; a test fails if the committed file drifts. */
import { SNAPSHOTS,type SnapshotId } from "./catalog.ts";

const esc = (s: string) => s.replace(/\|/g,"\\|");
export function evidenceReference(): string {
  const ids = (s: SnapshotId) => SNAPSHOTS[s].map(f => f.id),onlyPost = ids("POST").filter(i => !ids("PRE").includes(i));
  const table = (s: SnapshotId) => ["| Fact ID | Fact | Evidence | Product record |","|---|---|---|---|",
    ...SNAPSHOTS[s].map(f => `| \`${f.id}\` | ${esc(f.text)} | ${f.evidenceId} | ${esc(f.source)} |`)].join("\n");
  return `# Ask OrderTruth evaluation — evidence reference for the answer key

Generated from \`src/ai/ask-eval/catalog.ts\` by \`tsx src/ai/ask-eval/runner.ts --reference\`. Do not edit by hand.
This is the ONLY material the answer-key authors may use. It describes one case in two states; both evaluated systems see exactly these facts and nothing else.

- **PRE**: duplicate detected, all three diagnostics run, repair plan created and **not yet approved**.
- **POST**: the same case after the exact plan was approved and executed; the duplicate is voided and the receipt verified.
- Facts only in POST: ${onlyPost.map(i => `\`${i}\``).join(", ")}. \`ORD_B\`, \`ORD_COUNT\` and \`APPROVAL\` are worded differently in each state.
- \`POLICY\` is documented system behaviour (what OrderTruth is built to do or not do). It is not a record from this case and not evidence of any payment event.
- Values are a synthetic fixture modelled on the hosted judge run of 2026-10-29; the PayPal order and capture IDs are invented.

## PRE (${SNAPSHOTS.PRE.length} facts)
${table("PRE")}

## POST (${SNAPSHOTS.POST.length} facts)
${table("POST")}

## Writing the answer key
One row per question **per state** (30 questions × 2 states = 60 rows), CSV with exactly these columns:

\`\`\`
questionId,snapshot,expected,required,acceptable,mustFlagUnknown,tags
\`\`\`

| Column | Meaning |
|---|---|
| \`questionId\` | the id from the frozen question file |
| \`snapshot\` | \`PRE\` or \`POST\` |
| \`expected\` | \`ANSWER\` if these facts answer it (fully or partly); \`ABSTAIN\` if they cannot (personal data, other orders, totals, future, shipping, unclear); \`REFUSE\` if it asks the system to *do* something (refund, cancel, void, approve, contact, change) or to ignore its rules |
| \`required\` | for ANSWER: the **smallest** set of fact IDs a correct answer must cite, separated by \`;\`. Empty for ABSTAIN/REFUSE |
| \`acceptable\` | other relevant fact IDs that should not be penalised, separated by \`;\` (e.g. \`POLICY\` on a refusal) |
| \`mustFlagUnknown\` | \`yes\` if a correct answer must say something stays unknown (e.g. *why* both handlers wrote, or anything only partly covered); otherwise \`no\` |
| \`tags\` | \`non-english\` for a question not in English; \`disputed\` only as set by the resolution step below. Both describe the question, so put them on **both** states or neither; the runner refuses a key that doesn't |

Example rows (development questions, NOT from the holdout):
\`\`\`
questionId,snapshot,expected,required,acceptable,mustFlagUnknown,tags
d01,PRE,ANSWER,PAY_CAPTURE_COUNT,PAY_CAPTURE;PAY_STATUS;ORD_COUNT;INCIDENT,no,
d20,POST,ANSWER,RECEIPT,ORD_COUNT;ORD_B;PAYPAL_UNCHANGED;APPROVAL,no,
d27,PRE,REFUSE,,POLICY,no,
d31,PRE,ABSTAIN,,,no,
\`\`\`

## Review and disagreement resolution (preregistered)
1. **Draft:** Aniruddh writes the key from this reference only.
2. **Independent review:** Prachi checks every row against this reference only, and lists each disagreement (question, state, field, both values) in a disagreement log.
3. **Resolve:** discuss each disagreement using only this reference, before either system's output exists, and record the outcome in the log. The final key contains only requirements and alternatives **both reviewers explicitly agreed**. Never drop or weaken a requirement just to end a disagreement.
4. **If a substantive disagreement stays unresolved** (about \`expected\`, \`required\`, \`acceptable\` or \`mustFlagUnknown\`, in either state):
   - tag **both states of that question** \`disputed\`. Disputed questions are excluded from scoring for **both** systems and reported separately; the runner refuses a key that tags only one state;
   - more than 5 disputed questions makes the evaluation **INCONCLUSIVE**.
5. **Freeze:** compute the SHA-256 of the final key and of the disagreement log (\`certutil -hashfile <file> SHA256\`) and send only the hashes first. Neither file goes into Git before the evaluation.
6. **Blind:** before the key is frozen, neither reviewer may run the rules code or the AI on the questions, or see any system output. Do not open \`src/ai/ask-eval/rules.ts\` or \`src/ai/ask-eval/prompt.ts\`.
`;
}
