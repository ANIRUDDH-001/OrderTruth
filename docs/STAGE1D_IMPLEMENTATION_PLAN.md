# Stage 1D implementation plan

Status: authorized by product owner 2026-10-19; spec: STAGE1C_REPAIR_CONTRACT.md plus Stage 1D authorization.
Goal: approved local-only duplicate merchant repair, preserving historical and provider facts.
Architecture: existing TypeScript/node:sqlite modular monolith, no dependency changes. Immutable execution identity, append-only EXECUTING transition and unique terminal outcome. BEGIN IMMEDIATE serializes writers. SAVEPOINT correction rolls back only corrections on failure; terminal refusal commits in the same outer transaction. Crash before commit rolls everything back; retry revalidates. No A-rollback/B audit gap.

Constraints: no Git writes; no .env reads; no provider clients/network; original .work/ordertruth.sqlite never opened/migrated; CLI requires explicit isolated DB path and rejects original path/aliases; 15 minute expiry; same declared requester/approver permitted; no authenticated identity claim; no HTTP mutations; stop before human demonstration.

Review focus: timestamp ties select keeper by created_at/id; existing legacy mismatches fail closed; approval invalidated by any new relevant fact; crash after void/before commit leaves no partial result; concurrent different plans cannot resolve twice.

- [ ] Task 1: tests first for effective status and migration 6 constraints, then src/db/repair-schema.ts, Store migration import, repo effective reads, checker contract mapping and multi-injection provenance. Run targeted tests RED then GREEN.
- [ ] Task 2: tests RP1-RP9/RP11 first; src/merchant/repair.ts planner/facts/canonical hashes, approval storage, executor and history. Interfaces: plan(org, incident, requester), approve(planId, hash, operator, confirmation), execute(planId), history(org, incident). All writes transactions; executor constructor binds org; execute accepts only plan ID. Run targeted RED/GREEN.
- [ ] Task 3: CLI src/merchant/repair-cli.ts (explicit isolated path; TTY, exact hash and typed suffix; never auto execute), read-only incident history/effective state. Tests RP8/RP12 and interactive vs simulated approval.
- [ ] Task 4: process tests RP2/RP10 concurrent SQLite writers and crash/restart boundaries, network/client guards, adversarial RP13 mutations. Run full suite, typecheck, web build. Fresh reviewer checks working diff; fixes with regressions.
- [ ] Task 5: create healthy/fault isolated copies with existing offline demo, create UNAPPROVED plan on fault copy, record source hash unchanged. Document evidence/limitations in STAGE1D_RESULTS.md and ledger. Stop for independent review; no actual approval or demo execution.

No commits in this plan; user authorization required separately. Persistent working notes use .work/ledger.md.
