# Remediation Execution Plan (Now)

Last updated: 2026-02-13
Owner mode: single-owner execution (Lead Dev + DB + QA + Ops handled in one stream)

## Baseline

- Stabilization checklist: `49/59` complete (`83%`) from `docs/STABILIZATION_STATUS.md`.
- Tracker resolved/improved items: `54` from `docs/MEGA_AUDIT_TRACKER_CODEX.md`.
- Current gate status:
  - `npm test -- --runInBand`: pass (`29/29` suites, `67/67` tests).
  - `node scripts/verify_commands.js`: pass (`26` commands loaded).

## Completion Targets

- P0 complete: no security/data-loss paths open.
- P1 complete: core flow stable under load (`recruit -> points -> leaderboard -> promotion -> status`).
- Deployment-safe: migration dry-run, canary, rollback drill documented and tested.
- Documentation and tests updated for each critical fix.

## Phase Plan (Execution Order)

## Phase 0 - Freeze and Safety (kept active)

- Keep hotfix-only scope until P0/P1 backlog is cleared.
- Keep CI gates mandatory before merge:
  - tests
  - command verification
- Keep verbose error logging enabled in staging/canary.

Exit criteria:
- No merge bypasses and no red CI deploys.

## Phase 1 - Triage Board Finalization

- Convert remaining audit findings into actionable tickets with:
  - reproducible steps
  - expected vs actual
  - severity (`P0/P1/P2/P3`)
  - target file(s)
- Group tickets into execution buckets:
  - anti-nuke security
  - recruiting data integrity
  - performance/scalability
  - migration/schema safety
  - shard/deploy safety

Exit criteria:
- Every P0/P1 has an owner and an acceptance test.

## Phase 2A - Security and Data-Loss P0 (first implementation block)

Scope:
- `src/lib/antinuke.js`
- `src/commands/emergency_recover.js`
- `src/lib/antinuke-rollback.js`
- `src/index.js`

Tasks:
- Lock recovery semantics so overwrite restoration never leaves channels in unsafe state on partial failures.
- Finalize whitelist bypass semantics (`emergencyForceProtect`) and cover with tests.
- Expand audit handling coverage for ban/kick flows where currently skipped.
- Remove remaining fail-open/silent catches on critical enforcement paths.
- Ensure shutdown path persists anti-nuke state and closes DB safely.

Exit criteria:
- Anti-nuke integration tests pass with explicit recovery/whitelist/audit scenarios.

## Phase 2B - Recruiting Integrity P0

Scope:
- `src/lib/rookie-points.js`
- `src/services/recruiting/ledger-service.js`
- recruiting services/commands that still write points directly

Tasks:
- Finish migration to ledger-only recruiter point mutation path.
- Remove or gate all direct `UPDATE recruiters SET points` writes outside ledger path.
- Ensure multi-step flows are transactional where possible:
  - recruit
  - revoke
  - buy
  - member leave deductions
- Ensure promotion side effects are consistent on failures (no silent half-state).

Exit criteria:
- Ledger verification tests pass and no direct point writes remain in command handlers.

## Phase 2C - Runtime and Performance P1

Scope:
- `src/scheduler.js`
- `src/lib/weekly-recalculations.js`
- `src/services/recruiting/recruitment-report-service.js`
- `src/lib/analytics.js`
- `src/lib/i18n.js`

Tasks:
- Replace remaining sequential loops with bounded concurrency.
- Ensure weekly DM/report operations handle rate limits and timeouts predictably.
- Continue reducing analytics write pressure and lock contention.
- Finish i18n hot-path optimization to avoid blocking file IO in request paths.
- Add cache pruning for known leak maps.

Exit criteria:
- No known O(N) blocking hot paths in scheduled/core command flows.

## Phase 3 - Migration and Deploy Hardening

Scope:
- `src/db_async.js`
- migration helpers/scripts
- CI/deploy scripts

Tasks:
- Add/validate schema version tracking and migration state guarantees.
- Ensure view recreation is always enforced post-migration.
- Require migration dry-run as a predeploy check.
- Validate canary and rollback checklist in docs and scriptable flow.

Exit criteria:
- Migration dry-run and rollback drill reproducible from docs/scripts.

## Phase 4 - Cleanup, Docs, and Test Expansion

Tasks:
- Complete module splits where files remain oversized or over-coupled.
- Add integration tests for end-to-end recruiting + anti-nuke scenarios.
- Update:
  - `docs/STABILIZATION_STATUS.md`
  - `docs/MEGA_AUDIT_TRACKER_CODEX.md`
  - `docs/postmortem_refactor.md`

Exit criteria:
- P0/P1 backlog closed, tracker updated, and stabilization freeze can be lifted.

## Execution Cadence

- Daily:
  - implement one bounded batch
  - run tests + verify commands
  - update `% complete` in status docs
- Per batch:
  - small PR-sized diff
  - explicit rollback notes
  - acceptance evidence attached

## Progress Reporting Model

- Overall completion: tracker-weighted across P0/P1/P2.
- Security/data-loss completion: weighted only on Phase 2A and critical subset of 2B.
- Report format per update:
  - `% done`
  - what landed
  - what is next
  - blockers/risk
