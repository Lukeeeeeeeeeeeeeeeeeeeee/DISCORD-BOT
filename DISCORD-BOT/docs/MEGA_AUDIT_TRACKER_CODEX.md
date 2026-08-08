# Mega Audit Tracker (Codex)
Last Updated: 2026-04-02
Audit Scope: full repo sweep + deep manual review of highest-risk runtime paths

Post-fix regression audit: `docs/POSTFIX_REGRESSION_AUDIT_2026-04-02.md`

## Scope
- Tracked files scanned from `git ls-files`: `279`
- Source files under `src/`: `147`
- Test files under `tests/`: `72`
- Docs under `docs/`: `8`
- Additional local workspace artifact scanned because tooling touches it: untracked mirror folder `DISCORD-BOT/`

Implementation plan: `docs/MEGA_STABILISATION_IMPLEMENTATION_PLAN.md`

This audit was not limited to one bugfix area. I scanned the entire tracked tree for:
- runtime entrypoints
- data layer and migrations
- commands and service boundaries
- scheduler and background jobs
- DM worker / campaign flow
- anti-nuke and permissions
- CI/deploy config
- test coverage and repo hygiene

Deep manual review was performed on the highest-risk files:
- `src/index.js`
- `src/db_async.js`
- `src/lib/antinuke.js`
- `src/scheduler.js`
- `src/lib/weekly-recalculations.js`
- `src/lib/leaderboard-utils.js`
- `src/services/dm/dm-campaign-service.js`
- `src/services/dm/dm-worker.js`
- `src/services/dm/dm-legacy-command.js`
- `src/commands/dm.js`
- `src/commands/recruiting/recruit.js`
- `src/services/recruiting/recruit-service.js`
- `src/commands/recruiting/recruiter.js`
- `src/lib/recruiter-stats.js`
- `src/lib/recruiter-helpers.js`
- `.github/workflows/test.yml`
- `.github/workflows/deploy.yml`
- `package.json`

## Validation Snapshot
Current local validation on 2026-04-02 after the stabilisation pass:
- `jest --runInBand` -> pass (`73/73` suites, `260/260` tests)
- `jest --runInBand --detectOpenHandles` -> pass (`73/73` suites, `260/260` tests)
- `node scripts/verify_commands.js` -> pass (`32` commands loaded)
- `node scripts/migration-dry-run.js` -> pass
- `eslint . --ext .js` -> pass (`0` errors, `0` warnings)

Repo-wide static smell counts from this audit:
- direct `console.*` calls in `src/`: `235`
- direct `process.env.*` reads in `src/`: `198`
- swallowed `catch { void ... }` patterns in `src/`: `22`

Dependency signal:
- Latest deploy/install logs in this workspace reported `19` vulnerabilities (`2 low`, `7 moderate`, `10 high`).
- A fresh local `npm audit` was not runnable in this shell because `npm` is not installed on PATH here.

## Executive Summary
The repo is in materially better shape than at the start of the audit. The high-risk local findings that drove the stabilisation pass have been addressed in code and revalidated. The current branch is now lint-clean, the full Jest gate is green, command verification is green, and the migration dry-run is green.

The remaining risk has shifted from "local branch instability" to "operational proof":
- staging and canary validation still need to be executed against a real guild environment
- some tests still emit expected console noise for optional tables or env gaps
- plain Jest still prints the generic async-operations banner even though `--detectOpenHandles` passes
- dependency vulnerability remediation was not part of this pass

For the full local post-fix assessment, see `docs/POSTFIX_REGRESSION_AUDIT_2026-04-02.md`.

## Baseline High Priority Findings

The detailed findings below capture the baseline audit state that drove the stabilisation plan. They are preserved as the original defect inventory, not as a claim that each issue is still open on the current branch.

For current status after the implementation pass, use:

- `docs/POSTFIX_REGRESSION_AUDIT_2026-04-02.md`
- `docs/MEGA_STABILISATION_IMPLEMENTATION_PLAN.md`

### 1. Recruit flow still has two live implementations
Severity: High

Evidence:
- `src/commands/recruiting/recruit.js:30`
- `src/services/recruiting/recruit-service.js:39`
- duplicated helpers exist in both files:
  - `inferTeamFromRecruiter`
  - `inferRegionTagFromMember`
  - `pickOnboardingRole`
  - `normalizeIgn`
  - `getRecruitPolicy`

Why this matters:
- This is the exact kind of split that caused the recent recruit/activity regressions.
- Fixes applied to one path can drift from the other.
- Tests can go green while production behavior diverges depending on which path is executed.

Improvement:
- Make `src/services/recruiting/recruit-service.js` the single business-logic implementation.
- Reduce `src/commands/recruiting/recruit.js` to interaction parsing + response formatting only.
- Move the duplicated helper functions into one shared module.

### 2. Startup runs recruit reconciliation twice
Severity: High

Evidence:
- `src/index.js:291`
- `src/index.js:320`

Why this matters:
- `reconcileRecruits(client, db)` is invoked once directly and then invoked again inside `Promise.all(...)`.
- That doubles startup load and increases the chance of duplicate side effects during boot.
- It also makes startup timing harder to reason about.

Improvement:
- Reconcile once.
- Store the promise if the startup flow needs to await it in multiple places.

### 3. `dm-worker.js` currently fails lint with actual code defects
Severity: High

Evidence:
- `src/services/dm/dm-worker.js:123` -> unreachable `return rows;`
- `src/services/dm/dm-worker.js:123` -> `rows` is not defined
- `src/services/dm/dm-worker.js:473` -> empty catch block
- `src/services/dm/dm-worker.js:66` -> useless wrapper catch around `withTransaction(...)`

Why this matters:
- These are not cosmetic warnings. They show refactor residue in a core runtime worker.
- CI should fail on this branch because `package.json:22-24` and `.github/workflows/test.yml:25-26` route merges through lint.
- The worker path is one of the highest blast-radius areas in the bot.

Improvement:
- Remove the unreachable return.
- Replace the empty catch on worker shutdown with structured logging.
- Simplify the redundant try/catch around the transaction wrapper.

### 4. `db_async.js` is doing too much at import time
Severity: High

Evidence:
- `src/db_async.js:1-1321`
- migration execution and trigger creation live inside runtime init:
  - `src/db_async.js:629-776`
- repeated `catch (e) { void e; }` around schema/index work:
  - `src/db_async.js:621-627`
  - more throughout the file

Why this matters:
- Requiring the DB module performs path creation, PRAGMA setup, schema creation, compatibility patches, trigger creation, and migrations.
- That makes tests, scripts, workers, and runtime all share one very heavy side-effectful import.
- Failures during migration are hard to isolate because schema logic and runtime connection logic are fused together.

Improvement:
- Split into:
  - connection/bootstrap
  - schema definitions
  - ordered migrations
  - backfills/repair tasks
- Keep runtime startup idempotent, but move versioned migration bodies into separate files under a migrations folder.

## Medium Priority Findings

### 5. Legacy DM dedupe is file-based and process-local
Severity: Medium

Evidence:
- `src/services/dm/dm-legacy-command.js:15`
- `src/services/dm/dm-legacy-command.js:34`
- `src/services/dm/dm-legacy-command.js:41`
- `src/services/dm/dm-legacy-command.js:89-105`

Why this matters:
- The modern DM system is DB-backed and worker-based.
- The legacy path still reads and writes a temp JSON history file and scans real DM inbox history.
- That behavior is not cluster-safe, not shard-safe, and not horizontally consistent across hosts.

Improvement:
- Move legacy dedupe and history entirely into the DB-backed campaign layer.
- Treat the legacy command as just another caller of the campaign service.

### 6. Production modules still change behavior based on `NODE_ENV === 'test'`
Severity: Medium

Evidence:
- `src/lib/leaderboard-utils.js:120`
- `src/commands/recruiting/recruit.js:226`
- `src/services/recruiting/recruit-service.js:513`
- `src/services/recruiting/recruiter-buy-service.js:74`
- `scripts/verify_commands.js:7-12`

Why this matters:
- Test-only branches inside production modules hide behavioral drift.
- A command can be "verified" under test mode while production mode behaves differently.
- This is one reason regressions can sneak through a green suite.

Improvement:
- Push test-specific behavior behind explicit options or injected dependencies.
- Avoid branching on `NODE_ENV` inside business logic unless there is no better seam.

### 7. Weekly recalculation architecture still overlaps by design
Severity: Medium

Evidence:
- `src/lib/weekly-recalculations.js:61-67`
- `src/scheduler.js:751`

Why this matters:
- The code comment explicitly says the scheduler path and weekly recalculation path can overlap and produce duplicate DMs / work.
- The scheduler still calls `performWeeklyRecalculations(guild)` directly.
- Even when it is currently safe enough, the architecture is still warning future maintainers that it can drift into double-processing.

Improvement:
- Keep one Monday reset path only.
- Delete the obsolete path or convert it into a pure helper with no scheduling responsibility.

### 8. Runtime mutates `process.env` during startup
Severity: Medium

Evidence:
- `src/index.js:300`

Why this matters:
- `process.env.AECS_TELEMETRY_CHANNEL_ID` is mutated at runtime to inherit the anti-nuke channel.
- This leaks configuration changes globally and makes startup order matter.
- It also makes testing and debugging less deterministic.

Improvement:
- Build an explicit runtime config object and pass it to AECS.
- Do not mutate `process.env` after process boot unless there is a very strong reason.

### 9. `recruiter.js` still contains dead refactor leftovers
Severity: Medium

Evidence:
- ESLint warnings in `src/commands/recruiting/recruiter.js`
- examples:
  - `src/commands/recruiting/recruiter.js:71`
  - `src/commands/recruiting/recruiter.js:81`
  - `src/commands/recruiting/recruiter.js:127`
  - `src/commands/recruiting/recruiter.js:168`
  - many unused imports at `src/commands/recruiting/recruiter.js:2-16`

Why this matters:
- The command appears halfway between "fat command" and "service-backed command".
- Unused helpers and imports increase review noise and make it harder to see the true execution path.

Improvement:
- Strip unused helpers from the command.
- Keep shared helpers in `src/lib/recruiter-helpers.js` and service modules only.

### 10. Scheduler has visible refactor drift and dead code
Severity: Medium

Evidence:
- ESLint warnings in `src/scheduler.js`
- unused imports and helpers:
  - `src/scheduler.js:7-19`
  - `src/scheduler.js:56-58`
  - `src/scheduler.js:145`

Why this matters:
- Scheduler code is operationally sensitive.
- Dead imports and unused helpers in this file are a signal that the module keeps absorbing responsibilities without enough cleanup.

Improvement:
- Split scheduler jobs by concern:
  - weekly reset
  - leaderboard refresh
  - warnings/quota
  - cache warming
  - DM report scans
- Keep the root scheduler file as orchestration only.

### 11. Repo hygiene is weak around transient artifacts
Severity: Medium

Evidence:
- Tracked runtime/test artifacts at repo root:
  - `error.log`
  - `failures.txt`
  - `final_test_results.txt`
  - `jest_failures.txt`
  - `test_output.txt`
  - `verify_output.txt`
- Tracked runtime seed data:
  - `src/data/antinuke_data.json`
  - `src/data/antinuke_data.json.bak`
- Untracked local mirror folder present:
  - `DISCORD-BOT/`

Why this matters:
- Logs and one-off result files add churn and review noise.
- The local mirror folder causes duplicate lint output but is not ignored by `.eslintignore`.
- Mutable runtime state in the repo increases drift risk.

Improvement:
- Remove generated logs/results from source control.
- Ignore the local `DISCORD-BOT/` mirror explicitly.
- Decide whether `src/data/antinuke_data.json` is a seed fixture or runtime data, and treat it as only one of those.

### 12. Logging is still too noisy and too inconsistent
Severity: Medium

Evidence:
- direct console count in `src/`: `235`
- major contributors:
  - `src/lib/antinuke.js` -> `46`
  - `src/index.js` -> `32`
  - `src/scheduler.js` -> `20`
  - `src/lib/weekly-recalculations.js` -> `14`
- optional-table errors still printed at error level:
  - `src/lib/recruiter-stats.js:127`
  - `src/lib/recruiter-stats.js:198`
  - `src/scheduler.js:623`

Why this matters:
- Expected fallback conditions are mixed with true runtime failures.
- The logs are louder than the actual signal.
- This directly slows incident response.

Improvement:
- Route expected fallback cases through structured debug/info events.
- Reserve `console.error` / error-level AECS logging for materially actionable failures.

## Lower Priority Findings

### 13. `.eslintignore` does not ignore the local mirror folder
Severity: Low

Evidence:
- `.eslintignore` contains only:
  - `node_modules/`
  - `dist/`

Why this matters:
- Local lint output is duplicated against the untracked `DISCORD-BOT/` mirror folder.
- This inflates warning counts and wastes review time.

Improvement:
- Add `DISCORD-BOT/` to `.eslintignore` if that mirror is expected to keep existing locally.

### 14. `permissions.js` has small documentation and cleanup drift
Severity: Low

Evidence:
- duplicate docblock at `src/lib/permissions.js:99-108`

Why this matters:
- Not dangerous by itself.
- It is a signal that the file has been edited repeatedly without a cleanup pass.

Improvement:
- Remove duplicated comments and keep the permission surface small and explicit.

### 15. Some utility services still silently swallow filesystem/runtime errors
Severity: Low

Evidence:
- `src/services/recruiting/status-service.js:9-12`
- `src/services/recruiting/status-service.js:16-27`

Why this matters:
- Silent status degradation is acceptable for cosmetics, but not if operators expect backup visibility from the status command.

Improvement:
- Downgrade to structured debug/warn logs instead of swallowing entirely.

## Second-Pass Runtime Findings

### What is already covered better than the first pass implied
- `src/lib/transactions.js:18-74` does serialize transactions per DB handle and retries transient SQLite lock failures.
- `src/lib/job-locks.js:3-53` and `src/scheduler.js:70-78` give scheduled jobs a DB-backed lock instead of a process-local boolean.
- `src/db_async.js:89` enables foreign keys on the main handle, and the schema does use real uniqueness for some critical paths such as `recruits(guild_id, recruited_id)` and `dm_campaign_targets(campaign_id, user_id)` at `src/db_async.js:156` and `src/db_async.js:484`.
- The test suite is not fake coverage only. It includes real SQLite concurrency/integrity coverage in `tests/transactions.test.js`, `tests/rookie_points_atomic.test.js`, `tests/job-locks.test.js`, and `tests/db_referential_preflight.test.js`.

### 16. DM campaign creation still has a check-then-insert race and non-atomic write path
Severity: High

Evidence:
- active duplicate guard is a read-before-write at `src/services/dm/dm-campaign-service.js:181-189`
- campaign row insert happens separately at `src/services/dm/dm-campaign-service.js:237-258`
- target rows are then inserted batch-by-batch outside a wrapping transaction at `src/services/dm/dm-campaign-service.js:261-275`
- `src/db_async.js:432-459` defines `dm_campaigns` without a uniqueness rule that prevents two active campaigns with the same `(guild_id, message_hash)`

Why this matters:
- Two concurrent `/dm create` requests with the same message can both pass the duplicate check before either inserts.
- A mid-loop failure can leave a `dm_campaigns` row created with only some target rows written.
- `campaign.total_targets` can describe the intended target count even if insertion fails partway through.

Improvement:
- Wrap campaign row creation plus all target inserts in one transaction.
- Add a DB-level uniqueness strategy for active duplicate prevention, or claim an application lock before the duplicate check.
- Fail the entire creation atomically if any target batch insert fails.

### 17. Recruiter referential integrity is repaired in code, not guaranteed by schema
Severity: High

Evidence:
- foreign keys are turned on at `src/db_async.js:89`
- recruiter-related tables such as `warnings`, `multipliers`, `purchases`, `weekly_calculations`, and `absences` store `recruiter_id` as plain text in `src/db_async.js:177-240` without a foreign key to `recruiters`
- `src/lib/db-referential-preflight.js:57-138` compensates by inserting missing recruiter rows and deleting malformed rows before runtime
- recruiter auto-seeding triggers also exist in `src/db_async.js:681-708`

Why this matters:
- The DB still allows orphan recruiter references until preflight/triggers repair them.
- Integrity depends on startup/runtime behavior instead of the schema being self-defending.
- Data copied, imported, or written by scripts can violate assumptions without immediate failure.

Improvement:
- Move as much integrity as possible into real foreign-key constraints and migrations.
- If historical compatibility blocks that, enforce writes through repos/services only and make preflight mandatory in deploy gates.
- Document exactly which relationships are intentionally soft and why.

### 18. Error handling and service boundaries are still inconsistent
Severity: Medium-High

Evidence:
- several "services" are still interaction-aware and transport-coupled:
  - `src/services/recruiting/recruit-service.js:10` and `src/services/recruiting/recruit-service.js:465-841`
  - `src/services/recruiting/recruiter-warning-service.js:3-10` and `src/services/recruiting/recruiter-warning-service.js:28-191`
  - `src/services/recruiting/invite-service.js:1-7` and `src/services/recruiting/invite-service.js:44-209`
- these services call `replyError`, build embeds, fetch guild members directly, and trigger scheduler refreshes
- by contrast `src/services/dm/dm-campaign-service.js:146-160` throws raw errors to its caller

Why this matters:
- Callers cannot rely on one error contract. Some paths throw, some reply, some return payloads.
- It makes retries and compensation logic harder because domain logic is mixed with Discord response handling.
- Refactors stay risky because changing a service can also change interaction behavior.

Improvement:
- Split command adapters from domain services.
- Make services return data or throw typed errors, and keep `interaction.reply/editReply` in command modules only.
- Move scheduler refresh side effects behind explicit orchestration steps instead of burying them inside business services.

### 19. Process-local hidden state is still a major runtime dependency
Severity: Medium

Evidence:
- startup/runtime keeps multiple authoritative-looking maps in memory at `src/index.js:67-70` and `src/index.js:86-99`
- analytics keeps in-memory buffers and can intentionally drop snapshots under pressure at `src/lib/analytics.js:61-79` and `src/lib/analytics.js:436-471`
- DM worker selection caches eligible workers in-process at `src/services/dm/dm-worker-selector.js:9-15` and `src/services/dm/dm-worker-selector.js:72-88`
- invite service keeps a per-guild singleton map at `src/services/recruiting/invite-service.js:8-41`
- command-level cooldown state exists only in memory at `src/commands/dm.js:16-17`

Why this matters:
- A crash or restart loses some control state immediately.
- Multi-process behavior depends on topology, not just code correctness.
- Some of this state is fine as a cache, but some of it affects correctness or operator expectations.

Improvement:
- Classify each in-memory structure as cache, queue, or source of truth.
- Persist or externalize the ones that affect correctness across restarts.
- Document single-process assumptions explicitly where state is intentionally ephemeral.

### 20. Configuration handling is validated in pieces, not as one contract
Severity: Medium

Evidence:
- `src/lib/env.js:21-78` validates only a subset of runtime env vars
- `src/lib/env-utils.js:9-23` silently clamps or falls back on parse failures
- `src/constants.js:121-145` silently ignores invalid or unreadable JSON config by returning `null`
- `src/constants.js:385-400` merges config and env overrides dynamically at import time
- startup mutates `process.env` in `src/index.js:295-300`
- repo scan still found `198` direct `process.env.*` reads in `src/`

Why this matters:
- Bad config can fail open and quietly change behavior instead of failing fast.
- Different modules parse the same concept differently.
- Runtime mutation of `process.env` makes the effective configuration harder to reason about and test.

Improvement:
- Build one validated config object at startup and inject it.
- Stop mutating `process.env` after bootstrap.
- Treat malformed config files as startup errors, not silent fallback events, for non-local environments.

### 21. The test suite covers infrastructure races, but not the highest-risk command races
Severity: Medium

Evidence:
- CI ignores diagnostics via `package.json:57-60`
- the excluded diagnostic `tests/diagnostic/analytics_race.test.js:1-38` shows race investigation exists but is not a gating test
- real concurrency tests exist for infrastructure (`tests/transactions.test.js`, `tests/rookie_points_atomic.test.js`, `tests/job-locks.test.js`)
- I did not find equivalent concurrent `Promise.all(...)` race tests around `/recruit` execution or `createCampaign(...)` creation flow in the main recruit/DM command suites

Why this matters:
- Green tests prove some primitives are safe, not that the end-to-end command flows are safe under concurrent use.
- The current suite is strongest around helpers and persistence primitives, weaker around command-level races and duplicate-submission semantics.

Improvement:
- Add real-SQLite concurrent tests for:
  - two simultaneous `createCampaign(...)` calls with the same `message_hash`
  - two simultaneous recruit submissions for the same member
  - cancellation during retry / in-flight DM processing
- Promote any still-relevant diagnostics into assertion-based CI tests instead of leaving them ignored.

### 22. DM cancellation does not fully sweep retrying targets
Severity: Medium

Evidence:
- `src/services/dm/dm-campaign-service.js:324-337` cancels only `pending` and `claimed` targets
- `src/services/dm/dm-worker.js:609-617` still treats `retry_wait` as active work when checking campaign completion
- `src/services/dm/dm-worker.js:87-89` only claims targets from campaigns still in `queued` or `running`

Why this matters:
- A cancelled campaign can retain `retry_wait` targets that are no longer claimable but are also not marked cancelled.
- Operator-facing status can become misleading because `/dm status` does not surface `retry_wait` explicitly.
- Cancellation semantics are therefore only partial.

Improvement:
- Decide a clear cancellation policy for `retry_wait` and `sending`.
- Cancel `retry_wait` rows explicitly and expose any in-flight remainder in status/report output.
- Add tests for cancelling a campaign after transient failures have already scheduled retries.

### 23. Observability is stronger than the first pass implied, but still not operationally complete
Severity: Low-Medium

Evidence:
- `src/lib/logger.js:84-149` routes both unexpected errors and runtime events through AECS
- despite that, many hot paths still fall back to raw `console.*` logging and local warning text
- analytics and DM internals do not expose first-class metrics endpoints for queue depth, dropped snapshots, or campaign backlog

Why this matters:
- Single incidents are easier to debug than in a typical bot codebase.
- Long-running degradation is still harder to quantify than it should be.
- The repo has logging, but not enough operational measurement.

Improvement:
- Expose counters or periodic structured snapshots for analytics drops, scheduler skips, DM queue backlog, and recruit outcomes.
- Reduce the remaining direct `console.*` fallbacks in favor of structured scopes.
- Add operator-facing health checks for queue depth and last successful scheduler run.

## Structural Notes By Area

### Root and config
- Good:
  - `package.json` has a meaningful `stability:check`.
  - CI and deploy both gate on that script.
- Improve:
  - root contains tracked logs and one-off result artifacts
  - docs drifted behind the actual suite and command count

### CI and deploy
- Good:
  - `.github/workflows/test.yml` runs the whole stability gate
  - `.github/workflows/deploy.yml` blocks deploy on predeploy checks
- Improve:
  - branch is currently not clean against lint, so CI mergeability is weaker than the green Jest output suggests

### Commands
- Good:
  - command loader and verification coverage are decent
  - compatibility shims are explicitly detected and skipped
- Improve:
  - some commands still embed business rules instead of delegating to services
  - recruiter and recruit are the clearest examples

### Services
- Good:
  - the repo/service split exists and is moving in the right direction
  - DM worker architecture is conceptually much stronger than the original inline-send model
- Improve:
  - service boundaries are inconsistent
  - `dm-worker.js` and `recruit-service.js` need cleanup before more features land there

### Lib / runtime core
- Good:
  - AECS, runtime registry, and shutdown sequencing are meaningful improvements over ad hoc logging
- Improve:
  - `db_async.js`, `index.js`, and `antinuke.js` are still monolithic coordination points
  - too much configuration is read directly from env inside leaf modules

### Tests
- Good:
  - test coverage is strong and caught the recent regressions once updated
  - `verify_commands.js` isolates command loading into temp resources
- Improve:
  - production-vs-test branching still exists in runtime code, so some tests are validating a different code path than prod

### Docs
- Good:
  - the repo has architecture docs and prior audit reports
- Improve:
  - the previous `docs/MEGA_AUDIT_TRACKER_CODEX.md` was stale and materially out of date
  - current docs should be treated as operational artifacts and refreshed after each stabilization pass

## Recommended Priority Order
1. Make DM campaign creation atomic and race-safe in `src/services/dm/dm-campaign-service.js`.
2. Fix the current lint/code defects in `src/services/dm/dm-worker.js`.
3. Remove the duplicate `reconcileRecruits(...)` startup call in `src/index.js`.
4. Collapse recruit logic to one implementation path.
5. Replace recruiter referential repair logic with stronger schema guarantees or stricter write boundaries.
6. Split `src/db_async.js` into bootstrap + versioned migrations.
7. Remove test-only branching from production modules where a dependency seam can replace it.
8. Untangle service boundaries so services stop owning interaction replies and scheduler refreshes.
9. Move legacy DM history/dedupe out of local temp files and into DB-backed state.
10. Add concurrent end-to-end tests for `/dm create`, `/recruit`, and DM cancellation/retry behavior.
11. Reduce raw `console.*` usage and expose a small set of queue/health metrics.
12. Clean `recruiter.js`, `scheduler.js`, and other refactor leftovers until lint is warning-light.
13. Clean repo hygiene: transient artifacts, local mirror ignore rules, mutable state boundaries.

## What Is Strong Right Now
- CI/deploy gating exists and is sensible.
- Core suite is broad for this type of bot.
- Command verification is isolated and deterministic.
- Recent DM and recruit regressions are now covered by tests.
- The repo already has real SQLite concurrency tests for transactions, locks, and atomic point updates.
- AECS gives the project a better structured error path than most Discord bot codebases.
- The repo has enough structure now that stabilization is realistic without another rewrite.

## Bottom Line
This codebase is not in "start over" condition. It is in "tighten architecture before the next big feature wave" condition.

The biggest technical debt is not lack of tests anymore. It is drift:
- duplicated business logic
- monolithic runtime files
- test-only behavior in production modules
- leftover code from partially completed refactors

If those four areas are cleaned up, the bot becomes much safer to extend without repeating the same class of regressions.
