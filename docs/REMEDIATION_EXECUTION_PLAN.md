# Remediation Execution Plan (Forensic Delta, No Mass Refactor)

Last updated: 2026-02-14  
Owner mode: single-owner stream (Lead Dev + DB + QA + Ops combined)

## Intent

Close all production-risk findings from the forensic report using surgical, reversible hotfix batches.  
Do not restart architecture work or repeat large-scale refactors during this stabilization window.

## Accelerated One-Day Plan (Today Only)

Target date: 2026-02-14  
Mode: emergency stabilization sprint (same-day ship criteria)

### End-of-Day Success Criteria

- Zero known P0 crash/safety regressions in local gates.
- Core flow validated manually in staging: `recruit -> points -> leaderboard -> promotion -> status`.
- Anti-nuke attribution and protection checks executed in staging test guild.
- Canary-ready artifact produced with rollback command prepared.

### Same-Day Execution Status (2026-02-14)

- [x] `recruiter.js` loader compatibility restored to prevent syntax/load failures in legacy tooling paths.
- [x] P0 regression automation in place (`npm run test:p0`) and green.
- [x] Dynamic anti-nuke rollback action typing fixed (`rapid_*`, `beast_mode`) with multi-shard integration coverage.
- [x] Analytics join/leave transaction wrapping completed; role-change path now buffered with adaptive queue batching.
- [x] Referential preflight auto-fix/check integrated (`npm run db:preflight`).
- [x] Retention hot-path optimization delivered (Set dedupe + memoized results).
- [x] Recruits index optimization delivered + `EXPLAIN` verification script (`npm run db:verify-indexes`).
- [x] Synthetic load safety gate added for analytics queue (`npm run test:synthetic:analytics`).

### Time-Boxed Execution (No Mass Refactor)

1. `Hour 0-1` - Baseline and unblockers
- Keep feature freeze in place.
- Close immediate syntax/load blockers (`recruiter.js` compatibility path).
- Run local gates:
- `npm test -- --runInBand`
- `node scripts/verify_commands.js`
- `npm run lint`

2. `Hour 1-3` - P0 hardening only
- Verify voice event crash containment and anti-nuke audit attribution behavior.
- Validate whitelist scope and emergency bypass behavior.
- Validate rookie point atomicity and cap logic regression tests.
- Apply only single-file/small-patch fixes with direct test coverage.

3. `Hour 3-6` - Manual staging chain validation
- Run anti-nuke safe simulations (channel/role delete in test guild).
- Run full recruit flow chain and capture DB row state after each step.
- Run scheduler once and verify no duplicate job execution.
- Capture logs with trace IDs for any failures.

4. `Hour 6-8` - Risk burn-down and release prep
- Fix only defects found in staging P0/P1 checks.
- Re-run local gates.
- Run migration dry-run and backup drill:
- `npm run migration:dry`
- `npm run backup:drill`

5. `Hour 8+` - Limited canary
- Deploy to staging soak (`>= 2h`) if possible today.
- If stable, deploy to 1-3 production canary guilds.
- Hold full rollout until canary metrics remain within thresholds.

### Explicit Deferrals (Not Today)

- Full DI migration from `runtime.js`.
- Anti-nuke module decomposition.
- Full event architecture split.
- Redis adoption and cross-service infra work.

## Hard Constraints

- No broad rewrites of `src/index.js`, `src/lib/antinuke.js`, or command trees during stabilization.
- No new infrastructure dependency (for example Redis) in this window unless a P0 cannot be closed without it.
- Max patch size target per PR: `<= 400` changed lines excluding tests/docs.
- Each PR must include:
- failing test or reproducible staging case
- fix
- rollback note (`git revert <commit>`)
- Commands required before merge:
- `npm test -- --runInBand`
- `node scripts/verify_commands.js`
- `npm run lint`

## Current Baseline (as of 2026-02-14)

- Existing tracking docs:
- `docs/MEGA_AUDIT_TRACKER_CODEX.md`
- `docs/STABILIZATION_STATUS.md`
- `docs/MEGA_AUDIT_TRACKER.md`
- Core gates currently available:
- tests (`jest`)
- command verification (`scripts/verify_commands.js`)
- lint (`eslint`)
- migration dry-run helper exists: `node scripts/migration-dry-run.js`
- backup drill helper exists: `node scripts/backup-restore-drill.js`

## Scope Split

- P0 (must close before full rollout): crash, data-loss, security bypass, shard correctness failures in core flows.
- P1 (close before freeze lift): performance and consistency risks that break expected behavior under load.
- P2/P3 (defer until after freeze): deep architecture cleanup and large module decomposition.

## P0/P1 Surgical Backlog

### P0-01 Voice Event Crash Containment

- Risk: unhandled error in `voiceStateUpdate` can crash shard.
- Files: `src/index.js`, `src/lib/analytics.js`.
- Patch shape: wrap high-risk listener body in a standard safe-event wrapper with consistent error logging and correlation ID.
- Validation:
- force-throw inside mocked analytics call and verify process remains alive
- ensure error is logged with event name + trace ID
- Rollback: revert event-wrapper commit.

### P0-02 Anti-Nuke Audit Attribution Hardening

- Risk: small audit fetch depth loses attacker attribution during noisy bursts.
- Files: `src/lib/antinuke.js`.
- Patch shape: increase fetch depth adaptively, filter by action target + timestamp window, add bounded retry with backoff on 429.
- Validation:
- simulated burst test where benign actions surround ban/kick
- verify attribution still resolves correctly
- Rollback: revert attribution patch only.

### P0-03 Anti-Nuke State Durability Across Restarts

- Risk: in-memory-only fragments make rollback and protection inconsistent after restart.
- Files: `src/lib/antinuke.js`, `src/lib/antinuke-rollback.js`, `src/db_async.js`.
- Patch shape: add minimal SQLite-backed persistence for critical anti-nuke state pointers and rollback metadata with TTL pruning.
- Validation:
- trigger action, restart process, verify status + rollback history still available
- run prune and verify capped size behavior
- Rollback: feature-flag fallback to current file backend.

### P0-04 Cross-Shard Invite/Session Blindness (Minimum Fix)

- Risk: shard-local maps cause invite attribution drift and inconsistent state.
- Files: `src/index.js`, `src/db_async.js`.
- Patch shape: keep map cache, add DB fallback read/write on miss for invite snapshot/session markers using short TTL tables.
- Validation:
- two-shard staging scenario with forced shard distribution
- verify attribution consistency between shards
- Rollback: disable DB fallback path with env flag.

### P0-05 Recruit Transaction Integrity

- Risk: partial Discord/API success leaves DB and guild state mismatched.
- Files: `src/commands/recruiting/recruit.js`, `src/lib/promote.js`, `src/lib/rookie-points.js`.
- Patch shape: formalize state transitions (`pending -> applied -> finalized`) with compensation on failure and explicit operator-visible error.
- Validation:
- inject nickname failure and verify DB state is not finalized incorrectly
- inject role update failure and verify compensation executes
- Rollback: revert transition-state commit.

### P1-01 Scheduler Single-Run Enforcement

- Risk: recurring jobs may double-run in multi-process/staged restarts.
- Files: `src/scheduler.js`, `src/db_async.js`.
- Patch shape: job lock row with owner + lease expiry, heartbeat extension, and stale lock takeover.
- Validation:
- start two bot instances in staging
- verify one active runner per scheduled job
- Rollback: revert lock enforcement commit.

### P1-02 Hot Path Rate-Limit Safety

- Risk: sequential member/channel loops trigger 429 and high latency.
- Files: `src/lib/member-fetch.js`, `src/lib/economy.js`, `src/lib/weekly-recalculations.js`.
- Patch shape: bounded concurrency + jittered retry policy, preserving order where output ordering matters.
- Validation:
- load test staging guild with mocked 429 responses
- verify retries and bounded in-flight count
- Rollback: revert bounded-concurrency helpers.

### P1-03 Analytics/DB Write Pressure Guard

- Risk: wide flushes and immediate writes contend on SQLite lock.
- Files: `src/lib/analytics.js`, `src/db_async.js`.
- Patch shape: tighten flush chunk size, add flush duration telemetry, cap pending queue growth with safe merge-back logic.
- Validation:
- stress write test with synthetic events
- verify no data loss on forced flush error
- Rollback: revert chunking/cap changes.

### P1-04 Permission/Hierarchy Fail-Close Consistency

- Risk: inconsistent permission failures across commands create unsafe behavior and operator confusion.
- Files: `src/lib/permissions.js`, `src/commands/*.js` (targeted high-risk admin commands only).
- Patch shape: central preflight permission helper for admin paths and consistent reply envelope.
- Validation:
- staged tests for missing perms, hierarchy inversion, bot-role below target role
- Rollback: revert helper adoption batch.

## Iteration Plan (21-Day Stabilization Window)

### Iteration 0 (Day 0-1): Freeze Enforcement and Backlog Lock

- Lock scope to P0/P1 only.
- Snapshot current failing/open items into triage board with owner + ETA.
- Confirm baseline pass:
- `npm test -- --runInBand`
- `node scripts/verify_commands.js`
- `npm run lint`
- Exit gate: no unclassified P0/P1 items.

### Iteration 1 (Day 2-4): Crash and Security P0 Block A

- Deliver `P0-01` and `P0-02`.
- Add regression tests for voice crash containment and audit attribution burst.
- Exit gate: shard no longer crashes on injected listener failures.

### Iteration 2 (Day 5-8): State Durability and Shard Correctness P0 Block B

- Deliver `P0-03` and `P0-04`.
- Add TTL prune + restart-resume coverage.
- Exit gate: restart and multi-shard staging checks pass.

### Iteration 3 (Day 9-12): Recruit/Promotion Data Integrity P0 Block C

- Deliver `P0-05`.
- Add failure-injection tests for partial Discord operation failures.
- Exit gate: no observed half-state in recruit/promotion staging runs.

### Iteration 4 (Day 13-16): Runtime Stability P1 Block A

- Deliver `P1-01` and `P1-02`.
- Validate scheduler single-run and retry behavior under synthetic stress.
- Exit gate: no duplicate jobs; bounded retries verified.

### Iteration 5 (Day 17-19): DB Pressure and Permission Consistency P1 Block B

- Deliver `P1-03` and `P1-04`.
- Validate DB lock behavior and permission-edge command responses.
- Exit gate: DB error rate and command failure variance reduced in staging.

### Iteration 6 (Day 20-21): Canary and Rollback Proof

- Run `node scripts/migration-dry-run.js` against production-copy DB.
- Run backup restore drill: `node scripts/backup-restore-drill.js`.
- Canary sequence:
- staging soak: `2 hours`
- limited production guilds: `24 hours`
- full rollout only if thresholds stay within limits.
- Exit gate: rollback drill passed and alerting configured.

## Staging Test Matrix (Must Pass Before Canary)

- Anti-nuke:
- role/channel delete simulation
- ban/kick burst attribution test
- rollback restore on prior action
- Recruiting chain:
- recruit -> points -> leaderboard -> promotion -> status
- forced failure at each step verifies compensation path
- Scheduler:
- start/end logs present
- duplicate-run prevention verified
- retry path verified on forced transient error
- Permissions:
- missing bot permissions
- hierarchy inversion
- admin/staff/non-staff command access checks

## Operational Metrics and Thresholds

- Command failure rate alert: `>1%` for `5m`.
- DB error rate alert: `>5/min` for `10m`.
- Anti-nuke unexpected trigger alert: any spike above daily baseline.
- Scheduler duplicate-run alert: any duplicate lock acquisition for same window.
- Event-loop lag warning (if instrumented): sustained `>250ms` for `5m`.

## Rollback Protocol

- App rollback: `git revert <commit>` and redeploy hotfix branch.
- Feature rollback: disable new path using env flag where introduced.
- DB rollback: restore snapshot from pre-deploy backup and validate with smoke queries.
- Incident rule: if P0 regresses in canary, stop rollout immediately and revert same day.

## Do-Not-Refactor-Now List (Explicit Deferral)

- Full DI/service locator replacement for `runtime.js`.
- Full event-folder rewrite and command loader redesign.
- Large anti-nuke modular decomposition.
- Wide schema redesign for all historical tables.
- Redis migration and distributed cache architecture.

## Definition of Done (Freeze Lift)

- All P0 closed and verified in staging + canary.
- P1 closed or formally accepted with dated mitigation.
- CI gates green on release commit:
- tests
- verify commands
- lint
- Migration dry-run + backup restore drill completed for release candidate.
- Docs updated:
- `docs/STABILIZATION_STATUS.md`
- `docs/MEGA_AUDIT_TRACKER_CODEX.md`
- `docs/postmortem_refactor.md`
