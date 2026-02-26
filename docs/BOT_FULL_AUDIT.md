# Discord Bot Deep Audit (Production Readiness)
Date: 2026-02-26
Repo: `C:\discord-bot\DISCORD-BOT`
Branch baseline: `main`

## Scope
- Runtime bootstrap and startup sequencing
- Command system and permission model
- Recruit flow and points/leaderboard chain
- Anti-nuke system and rollback paths
- Scheduler and background jobs
- Database schema/migrations/integrity flow
- Test, CI, deploy, and observability posture

## Validation Snapshot
Executed locally on 2026-02-26:
- `npm run stability:check` -> pass
- `npm run migration:dry` -> pass
- `npm test -- --runInBand` -> pass (56 suites / 154 tests)
- `node scripts/verify_commands.js` -> pass (29 commands loaded)
- `npm run lint` -> pass with 4 warnings, 0 errors
- `npm audit --json` -> 14 vulnerabilities (8 moderate, 6 high)

## Overall State
The bot is operational for a single-guild production setup, but it is not fully stabilized from an engineering-risk perspective. Core flows run, yet there are still architecture and reliability gaps that can create regressions under failure conditions or during future refactors.

## Findings (By Severity)

### P0 (High-risk correctness/reliability)

1. Recruit flow can mutate Discord state before DB commit.
- Evidence:
  - `src/commands/recruiting/recruit.js:420`
  - `src/commands/recruiting/recruit.js:426`
  - `src/commands/recruiting/recruit.js:457`
- Why this matters:
  - Roles/nickname are changed before transaction starts.
  - If DB write fails, member state and DB state can diverge.
- Recommended fix:
  - Write DB record first in a transaction, then apply Discord mutations with rollback/compensation path (or explicit "repair job" marker).

2. Scheduler has no distributed lock enforcement, despite lock helper existing.
- Evidence:
  - Lock helper exists at `src/lib/job-locks.js:1`
  - Scheduled jobs run in `src/scheduler.js:951`, `src/scheduler.js:966`, `src/scheduler.js:974`, `src/scheduler.js:1010`, `src/scheduler.js:1044`, `src/scheduler.js:1062`
- Why this matters:
  - Multi-process or accidental duplicate scheduler starts can double-run jobs (weekly resets, cleanups, recalcs).
- Recommended fix:
  - Wrap each cron handler with `acquireJobLock(...)` keyed by guild/job/window.

### P1 (Critical maintainability/consistency)

3. Event architecture is split: inline runtime handlers plus unused event modules.
- Evidence:
  - Inline handlers in `src/index.js:266`, `src/index.js:363`, `src/index.js:404`, `src/index.js:433`
  - Event factories exist in `src/events/interaction-create.js:1`, `src/events/message-create.js:1`, `src/events/guild-member-add.js:1`, `src/events/guild-member-remove.js:1`
  - Only voice-state factory is wired via `src/index.js:11`, `src/index.js:454`
- Why this matters:
  - Two execution models increase drift and bug surface.
- Recommended fix:
  - Pick one model (factory handlers) and complete migration.

4. Service/repository layers are mostly orphaned from runtime command path.
- Evidence:
  - Service files exist under `src/services/recruiting/`
  - Repo files exist under `src/repos/`
  - Runtime command code in `src/commands/recruiting/*.js` still performs direct DB logic/SQL.
- Why this matters:
  - Refactor intent is not reflected in active path; dead abstraction increases confusion and maintenance time.
- Recommended fix:
  - Migrate command handlers to services/repositories or remove orphaned layers.

5. Authorization logic is not uniformly centralized.
- Evidence:
  - Shared guard: `src/lib/command-auth.js:1`
  - Mixed manual checks still present in multiple command modules, notably `src/commands/recruiting/recruiter.js:315` and nearby paths.
- Why this matters:
  - Permission behavior diverges between commands and increases bypass/regression risk.
- Recommended fix:
  - Use one command auth wrapper pattern for all privileged commands.

### P2 (Medium technical debt / resilience gaps)

6. Database schema setup still uses many best-effort silent catches.
- Evidence:
  - `src/db_async.js:897` through `src/db_async.js:914`
- Why this matters:
  - Non-fatal schema drift can remain hidden until runtime.
- Recommended fix:
  - Keep idempotence but log explicit migration IDs for every skipped failure.

7. SQL is heavily scattered across commands/libs/scheduler.
- Evidence:
  - High SQL concentration:
    - `src/commands/recruiting/recruiter.js` (39 SQL literals)
    - `src/commands/recruiting/recruit.js` (20)
    - `src/lib/analytics.js` (25)
    - `src/scheduler.js` (36)
- Why this matters:
  - Harder to evolve schema safely and review query correctness.
- Recommended fix:
  - Gradually move SQL into repository layer with contract tests.

8. Logging is mixed (`console.*` and AECS), not fully normalized.
- Evidence:
  - High direct console usage in hotspots, especially `src/lib/antinuke.js`.
- Why this matters:
  - Reduced observability consistency and harder alert routing.
- Recommended fix:
  - Route operational logs through one structured logger entrypoint.

9. Vulnerability backlog still present.
- Evidence:
  - `npm audit --json` on 2026-02-26: 14 total (8 moderate / 6 high)
  - Notable chains involve `sqlite3/node-gyp/tar` and `discord.js` transitive advisories.
- Why this matters:
  - Supply-chain and patch-lag risk.
- Recommended fix:
  - Controlled upgrade plan with canary and DB migration rehearsal.

10. Test coverage is good overall but uneven by command.
- Evidence:
  - 56 suites pass, but several commands have no direct command-specific tests (for example `fixnick`, `export_logs`, `set_quarantine_options`, `toggle_strict_mode`, `toggle_aggressive_ban`, `simulate_attack`).
- Why this matters:
  - Regressions in privileged/operational commands are more likely.
- Recommended fix:
  - Add command-level tests for high-risk admin commands first.

## What Is Missing To Call This "Fully Done"

The bot is not fully "done" until these are complete:
- Scheduler lock enforcement for all cron jobs
- Recruit flow consistency guard (DB-first or compensation)
- Single event architecture (no split runtime path)
- Unified command authorization framework
- Service/repo migration either completed or intentionally removed
- Security patch plan and tracked vulnerability burndown
- Alerting hooks (Discord/Slack/email) for AECS error-rate spikes

## Stabilization Plan (Execution Order)

1. P0 reliability (immediate)
- Add scheduler locks.
- Fix recruit flow mutation order/compensation.
- Add tests that force DB failures during recruit to verify no partial Discord-side state.

2. P1 architecture alignment
- Migrate index event handlers to event factory modules.
- Standardize command auth wrappers.
- Decide service/repo strategy: fully adopt or remove dead layer.

3. P2 hardening
- Normalize logging pathways.
- Reduce raw SQL scatter through repository wrappers.
- Address vulnerability backlog with staged upgrades.

## Operational Readiness Score (Current)
- Runtime stability: 7.5/10
- Data integrity safety: 6.5/10
- Security posture: 7.0/10
- Maintainability: 5.5/10
- Observability: 6.5/10
- Overall: 6.6/10

## Notes
- Current CI/deploy gates are good and active:
  - `.github/workflows/test.yml`
  - `.github/workflows/deploy.yml`
- This audit is intended to drive phase-by-phase stabilization, not broad rewrite in one pass.
