# Full Codebase Audit Rerun - 2026-04-02

## Scope

This is a fresh rerun against the current `C:\discord-bot` tree. It is not a copy of the earlier audit.

Audit method:

- scanned the tracked source tree and current docs/workflows
- revalidated the current branch with test/lint/verification commands
- deep-read the highest-risk runtime files
- cross-checked architecture, commands, DB, scheduler, protection, recruiting, DM, tests, logging, config, and operational safety

Repo snapshot during this rerun:

- tracked files: 291
- test files: 77
- largest hotspots:
  - `src/lib/antinuke.js`
  - `src/db_async.js`
  - `src/index.js`
  - `src/services/recruiting/recruit-service.js`
  - `src/scheduler.js`
  - `src/services/dm/dm-worker.js`
- repo-wide `process.env.` reads in `src`: 167

## Validation Snapshot

Current command results from this rerun:

- `jest --runInBand`: pass, `73/73` suites, `264/264` tests
- `jest --runInBand --detectOpenHandles`: pass, `73/73` suites, `264/264` tests
- `node scripts/verify_commands.js`: pass, `32` commands loaded
- `npm run migration:dry`: pass
- `eslint . --ext .js`: pass
- `npm run require-walk`: fail

The important validation conclusion is:

- local runtime validation is mostly strong
- the branch is not fully green because `require-walk` currently fails
- that matters because CI runs `npm run stability:check` in [test.yml](C:/discord-bot/.github/workflows/test.yml:25) and [deploy.yml](C:/discord-bot/.github/workflows/deploy.yml:33)

## Executive Verdict

The codebase is materially healthier than it was during the first audit, but it is still not clean enough to call "fully stabilized".

The biggest change from the earlier audit is that the rerun found a concrete module-graph break:

- `require-walk` fails because live files still import repo modules that do not exist

The broader picture:

- command loading is in better shape
- DB integrity handling is better than before
- health checks and runtime validation exist
- test coverage is much wider than it used to be
- but the runtime still leans heavily on giant orchestrator modules, in-memory state, soft-failure behavior, and app-layer repair logic

## Highest Severity Findings

### 1. High - The stability gate is broken by missing repo modules

Evidence:

- `src/services/recruiting/recruiter-info-service.js:23` imports `../../repos/flags-repo`
- `src/services/recruiting/info-service.js:6` imports `../../repos/verifications-repo`
- those files do not exist under `src/repos/`
- `npm run require-walk` fails on those imports

Impact:

- `stability:check` is not actually green end to end
- CI and predeploy workflows are supposed to reject this state
- direct imports into those services will explode immediately even if normal command loading does not touch every path

Why this matters more than a dead file:

- the command loader intentionally skips some shim/handler modules in [command-loader.js](C:/discord-bot/src/lib/command-loader.js:8), so the broken require graph is partially masked during normal command startup
- that means the repo can "look healthy" while still being structurally broken

Required fix order:

1. add the missing repos or remove the stale imports
2. make `require-walk` part of the normal local release checklist, not just CI
3. add a regression test around those two service entry points

### 2. High - Anti-nuke is still a giant stateful monolith

Evidence:

- `src/lib/antinuke.js` is the largest runtime file in the repo
- constructor owns config parsing, thresholds, backup policy, state backend setup, and warning behavior at `src/lib/antinuke.js:30`
- the same class owns a large amount of in-memory state at `src/lib/antinuke.js:147`
- search also found multiple timers/intervals registered later in the file
- it still uses direct `console.warn` for critical startup behavior at `src/lib/antinuke.js:35` and `src/lib/antinuke.js:116`

Impact:

- protection logic, persistence, rollback, alerting, and runtime policy are still too tightly coupled
- multi-instance behavior remains difficult to reason about
- any future anti-nuke change still has a very large blast radius

What improved since the previous audit:

- there is better backup-safety coverage
- environment validation is stricter

What is still wrong:

- the module is too large to audit confidently after each change
- file-backed state and many in-memory maps still make restart/recovery semantics hard to prove

### 3. High - `db_async.js` still mixes bootstrap, schema, migrations, and runtime handle management

Evidence:

- import-time side effect at `src/db_async.js:15`
- DB open and bootstrap begin in `src/db_async.js:17`
- schema definition starts at `src/db_async.js:56`
- many runtime helper checks, migrations, indexes, and repair behavior still live in the same module
- `src/lib/db-bootstrap.js:25` now enables `PRAGMA foreign_keys = ON`, which is good, but that does not undo the architectural concentration

Impact:

- startup remains fragile and difficult to isolate in tests
- schema and migration changes still share the same failure surface as runtime connection setup
- importing DB helpers still has side effects

This is still one of the top maintainability risks in the entire repo.

### 4. High - `index.js` remains a startup and orchestration god module

Evidence:

- client boot, scheduler startup, invite initialization, telemetry provisioning, anti-nuke init, health server, enforced-role timer, and DM report scan timer all live in `src/index.js`
- module-level hidden state starts at `src/index.js:35` and `src/index.js:69`
- the join lock queue is owned directly in `src/index.js:89`
- startup sequencing is still dense in `src/index.js:280`

Impact:

- boot behavior is still too centralized
- a startup regression can affect unrelated systems at once
- controlled canary rollout and partial subsystem disablement remain harder than they should be

The code is more careful than before, but not yet decomposed enough.

### 5. High - Scheduler still fails soft in critical data paths

Evidence:

- `src/scheduler.js:382` falls back to `new Map()` if batched new-staff lookup fails
- `src/scheduler.js:383` falls back to `new Map()` if batched 7-day stats fail
- warnings leaderboard reconciliation logs and continues at `src/scheduler.js:499`
- recruiter profile loading logs and continues at `src/scheduler.js:519`
- recruit-derived recruiter loading logs and continues at `src/scheduler.js:532`
- warnings leaderboard stats and staff checks also fall back to empty maps at `src/scheduler.js:566`

Impact:

- leaderboards can become partially correct rather than obviously failed
- operationally, stale or degraded output can look like "real data"
- tests currently tolerate some of this degraded behavior

This is resilience, but it is also silent correctness risk.

### 6. High - Referential integrity is still repaired in code instead of enforced by schema

Evidence:

- `src/lib/db-bootstrap.js:25` enables foreign keys
- but the core tables in `src/db_async.js` are still defined without actual foreign-key clauses to `recruiters`
- `src/lib/db-referential-preflight.js:57` inserts missing recruiter rows to repair references
- `src/lib/db-referential-preflight.js:74` deletes malformed rows as a cleanup strategy
- migration dry-run output shows this preflight still runs during migration flow

Impact:

- the app is compensating for integrity gaps instead of eliminating them
- broken relational state can be silently normalized into placeholder recruiter rows
- data mistakes risk being hidden instead of rejected

This is safer than having nothing, but it is still an application-level bandage.

## Medium-High Findings

### 7. Medium-High - Recruit service still owns too many responsibilities

Evidence:

- permission enforcement in `src/services/recruiting/recruit-service.js:526`
- DB transaction for recruit persistence in `src/services/recruiting/recruit-service.js:669`
- Discord role/nickname mutation in `src/services/recruiting/recruit-service.js:712`
- points finalization in `src/services/recruiting/recruit-service.js:729`
- scheduler recompute triggering in `src/services/recruiting/recruit-service.js:769`
- DM campaign enqueue in `src/services/recruiting/recruit-service.js:800`
- direct interaction reply handling throughout the service

Impact:

- recruit flow still cuts across permissions, DB, Discord mutations, leaderboard refresh, and messaging
- rollback reasoning is harder than it should be
- service boundaries are still broad enough that small recruit changes can regress unrelated downstream behavior

The earlier command/service duplication problem is improved, but it was replaced by a very broad service boundary.

### 8. Medium-High - Production behavior still changes under `NODE_ENV === 'test'`

Evidence:

- `src/services/recruiting/recruit-service.js:526`
- `src/services/recruiting/recruit-service.js:772`
- `src/services/recruiting/recruit-service.js:785`
- `src/lib/leaderboard-utils.js:120`
- `src/services/recruiting/recruiter-buy-service.js:74`
- integration tests actively force this path at `tests/integration_recruit_flow.test.js:126`

Impact:

- tests do not fully represent production semantics
- permission rules and async timing differ under test mode
- some green tests are proving test-only control flow, not release behavior

This is one of the biggest remaining sources of false confidence.

### 9. Medium-High - DM campaign dedupe is still race-prone at the application layer

Evidence:

- duplicate active-campaign check is read-before-write logic in `src/services/dm/dm-campaign-service.js:191`
- recent-target dedupe is also computed before inserts in `src/services/dm/dm-campaign-service.js:201`
- campaign creation is transactional in `src/services/dm/dm-campaign-service.js:338`, which is good
- but there is still no schema-backed unique guarantee for "only one active campaign with this hash in this guild"

Impact:

- concurrent create requests can still race
- the transaction improves consistency but does not eliminate logical duplicate creation
- this is especially relevant in a multi-admin or retried-interaction environment

Current tests do not close this gap:

- `tests/dm_campaign_service.test.js` heavily mocks DB behavior from `tests/dm_campaign_service.test.js:7`
- there is no real concurrent create-campaign integration test

## Medium Findings

### 10. Medium - Hidden state is still widespread across the runtime

Evidence:

- analytics buffers at `src/lib/analytics.js:61`
- invite state at `src/lib/invite-system.js:11`
- runtime singleton at `src/lib/runtime.js:1`
- active worker registry at `src/services/dm/dm-worker.js:26`
- anti-nuke maps at `src/lib/antinuke.js:147`
- startup maps and queues in `src/index.js:69`

Impact:

- multi-instance correctness is still subtle
- restart behavior is not always transparent
- local state can diverge from persisted state under crashes or partial shutdowns

This category improved, but it is still a defining property of the codebase.

### 11. Medium - Config handling is better but still fragmented

Evidence:

- file config normalization in `src/lib/config-loader.js`
- runtime config builder in `src/lib/runtime-config.js:16`
- env validation in `src/lib/env.js:21`
- raw env helper parsing in `src/lib/env-utils.js:9`
- many direct env reads remain outside those layers, especially in anti-nuke, analytics, AECS, scheduler, and DM modules

Observed repo-wide:

- `167` `process.env.` reads in `src`

Impact:

- validation is not centralized
- different modules still parse the same concepts in different ways
- operational changes remain harder to reason about than they should be

### 12. Medium - Logging and observability are still inconsistent

Evidence:

- structured logging exists in `src/lib/logger.js:84`
- fallback console logging still exists in `src/lib/logger.js:99` and `src/lib/logger.js:140`
- health endpoint exists in `src/lib/health-server.js:35`
- health metrics providers intentionally swallow failures at `src/lib/health-server.js:24`
- repo-wide console usage is still high:
  - `src/lib/antinuke.js`: 46
  - `src/index.js`: 32
  - `src/scheduler.js`: 17
  - `src/lib/weekly-recalculations.js`: 14
  - `src/lib/invite-system.js`: 11

Impact:

- there is still no single operational story for "what failed, where, and whether it is still degraded"
- some failures are structured AECS events
- some are raw console warnings
- some are swallowed after logging

### 13. Medium - The test suite is broad, but still optimistic in important places

Evidence:

- diagnostic tests are ignored by Jest in `package.json:57`
- scheduler tests use a minimal schema at `tests/scheduler.test.js:47`
- DM campaign service tests mock the DB layer from `tests/dm_campaign_service.test.js:7`
- some integration tests explicitly force `NODE_ENV=test` at `tests/integration_recruit_flow.test.js:126`

What is good:

- there are more real tests than before
- transaction/concurrency utilities are at least covered
- DM worker integration has dedicated tests

What is still weak:

- production-like concurrent race tests are still sparse
- some green suites tolerate degraded behavior through mocks or reduced schemas
- ignored diagnostic tests mean some interesting stress checks are not part of the default pass

### 14. Medium - `job-locks` can still intentionally fail open

Evidence:

- fast path in `src/lib/job-locks.js:8`
- fallback path in `src/lib/job-locks.js:30`
- hard failures log and return `failOpen` at `src/lib/job-locks.js:25` and `src/lib/job-locks.js:50`

Impact:

- the locking primitive exists, which is a positive
- but the API still allows callers to choose availability over exclusivity
- that means duplicate job execution is still possible by configuration or call-site choice

This is not automatically wrong, but it should be treated as a deliberate risk surface.

## Lower Severity / Code Quality Findings

### 15. Lower - Invite system still mixes persistent and in-memory state

Evidence:

- `src/lib/invite-system.js:11`
- `src/lib/invite-system.js:22`
- `src/lib/invite-system.js:102`

Impact:

- invite cooldowns and active invite state still depend partly on memory
- multi-instance behavior and restart semantics remain weaker than fully DB-backed equivalents

### 16. Lower - There is still a lot of noisy runtime console output in normal degraded conditions

Examples observed in the rerun:

- missing optional tables during scheduler-related tests
- anti-nuke missing env warnings
- job lock failures intentionally logged in tests

This is not a correctness bug by itself, but it does make real incident detection harder.

## Areas That Look Better Than Before

These are not findings. They are the things that genuinely improved.

- command loading is more disciplined
  - duplicate command detection exists in [command-loader.js](C:/discord-bot/src/lib/command-loader.js:131)
  - thin compatibility shims are explicitly skipped in [command-loader.js](C:/discord-bot/src/lib/command-loader.js:106)
- runtime env validation exists and is stricter than before in [env.js](C:/discord-bot/src/lib/env.js:21)
- a health endpoint exists in [health-server.js](C:/discord-bot/src/lib/health-server.js:35)
- migration dry-run and referential preflight are present
- DB bootstrap now enables foreign keys and runs integrity checks in [db-bootstrap.js](C:/discord-bot/src/lib/db-bootstrap.js:25) and [db-bootstrap.js](C:/discord-bot/src/lib/db-bootstrap.js:42)
- CI workflows do run a real stability gate in [test.yml](C:/discord-bot/.github/workflows/test.yml:25) and [deploy.yml](C:/discord-bot/.github/workflows/deploy.yml:33)
- the test suite is much larger and healthier than it used to be

## Recommended Remediation Order

### Immediate

1. Fix the missing repo modules breaking `require-walk`
2. Re-run `stability:check` and make sure the branch is actually end-to-end green
3. Decide whether the missing repo files should be restored or those services should be rewritten to use the repos that actually exist

### Next

1. Split `src/db_async.js` into:
   - connection/bootstrap
   - schema declarations
   - migration registry
   - runtime DB facade
2. Split `src/index.js` into startup modules:
   - telemetry boot
   - invite boot
   - scheduler boot
   - health boot
   - DM reporter boot
3. Reduce `src/services/recruiting/recruit-service.js` so it stops owning interaction replies, Discord writes, DB writes, scheduler refresh, and DM enqueue in one place

### After that

1. Stop scheduler from silently substituting empty maps in critical leaderboard paths
2. Replace preflight-based referential repair with stronger schema-backed guarantees where possible
3. Remove `NODE_ENV` branches from production services and replace them with explicit dependency injection or test helpers
4. Add real concurrency tests for:
   - concurrent DM campaign creation
   - concurrent recruit submission
   - overlapping scheduler invocations

### Longer term

1. Break anti-nuke into state, policy, audit, backup, and action modules
2. consolidate environment parsing into one configuration surface
3. normalize logging so runtime failures are consistently structured, queryable, and suppressible

## Final Assessment

Fresh rerun conclusion:

- the codebase is stronger than the first audit snapshot
- the branch has many real stabilization wins
- but it still has structural hotspots and one current hard blocker: the broken require graph

If this branch were going to production today, my answer would be:

- acceptable for continued staging work after the require-graph fix
- not yet clean enough to call fully stabilized or maintenance-safe

## Appendix - Concrete Evidence Used In This Rerun

Validation commands:

- `jest --runInBand`
- `jest --runInBand --detectOpenHandles`
- `node scripts/verify_commands.js`
- `npm run migration:dry`
- `npm run require-walk`
- `eslint . --ext .js`

Key files deep-reviewed:

- `src/lib/antinuke.js`
- `src/db_async.js`
- `src/lib/db-bootstrap.js`
- `src/index.js`
- `src/scheduler.js`
- `src/services/recruiting/recruit-service.js`
- `src/services/recruiting/recruiter-info-service.js`
- `src/services/recruiting/info-service.js`
- `src/services/dm/dm-campaign-service.js`
- `src/services/dm/dm-worker.js`
- `src/lib/analytics.js`
- `src/lib/job-locks.js`
- `src/lib/command-loader.js`
- `src/lib/config-loader.js`
- `src/lib/runtime-config.js`
- `src/lib/env.js`
- `src/lib/health-server.js`
- `src/lib/invite-system.js`
- `.github/workflows/test.yml`
- `.github/workflows/deploy.yml`
