# Discord Bot Deep Audit (Production Readiness)
Date: 2026-02-26
Repo: `C:\discord-bot\DISCORD-BOT`
Branch baseline: `main`
Latest stabilization commits:
- `f275f8d` (`fix(startup): treat command compatibility shim as info`)
- `9568468` (`fix(stability): add scheduler locks and recruit rollback safeguards`)

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
- `npm run lint` -> pass (4 warnings, 0 errors)
- `node scripts/verify_commands.js` -> pass (29 commands loaded)
- `npm test -- --runInBand` -> pass (56 suites / 155 tests)
- `npm run migration:dry` -> pass
- `npm run stability:check` -> pass
- `npm audit --json` -> 14 vulnerabilities (8 moderate, 6 high)

## Overall State
Core production flows are now stable enough for canary and controlled rollout. The recent P0 reliability defects are fixed. Remaining risk is mainly architectural consistency, observability standardization, and dependency/security backlog.

## Resolved Since Last Audit

1. Scheduler lock enforcement is now active.
- Evidence:
  - `src/scheduler.js:42`
  - `src/scheduler.js:981`
  - `src/scheduler.js:1014`
  - `src/scheduler.js:1060`
  - `src/scheduler.js:1104`
  - `src/scheduler.js:1132`
- Result:
  - Cron jobs are guarded by DB-backed lock keys to prevent duplicate execution windows.

2. Recruit flow now compensates Discord state on DB failure.
- Evidence:
  - `src/commands/recruiting/recruit.js:98`
  - `src/commands/recruiting/recruit.js:114`
  - `src/commands/recruiting/recruit.js:490`
  - `src/commands/recruiting/recruit.js:582`
- Result:
  - Member roles/nickname are restored if recruit transaction fails after mutations.

3. Compatibility shim startup message no longer treated as warning telemetry.
- Evidence:
  - `src/lib/command-loader.js:112`
  - `src/lib/logger.js:62`
- Result:
  - Expected shim-skip messages no longer generate noisy warning-level diagnostics.

## Findings (By Severity)

### P1 (Critical maintainability/consistency)

1. Event architecture is still split between inline handlers and event factories.
- Evidence:
  - Inline handlers in `src/index.js:266`, `src/index.js:363`, `src/index.js:404`, `src/index.js:433`
  - Event factories available in `src/events/interaction-create.js:1`, `src/events/message-create.js:1`, `src/events/guild-member-add.js:1`, `src/events/guild-member-remove.js:1`
  - Only voice-state factory is wired through `src/index.js:10`
- Risk:
  - Drift and inconsistent behavior between old/new event paths.
- Recommendation:
  - Complete migration to one handler model and remove dead/duplicate path.

2. Permission checks are inconsistent across privileged commands.
- Evidence:
  - Central guard exists: `src/lib/command-auth.js:4`
  - Used by some commands: `src/commands/recruiting/leaderboard.js:339`, `src/commands/recruiting/revoke-recruit.js:21`, `src/commands/recruiting/status.js:10`
  - Manual role checks still present: `src/commands/recruiting/recruiter.js:86`, `src/commands/recruiting/recruiter.js:588`
- Risk:
  - Policy drift and uneven authorization behavior.
- Recommendation:
  - Move all privileged commands to one `ensureCommandAccess` policy wrapper.

3. Service/repo abstraction is only partially adopted.
- Evidence:
  - Services/repositories exist (`src/services/recruiting/*`, `src/repos/*`)
  - Runtime command path still has heavy inline SQL and orchestration:
    - `src/commands/recruiting/recruiter.js` (39 SQL literals)
    - `src/commands/recruiting/recruit.js` (20 SQL literals)
    - `src/scheduler.js` (37 SQL literals)
- Risk:
  - Refactor drift and slower, riskier schema evolution.
- Recommendation:
  - Either fully adopt service/repo layers in runtime paths or prune dead abstraction.

### P2 (Medium hardening / debt)

4. Large monolith files increase change risk.
- Evidence:
  - `src/lib/antinuke.js` (~4360 lines)
  - `src/scheduler.js` (~1178 lines)
  - `src/commands/recruiting/recruiter.js` (~1152 lines)
  - `src/db_async.js` (~963 lines)
- Risk:
  - High cognitive load, lower review quality, harder targeted tests.
- Recommendation:
  - Split by bounded context (policy, persistence, handlers, formatter/logging adapters).

5. Startup schema compatibility still has silent best-effort catch blocks.
- Evidence:
  - `src/db_async.js:902`
  - `src/db_async.js:918`
- Risk:
  - Schema drift can be hidden unless downstream logic fails visibly.
- Recommendation:
  - Keep idempotence but emit migration ID + reason for each ignored alter/create failure.

6. Logging remains mixed between AECS and direct console output.
- Evidence:
  - `src/lib/antinuke.js` (46 direct `console.*` calls)
  - `src/lib/weekly-recalculations.js` (15)
  - `src/lib/invite-system.js` (11)
- Risk:
  - Inconsistent alert routing and harder operational filtering.
- Recommendation:
  - Wrap operational logs in AECS/runtime logger and reserve raw console for bootstrap fallback only.

7. Security backlog remains open.
- Evidence:
  - `npm audit --json` on 2026-02-26: 14 total (8 moderate / 6 high)
- Risk:
  - Vulnerability exposure and forced upgrades later under time pressure.
- Recommendation:
  - Staged dependency upgrade plan with canary rollout and migration rehearsal.

8. Command-level test coverage is uneven for admin/ops surfaces.
- Evidence:
  - No direct command-specific tests for several operational commands including:
    - `src/commands/export_logs.js`
    - `src/commands/fixnick.js`
    - `src/commands/set_quarantine_options.js`
    - `src/commands/toggle_strict_mode.js`
    - `src/commands/toggle_aggressive_ban.js`
    - `src/commands/simulate_attack.js`
- Risk:
  - High-impact commands can regress without immediate CI detection.
- Recommendation:
  - Add direct tests for privileged command auth + happy/deny/error paths.

## What Is Missing To Call This "Fully Done"
- Complete event-handler architecture convergence.
- Standardize command authorization on one guard path.
- Decide service/repo strategy and finish migration or remove dead layer.
- Normalize runtime logging through one structured pathway.
- Burn down vulnerabilities with tracked release gates.
- Add missing direct tests for admin/ops commands.
- Add alert thresholds and paging route for AECS spikes.

## Stabilization Plan (Next Execution Order)
1. Event wiring convergence (`src/index.js` + `src/events/*`).
2. Authorization normalization (`src/lib/command-auth.js` + privileged commands).
3. Monolith decomposition for `antinuke.js`, `scheduler.js`, `recruiter.js`.
4. Security/dependency hardening with canary deploy policy.
5. Test-gap closure for operational commands.

## Operational Readiness Score (Current)
- Runtime stability: 8.5/10
- Data integrity safety: 8.2/10
- Security posture: 7.0/10
- Maintainability: 6.1/10
- Observability: 7.0/10
- Overall: 7.4/10
