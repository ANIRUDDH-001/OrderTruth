# Bounded investigation v4 revision 2 — evaluator frozen before private holdouts

**G3 PENDING AUTHORIZATION; AI usefulness NOT TESTED.** No model/provider calls were made. Four replacement private holdouts are expected only through owner relay. This implementation has not searched for or read Claude's private cases or labels. `sealRelayedHoldouts()` accepts explicit in-memory owner-relayed input later; it performs no discovery, file reads or execution.

The eight previously exposed synthetic cases are now **development smoke fixtures**, not private evaluation evidence. Historical v2/v3 freeze JSON remains unchanged. Exact pre-v4 source/tests/protocol/artifacts were copied with verified hashes to `.work/runs/g2-g3-v4-20261105/before-g3/`. Do not alter the original root freeze or older review bundle.

## Evaluator freeze and information boundary

`pilot-freeze-v4-r2.json` stores the current major-version-4 scaffold freeze with `scaffoldRevision:2`. It seals the prompt/context, schema, scoring policy, baseline implementation, independent regressions, actual-JavaScript test runner, source/test/protocol hashes and exposed smoke source/prompt hashes. `evaluatorDigest` seals evaluator code before private holdout incorporation; `freezeDigest` also includes development smoke metadata. A drift test checks the exact artifact. Generated freeze JSON is excluded from its own hash to avoid circularity.

Revision 2 corrects a source-reviewed schema gap: expected labels can now genuinely be `ABSTAIN`, including in sealed owner-relayed batches and typed scoring input. An inline ambiguous local smoke snippet verifies accepted abstention with no patch; abstention still cannot be combined with mechanism labels or edits. No private cases were read for this correction. The earlier announced evaluator digest `ec454607e36fdeb1e98d5f936c708166dd6cf6cc1e877505bd5c3192e72922f2` and scaffold digest `ef430f1ef458250c3d479c447a6b83d161649b93658fbe0092befbab55ee9af0` are superseded before any private holdout incorporation. Exact revision-1 source/tests/protocol/freeze bytes are archived with hashes under `.work/runs/g2-g3-v4-20261105/v4-r1-before-abstain/`; `pilot-freeze-v4.json` remains unchanged as historical evidence. The actual-JavaScript harness is unchanged.

Four future private cases must be separately frozen with the existing evaluator digest, their source/prompt hashes and independently supplied acceptable-label sets before model outputs. This creates a separate holdout digest without changing evaluator sources. A code/evaluator change requires a new version and preserved history. No private holdout is incorporated into this scaffold freeze; status remains `PENDING_OWNER_RELAY`.

Model-visible common context states only the outcome objective and evidence limits. It does not describe defect mechanisms, reveal particular keys, assert helper atomicity, prescribe a fix or supply the identity answer. Output identity is bounded free text, not a fixed literal. Case IDs/categories/labels/paths/partition names are omitted from prompts. Source excerpts themselves remain evidence, not instructions.

## General detector and repair comparator

`baseline.ts` uses bounded lexical tokens and local lookup/write dataflow heuristics. It has no fixture/hash/category imports or exact-source lookup. It recognizes renamed/reformatted lookup/write calls and path/intent key expressions. It abstains on clean near-misses, synchronous check/write sequences, transaction-wrapped uncertain code and omitted helpers whose names alone do not establish safety.

The installed TypeScript 7 package's default export exposes version metadata rather than the prior compiler API. No dependency was added. This detector is **not an AST analyzer or complete JavaScript/TypeScript parser**. It checks comments/strings/delimiter balance and a limited function/call subset. Unsupported templates/regular expressions/complex syntax yield `UNSCORABLE`; lexical or subset parse failures produce explicit rows. A lexical match is a conditional diagnosis, not proof of database/provider behavior. Renaming beyond supported API families, aliases, complex scopes and omitted isolation semantics can defeat the rules.

The repair comparator proposes a concrete edit only for its supported smoke adapter signature. That adapter's `createOrderOnce` is implemented and tested; this is not a claim that an unseen merchant has that API. Unsupported application repairs receive no automatic execution or repair-success credit. Private-case comparators must use only the same supplied information; missing adapter contracts make repair qualification unscorable rather than justification for inventing a dependency. Semantic minimality and explanation/identity correctness require independent review.

## Scoring and all-attempt accounting

Responses may list multiple defensible mechanisms. Independently sealed acceptable-label sets allow, for example, both race and cross-path defects or race and identity errors. Clean and abstention labels must stand alone and carry no edits. Abstention is counted separately from accepted substantive diagnoses; the three exposed helper-only smoke cases receive abstention rather than an unsupported clean certification.

`score()` returns a retained row for invalid JSON/schema, oversized output, unknown citations, parser failures and unscorable edits. `scoreBatch()` retains missing/time-out slots and extra unassigned responses. These stay in the attempt denominator; no failed response is discarded or silently retried. Schema-valid source line references do not prove an explanation or identity correct.

Edits are inert text. Unique exact replacements work; whole-excerpt token-equivalent formatting replacements work. Other formatting or ambiguous matches return `UNSCORABLE` instead of failing a valid diagnosis or silently choosing a location. A formatting-equivalent proposed program can still lack the **exact** reviewed execution SHA and remains unexecuted until reviewed. Clean patches count as false positives. Changed-line counts are a budget check, not semantic minimality. Model-generated test correctness remains `NOT_TESTED`.

## Two separate execution evidence classes

1. **Interpreter checks:** `interpreter.ts` recognizes a finite fixture grammar and simulates the defined storage semantics. `runReviewedRegressions()` asserts sequential/overlap/replay/distinct-purchase/identity/merchant/rollback/retry behavior. These are in-memory interpreter checks, not actual execution of the proposed JavaScript and not PostgreSQL or concurrent-process validation.
2. **Actual reviewed JavaScript smoke:** `actual-smoke.ts` is test-only (`NODE_ENV=test`) and admits only exact SHA values of shipped engineer-reviewed synthetic programs. A caller/model cannot authorize arbitrary source by supplying its own matching hash. A separate child also checks the same hardcoded shipped whitelist, then executes the actual pinned JavaScript functions against an implemented in-memory adapter and seven independent assertions. Tests cover four distinct shipped source hashes, including repaired code and clean controls. The other four case proposals share those source hashes.

The actual-code child has a 64 MiB heap cap, 3-second process deadline, 100 ms script initialization deadline, bounded stdin/stdout, stripped environment containing only `NODE_ENV`, no native addons or prototype mutation, and Node permissions allowing filesystem read only of the fixed runner script. The reviewed source has no imports, filesystem, process or network operations. Arbitrary/model source and merely reformatted unreviewed source are refused. **Node VM alone is not a security boundary; OS network isolation is not claimed.** Safety relies on the fixed executable/script plus exact reviewed source whitelist, a restricted child, unavailable application capabilities and bounded execution. This is not a hostile-code execution service. Future arbitrary model patches remain outside this runner.

Actual smoke does not establish database atomicity, distributed locking, crash durability, webhook authenticity or production behavior. The CLI's `--verify-reviewed-baseline` reports interpreter checks only. It never runs actual-code tests. `--baseline` and `--freeze` are inert reports. All actual code execution is confined to the focused test file. No model text is automatically installed, imported or executed.

## Commands and status

```powershell
pnpm exec vitest run tests/code-investigation.test.ts tests/code-investigation-regression.test.ts tests/code-investigation-actual.test.ts
pnpm typecheck
node --experimental-strip-types src/ai/code-investigation/main.ts --freeze
node --experimental-strip-types src/ai/code-investigation/main.ts --baseline
node --experimental-strip-types src/ai/code-investigation/main.ts --verify-reviewed-baseline
```

Retain command exits, exact source/freeze hashes and raw outputs in a new run directory. Node 24.11.0 host smoke evidence must be distinguished from the declared Node 22 profile; root qualification reports that separately. An early attempted compiler-API approach failed because TypeScript 7 no longer exports those APIs; the implementation now uses its own bounded lexical subset and adds no parser dependency.

Private holdout evaluation, model usefulness, independent security/minimality review and arbitrary real-application patch regressions remain **NOT TESTED**. Nothing in these exposed smoke results qualifies G3 as passed.

## Proposed pilot boundary

Provider **UNSPECIFIED**; owner approval required. Maximum **8 total calls including primary/repair/retry attempts**, one call per frozen case, **no automatic retries**, **₹0 absolute maximum**, 30-second response deadline, 12,000-byte prompt and 10,000-byte output ceilings. The four private cases are pending; any other pilot slots require a separately frozen corpus and explicit allocation. No transport/provider code is included. A timeout or invalid answer consumes its slot. No paid fallback, billing activation or provider switch is authorized.

Use only owner-approved synthetic code, no secrets/customer data. Compare every attempted answer against the frozen detector and repair comparator with independently reviewed source-bound evidence. Record ties honestly. If the pilot adds no useful safe capability, stop expansion and preserve scoped V2 investigation. No Ask/W2/W3, UX/release work, hosting or submission is included.
