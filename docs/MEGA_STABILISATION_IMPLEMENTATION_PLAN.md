# Post-Refactor Stabilisation Implementation Plan

## Purpose

This document converts the verified findings in `docs/MEGA_AUDIT_TRACKER_CODEX.md` into an execution plan. The goal is to stabilise the bot in small, reversible steps, then run a deep regression audit after the fixes land.

## Success Criteria

- Core production flows are stable: recruit -> points -> leaderboard -> promotion -> status.
- No open P0 or P1 regressions remain in DM, recruit, scheduler, or DB write paths.
- DB schema and migrations are safe to run on a production snapshot.
- Monitoring, rollback, and canary checks exist for risky areas.
- A post-fix regression audit completes with clear sign-off criteria.

## Current Status

Local engineering execution status on 2026-04-02:

- Phase 0 completed locally
- Phase 1 completed locally
- Phase 2 completed locally
- Phase 3 completed locally
- Phase 4 completed locally
- Phase 5 remains pending because staging/canary rollout and live monitoring are outside this workspace

Post-fix audit record: `docs/POSTFIX_REGRESSION_AUDIT_2026-04-02.md`

## Operating Rules

- Freeze feature work until Phases 1 and 2 complete.
- Use small PRs or hotfix commits. Do not combine unrelated workstreams.
- Every code change must have a rollback path and targeted validation.
- Do not deploy schema changes without a production DB snapshot and dry run.
- Do not mark a phase complete on test pass alone; require staging flow checks.

## Rollback Coordination Rules

Not every rollback can be done as a single isolated revert. Some workstreams affect shared runtime state, DB shape, or in-flight jobs. Use these rules during rollout and rollback:

- Deploy in dependency order and roll back in reverse dependency order.
- Treat DB schema changes as the lowest rollback granularity. Application code must be able to run against both the previous schema and the additive schema during the transition window.
- Do not revert queue-processing or scheduler code while incompatible in-flight data still exists, unless a drain or stop procedure runs first.
- If a workstream changes both write behavior and read behavior, deploy read compatibility first, then write-path changes, then cleanup.
- If a rollback spans code plus data shape, revert code first, then data migration only if the restore path was already tested.

### Rollback Dependency Order

1. Phase 3 observability and lint cleanup are independently reversible.
2. Phase 2 leaderboard and promotion verification changes can usually roll back independently if they do not depend on new schema.
3. Phase 2 recruit-flow consolidation depends on any compatibility adapter still being present.
4. Phase 1 scheduler re-entry protections should roll back before DB or queue contract changes if they depend on new job state.
5. Phase 1 DM worker changes should roll back before DM campaign creation changes if worker logic expects a new queue contract.
6. Phase 2 DB integrity and migration changes are last to roll back and only after application code is back on the prior compatible path.

### Partial Rollback Procedure

If one workstream fails after adjacent workstreams have already landed:

1. Stop or drain affected background processing first:
   - DM workers
   - scheduler jobs
   - startup reconciliation on next restart
2. Disable or revert the newest consumer of the changed state.
3. Revert upstream producers only after consumers are back on the previous contract.
4. Inspect in-flight records before restart:
   - queued DM campaigns
   - retrying DM targets
   - partially processed recruit records
   - scheduler lease or run-state markers
5. Restore DB snapshot only when the failure affects schema or durable data integrity, not just code behavior.

## Transition Compatibility Rules

During the stabilisation window, major logic replacements must support in-flight operations created by the previous implementation. Do not remove compatibility shims until the post-fix regression audit confirms the system is stable.

- Use additive migrations first, destructive cleanup last.
- Prefer compatibility adapters over wide flag-day rewrites.
- Keep old record formats readable for at least one full deploy cycle.
- Add explicit status normalization when old and new state values may coexist.
- For long-running or queued work, define a drain strategy before switching write paths.

### Compatibility Requirements by Area

- DM campaigns:
  - new worker logic must continue to process campaigns queued by the previous implementation
  - cancellation must understand both old and new retry/queue states during rollout
- Recruit flow:
  - the new authoritative path must accept records created by the old path
  - command-layer adapters should remain until leaderboard, points, and promotion flows are verified end-to-end
- Scheduler jobs:
  - startup and recurring jobs must tolerate a job already being mid-cycle when code changes deploy
  - overlap guards should be compatible with preexisting run markers or lack thereof
- DB schema:
  - schema changes should be additive before constraints become strict
  - code should read both old and new shapes until the transition window closes

## Inputs

- Verified audit findings: `docs/MEGA_AUDIT_TRACKER_CODEX.md`
- Existing stabilization checklist: `AGENTS.md`
- Runtime verification commands:
  - `npm test -- --runInBand`
  - `node scripts/verify_commands.js`
  - `npx jest --runInBand --detectOpenHandles`

## Execution Order

1. Establish a frozen baseline and collect evidence.
2. Fix the highest-risk runtime defects in DM and scheduler paths.
3. Collapse recruit logic and harden DB integrity.
4. Tighten config, observability, and hidden-state boundaries.
5. Run a deep regression audit after the fixes.
6. Canary, monitor, then roll forward or revert.

## Phase 0 - Baseline, Freeze, and Safety Rails

### Objectives

- Freeze changes outside stabilization work.
- Capture the current baseline before touching runtime paths.
- Create rollback assets and a triage board.

### Actions

- Create `hotfix/stabilise` from the current deploy target.
- Tag the current production commit as the rollback anchor.
- Take a DB snapshot of the production database before any migration or schema work.
- Collect current artifacts:
  - `error.log`
  - `failures.txt`
  - `final_test_results.txt`
  - `jest_failures.txt`
  - `verify_output.txt`
- Run the baseline verification commands and save outputs in `docs/` or an issue tracker.
- Record open findings as P0, P1, P2 using the audit doc finding numbers.

### Exit Criteria

- Freeze is agreed.
- Baseline test results are saved.
- Rollback anchor commit and DB snapshot both exist.

## Phase 1 - Runtime Safety Hotfixes

### Workstream 1: DM Campaign Atomicity and Queue Safety

### Why

Audit findings 16 and 22 show real race and cancellation gaps in the DM campaign path.

### Scope

- `src/services/dm/dm-campaign-service.js`
- `src/services/dm/dm-worker.js`
- `src/services/dm/dm-worker-selector.js`
- related DM tests

### Changes

- Make campaign creation atomic.
- Replace check-then-insert flows with a transaction or a schema-backed uniqueness guard.
- Ensure queued targets cannot be created twice under concurrent calls.
- Expand cancellation logic so it also sweeps retry states, not only queued ones.
- Confirm worker selection and fallback logic remain deterministic under retries.
- Add a compatibility read path so existing queued campaigns and retry rows created by the old implementation are still processable after deployment.

### Validation

- Add concurrent tests for repeated `/dm create` or equivalent service entry points.
- Add cancellation tests covering `queued`, `sending`, `retry_wait`, and partial failure states.
- Re-run:
  - `npm test -- --runInBand`
  - `node scripts/verify_commands.js`
  - targeted DM tests with `--runInBand --detectOpenHandles`

### Rollback

- Revert the DM hotfix commit set only.
- Restore the pre-change campaign behavior if queue corruption appears in staging.
- Before rollback, stop or drain workers and inspect in-flight campaign rows so an older worker does not resume incompatible state.

### Workstream 2: DM Worker Correctness and Re-entry Defects

### Why

Audit finding 3 identified real defects in `dm-worker.js`, not just style issues.

### Scope

- `src/services/dm/dm-worker.js`
- worker selector helpers
- worker tests

### Changes

- Remove unreachable or invalid code paths.
- Replace silent catches with structured error handling or explicit no-op comments where suppression is intentional.
- Verify per-worker state transitions are valid under repeated polling.
- Confirm no worker path can process the same target twice in one cycle.
- Preserve compatibility with campaign rows created before the worker fix so a restart does not strand old queue items.

### Validation

- Re-run worker-focused tests.
- Add at least one duplicate-processing guard test.
- Run a staging DM batch with mixed success and failure cases.

### Rollback

- Revert only the worker hotfix if polling or queue throughput regresses.
- Roll back the worker before rolling back campaign-creation changes if the two updates ship together.

### Workstream 3: Startup Double-Run and Scheduler Re-entry Guards

### Why

Audit findings 2, 7, and 10 show repeated startup work and scheduler drift.

### Scope

- `src/index.js`
- `src/scheduler.js`
- `src/lib/weekly-recalculations.js`
- scheduler tests

### Changes

- Remove duplicate startup reconciliation.
- Add explicit overlap guards where recurring jobs can re-enter.
- Make job start, finish, skip, and retry states visible in logs.
- Verify job order dependencies are explicit rather than incidental.
- Ensure overlap guards tolerate jobs that were already mid-cycle before deployment or restart.

### Validation

- Start the bot in staging and confirm each startup task runs once.
- Run recurring jobs manually in staging and confirm no duplicate writes or duplicate log sequences.
- Re-run scheduler and leaderboard tests.

### Rollback

- Revert scheduler guard changes if a job stops firing.
- Keep duplicate reconciliation removal separate for an isolated revert if needed.
- If reverting after deployment, clear or normalize any new run-state markers before restarting older scheduler code.

### Phase 1 Exit Criteria

- No known P0 DM or scheduler defects remain open.
- DM queue creation and cancellation behave correctly under repeated calls.
- Startup no longer repeats recruit reconciliation.

## Phase 2 - Core Flow Integrity and Database Safety

### Workstream 4: Collapse Recruit Flow to One Implementation Path

### Why

Audit findings 1 and 18 show split business logic and inconsistent service boundaries.

### Scope

- `src/commands/recruiting/recruit.js`
- `src/services/recruiting/recruit-service.js`
- related recruiting services and tests

### Changes

- Pick one authoritative implementation path for recruit business rules.
- Move interaction formatting and reply behavior to the command layer or a dedicated presenter helper.
- Keep the service layer responsible for validation, writes, and return values.
- Remove duplicate checks around recruiter authority, crediting, and region/team inference.
- Keep a temporary compatibility adapter so records and return values produced by the old path remain accepted until end-to-end staging verification is complete.

### Validation

- End-to-end recruit flow test:
  - recruit command
  - DB write
  - points update
  - leaderboard refresh
  - promotion/status follow-on behavior
- Manual staging check with normal recruiter, admin, invalid recruiter, and missing-role edge cases.

### Rollback

- Revert the recruit consolidation PR only.
- Keep interface adapters small so the previous command path can be restored quickly.
- Do not remove the old-path adapter until partially processed recruits and downstream leaderboard updates have been checked after deployment.

### Workstream 5: Database Integrity, Constraints, and Migration Separation

### Why

Audit findings 4, 17, and 20 show schema safety and config coupling issues.

### Scope

- `src/db_async.js`
- `src/lib/db-referential-preflight.js`
- DB bootstrap helpers
- migration scripts if added

### Changes

- Split import-time DB bootstrap from versioned migration logic.
- Ensure foreign keys, uniqueness, and referential guarantees are enforced by schema where possible.
- Replace repair-on-startup behavior with stricter write boundaries and explicit migration/preflight logic.
- Audit transactions around recruit, DM campaign, leaderboard, and promotion writes.
- Roll out schema changes in additive stages so both pre-change and post-change application code can run during the transition window.

### Validation

- Dry-run the migration path on a production DB snapshot.
- Prove startup works on a clean DB and an existing DB.
- Add DB-level tests for duplicate prevention where the code assumes uniqueness.

### Rollback

- Restore from DB snapshot if a migration fails.
- Keep schema and application code changes deployable in a reversible order.
- Revert application code before attempting a schema rollback, unless the migration itself is the direct cause of startup failure.

### Workstream 6: Leaderboard and Promotion Flow Verification

### Why

The stabilization goal is an intact recruit -> points -> leaderboard -> promotion chain, not isolated fixes.

### Scope

- leaderboard utilities and scheduler hooks
- promotion logic
- recruiter and status reporting paths

### Changes

- Verify leaderboard seeding and refresh are compatible with current schema.
- Confirm promotion logic reads the same source of truth as points and leaderboard logic.
- Remove any test-only branch that changes production behavior where a dependency seam can replace it.

### Validation

- Manual staging flow from recruit through leaderboard update and promotion eligibility.
- Targeted tests for leaderboard initialization and promotion safety.

### Rollback

- Revert leaderboard/promotion changes separately from recruit changes.

### Phase 2 Exit Criteria

- Recruit flow uses one business path.
- DB uniqueness and referential integrity are enforced or explicitly justified.
- Recruit -> points -> leaderboard -> promotion is green in tests and staging.

## Phase 3 - Operational Hardening

### Workstream 7: Configuration Contract and Startup Validation

### Why

Audit findings 6, 8, and 20 show fragmented config handling and runtime mutation.

### Scope

- `src/lib/env.js`
- `src/lib/env-utils.js`
- `src/constants.js`
- `src/index.js`

### Changes

- Define one startup validation contract for required and optional config.
- Stop mutating `process.env` at runtime unless strictly necessary.
- Fail fast on invalid mandatory config and log actionable warnings for optional config.
- Document config defaults and deployment expectations.

### Validation

- Start the app with full config, minimal config, and intentionally broken config.
- Confirm failure mode is deterministic and readable.

### Rollback

- Revert the config-validation PR if startup blocks valid environments unexpectedly.

### Workstream 8: Hidden State, Logging, and Observability

### Why

Audit findings 5, 19, and 23 show process-local state and limited operational visibility.

### Scope

- analytics buffers
- invite caches
- DM history/dedupe
- cooldown maps
- logging helpers

### Changes

- Inventory process-local state and classify it as:
  - safe cache
  - restart-sensitive
  - multi-instance unsafe
- Move risky dedupe or durable state out of temp files and into DB-backed state where needed.
- Reduce raw `console.*` noise in favor of structured logs.
- Add minimal metrics or counters for:
  - DM queue depth
  - scheduler job runs and skips
  - command failure rate
  - DB error rate

### Validation

- Confirm logs can answer:
  - what failed
  - where it failed
  - how many records were affected
  - whether it retried
- Simulate a restart and verify durable state behaves as expected.

### Rollback

- Revert observability-only changes independently if they add noise or overhead.

### Workstream 9: Repo Hygiene and Lint Debt

### Why

Audit findings 9, 11, 12, 13, 14, and 15 indicate cleanup debt that can hide future regressions.

### Scope

- `.eslintignore`
- transient tracked artifacts
- large refactor leftovers such as `recruiter.js` and `scheduler.js`
- swallowed filesystem/runtime helpers

### Changes

- Ignore local mirror and transient artifacts correctly.
- Remove dead code and unreachable branches left by earlier refactors.
- Replace silent catches with explicit logging or documented suppression.
- Reduce lint errors to zero and drive warnings down enough that new warnings stand out.

### Validation

- Run lint and save the before/after delta.
- Re-run the full test suite after each cleanup PR, not only at the end.

### Rollback

- Revert cleanup-only PRs if they introduce behavior drift.

### Phase 3 Exit Criteria

- Startup config validation is deterministic.
- Risky hidden state is documented or moved.
- Lint is no longer masking serious defects with noise.

Status on 2026-04-02:

- met locally
- config/bootstrap paths were centralized and revalidated
- health/analytics metrics exposure was added
- repo-wide lint is now clean (`0` errors, `0` warnings)

## Phase 4 - Deep Post-Fix Regression Audit

### Objective

After the fixes land, run a second deep audit focused on regression discovery, concurrency, idempotency, and production realism.

### Automated Audit Pass

- Run:
  - `npm test -- --runInBand`
  - `npx jest --runInBand --detectOpenHandles`
  - `node scripts/verify_commands.js`
- Add targeted concurrent tests for:
  - DM campaign creation
  - DM cancellation during retry
  - recruit submission races
  - scheduler overlap
- Run lint and record remaining warnings with ownership.

### Staging Flow Audit

- Recruit flow:
  - valid recruiter
  - admin override
  - invalid recruiter
  - duplicate recruit attempt
- DM flow:
  - new campaign
  - partial failure
  - retry
  - cancel mid-flight
- Scheduler flow:
  - startup run
  - recurring run
  - forced overlap attempt
- Permissions flow:
  - missing role
  - missing channel
  - role hierarchy failure

### Data Integrity Audit

- Query for duplicate recruits, duplicate DM targets, orphaned foreign-key-style records, and stale retry targets.
- Verify migrations on a DB copy produce the same row counts and expected constraints.
- Confirm no startup repair task is silently mutating production data without explicit logging.

### Observability Audit

- Confirm logs expose command failures, DB failures, scheduler skips, antinuke events, and queue backlogs.
- Confirm alerts or at least detectable log patterns exist for error spikes.

### Exit Criteria

- No new P0 or P1 regressions introduced by stabilization work.
- Concurrency and idempotency tests pass.
- Staging flows match expected production behavior.

Status on 2026-04-02:

- first two criteria met locally
- staging-flow verification still pending outside this workspace

## Phase 5 - Canary and Rollout

### Actions

- Deploy to staging and monitor for at least two hours.
- Deploy to one to three canary guilds or a restricted production cohort.
- Watch:
  - command failure rate
  - DB error rate
  - scheduler overlap/skips
  - antinuke warnings
  - DM queue backlog
- Tag the release commit before full rollout.
- Keep transition adapters in place through the canary window; remove them only after the regression audit and canary checks both pass.

### Rollback Triggers

- Bot crash on startup or repeated job failure
- DM duplication or queue corruption
- Recruit flow data mismatch
- DB migration anomaly
- command failure spike above agreed threshold

### Rollback Actions

- `git revert <commit>` for isolated code regressions
- deploy previous tagged release
- restore DB snapshot only if schema/data integrity is affected

## Workstream Mapping to Audit Findings

- Findings 16 and 22 -> Phase 1, Workstream 1
- Finding 3 -> Phase 1, Workstream 2
- Findings 2, 7, and 10 -> Phase 1, Workstream 3
- Findings 1 and 18 -> Phase 2, Workstream 4
- Findings 4, 17, and 20 -> Phase 2, Workstream 5
- Findings 6 and core-flow risks -> Phase 2, Workstream 6
- Findings 6, 8, and 20 -> Phase 3, Workstream 7
- Findings 5, 19, and 23 -> Phase 3, Workstream 8
- Findings 9, 11, 12, 13, 14, and 15 -> Phase 3, Workstream 9

## Definition of Done

- All P0 items are fixed and verified in staging.
- P1 items are fixed or explicitly deferred with owner, reason, and rollback note.
- DB migrations are dry-run and reversible.
- Monitoring and rollback notes are updated in docs.
- The deep post-fix regression audit is complete and linked back into the mega audit tracker.

Current completion note:

- local engineering definition of done is met except for staging/canary/production operational checks
- use `docs/POSTFIX_REGRESSION_AUDIT_2026-04-02.md` as the sign-off input before Phase 5 rollout
