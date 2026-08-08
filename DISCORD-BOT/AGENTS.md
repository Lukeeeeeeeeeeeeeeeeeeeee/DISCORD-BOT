Post-Refactor Stabilisation Plan for Dev

Goals (what success looks like)

- Core flows stable in production (recruit -> points -> leaderboard -> promotion -> status).
- No high-severity regressions.
- Database and migrations are safe.
- Clear monitoring and rollback paths exist.
- Team can safely add features after a stabilisation window.

Roles / Owners

- Lead Dev (owner) — coordinates work, merges hotfix PRs, approves rollouts.
- DB Engineer — handles migrations, schema checks.
- Test/QA — runs tests, verifies flows in staging.
- Ops — deployment, logging, monitoring, rollbacks.
- If one person is doing all roles, mark tasks done as they complete them.

Phase 0 — Immediate Safety (Do first, no distractions)

- Feature freeze: no new features or wide refactors until stability achieved.
- Create a hotfix branch from the current main for urgent fixes only.
- Enable verbose logging (temporary) so failures show more detail in staging/prod.
- Run full test suite locally and in CI:
  - npm test -- --runInBand
  - node scripts/verify_commands.js
- Confirm 100% pass locally and in CI before any deploy.

Acceptance: All CI checks pass; team agrees to freeze.

Phase 1 — Triage & Prioritise (1 dev sprint / a few days)

- Collect failures: gather recent error.log, failures.txt, final_test_results.txt, jest_failures.txt, verify_output.txt.
- Reproduce each failure in staging (not prod).
- Triage list: for each bug record:
  - Title
  - Steps to reproduce
  - Expected vs Actual
  - Severity (P0/P1/P2)
  - Assigned owner

Severity guide:

- P0 (blocker): Bot crashes, data loss, antinuke not working.
- P1 (critical): Core flow broken (recruit/points/leaderboard).
- P2 (medium): UI/UX inconsistencies, nonblocking errors.
- P3 (low): Minor logs, docs, tests.

Acceptance: Triage board created with P0/P1 items assigned.

Phase 2 — Stabilise Critical Flows (focus: P0 -> P1)

Work in small PRs. Each PR must include tests and a clear rollback.

Key areas and checks (prioritise in this order)

Antinuke protection

- Verify event handlers load.
- Simulate role/channel deletion scenarios in staging (safe test guild).

Acceptance: antinuke triggers logged and action taken in tests.

Recruit flow end-to-end

- !recruit or slash equivalent -> DB write -> rookie points increment -> leaderboard update -> promotion.

Acceptance: all steps complete and data visible in DB.

Leaderboard initialization

- Verify scheduler seeds tables on startup with guild_id column present.

Acceptance: no startup errors in logs; leaderboards show correct data.

Schema migrations

- Run migration dry-run in a copy of production DB.
- Ensure triggers are dropped where required, then apply migrations.

Acceptance: migration completes with data intact and tested queries correct.

Scheduler and background jobs

- Run recurring jobs in staging; verify they do not double-run and handle failures.

Acceptance: jobs log start/end and retry cleanly on error.

Permissions / role checks

- Test permission edge cases (role hierarchy, missing perms).

Acceptance: commands fail with consistent embed replies and clear logs.

Commands/dev utilities to run

- npm test -- --runInBand
- node scripts/verify_commands.js
- Check DB: run queries on data/recruiter.db or via your DB client.
- Tail server logs: tail -f error.log or your logging system.

Acceptance: All P0 fixed, P1 triaged to manageable backlog.

Phase 3 — Harden & Automate (CI / monitoring / deploy safety)

CI gates

- Require: tests, lint, and verify_commands script pass before merge.

Predeploy checklist

- DB migration dry-run
- Backups taken (DB snapshot)
- Health check endpoint for bot

Canary rollout

- Deploy to staging -> verify for 2 hours.
- Deploy to limited production guild(s) (1–3 test servers) -> monitor for 24 hours.
- Full rollout if stable.

Monitoring

- Track: command failure rate, DB error rate, antinuke events, scheduler errors.
- Setup alerts for spikes (email/Slack).

Automatic rollback

- Tag release commits. If error rate crosses threshold, revert commit or disable new code path via feature flag.

Acceptance: Canary succeeds, alerts implemented, rollback tested.

Phase 4 — Clean-up & Documentation

- Refactor large recruiter.js into smaller modules if >600–800 lines.
- Update docs: put migration notes, schema changes, and troubleshooting steps into docs/MEGA_AUDIT_TRACKER_CODEX.md.
- Post-mortem for initial refactor pain: record what broke and why (1–2 page doc).
- Add integration tests that simulate real user flows (not just unit tests).

Acceptance: Code split where necessary, docs updated, tests added.

PR Template (use for all fixes)

Title: [hotfix|fix|chore] <short summary>

Description:
- What changed
- Why (reference issue/triage id)
- How tested (local, CI, staging)
- Rollback plan

Checklist:
- [ ] Tests added/updated
- [ ] verify_commands passes
- [ ] Migration dry run done (if DB change)
- [ ] Logger statements added
- [ ] Reviewed by (name)

Rapid Debugging Checklist (for each failure)

- Reproduce in staging.
- Capture logs and stack trace.
- Identify last commit that touched area. git bisect if unsure.
- Write failing test that reproduces bug.
- Fix, run tests, create PR.
- Merge to hotfix branch, run migration/backups, deploy to canary guilds.

Monitoring & Metrics to Watch (dashboard)

- Commands per minute (by command).
- Command failure rate (%) — alert when >1% or spikes.
- DB errors per minute.
- Antinuke triggers — alert on unexpected activations.
- Scheduler job failures / duplicate runs.

Rollback Strategies

- Quick revert: git revert <commit> and re-deploy.
- Feature flag: if a risky feature was added, toggle it off.
- DB rollback: restore DB snapshot (always test restore process first).
- Emergency branch: maintain stable branch which is the last known good state.

Meeting / Handoff Agenda for Your Dev (30–60 min)

- Review triage board (P0/P1).
- Assign owners and timelines for P0 fixes.
- Show how to run tests and verify commands.
- Confirm backup and migration steps.
- Decide canary guilds and monitoring contacts.
- Agree on deploy windows and rollback thresholds.

Quick Start Checklist (what they should run now)

- git checkout -b hotfix/stabilise
- npm test -- --runInBand
- node scripts/verify_commands.js
- Run failing flows in staging manually (recruit, leaderboard, antinuke tests)
- Create triage issues for each failure found

Full Bot Audit Plan (Good Structure)

1. Architecture and Folder Structure Audit

Goal: Make sure the codebase is logically organised and future-proof.

Check:

- Commands grouped by feature
- No duplicated utilities
- Clear separation:
  - commands
  - lib/helpers
  - database layer
  - scheduler
  - services

Look for:

- Massive files (hard to maintain)
- Circular imports
- Logic sitting inside command files that should be in lib/services

2. Command System Audit

Goal: Make sure all commands are stable and consistent.

Test:

- Command loading recursion works
- Permissions handled centrally
- Error handling uses reply helpers
- No outdated command paths

Also check:

- Slash command registration
- Cooldowns / concurrency protection
- Interaction timeout handling

3. Database Layer Audit

This is VERY important after your async rewrite.

Check:

- Every DB call uses async/await properly
- No missing awaits
- Transactions used where needed
- Schema migrations safe
- Data validation exists

Big red flags:

- Silent DB failures
- Multiple writes to same row at once
- Hardcoded SQL scattered around project

4. Scheduler and Background Jobs

Often overlooked and commonly broken.

Check:

- Weekly recalculations
- Leaderboard refresh
- Cleanup jobs
- Startup table seeding

Look for:

- Jobs running twice
- Jobs failing silently
- Guild-specific data isolation

5. Protection Systems Audit

Especially antinuke and permissions.

Verify:

- Event listeners load correctly
- Role hierarchy checks safe
- Rate limits exist
- Logging triggers properly

6. Recruiting System Flow Audit

Test full real workflow:

- Recruit -> Points -> Leaderboard -> Promotion -> Status -> Reports

Not just commands individually — test the full chain.

7. Test Coverage Audit

Even though tests pass, check:

- Are important flows missing tests?
- Are tests mocking too much?
- Do integration tests exist?

8. Logging and Monitoring Audit

Check:

- Do major actions log?
- Do failures log clearly?
- Are logs searchable?
- Are errors swallowed anywhere?

Extra Advanced Audit (If You Want To Go Deep)

Performance

- DB query efficiency
- Command response time
- Memory leaks
- Event listener duplication

Security

- Permission bypass risks
- Input validation
- Role spoofing prevention

Suggested Audit Order (Best Flow)

- Structure / architecture
- Command loader and commands
- Database and migrations
- Recruiting system flow
- Scheduler
- Protection systems
- Testing quality
- Logging and monitoring

Pro Tip For Audits

- Do not just read code.
- Actually:
  - Simulate real user behaviour
  - Try breaking commands
  - Try permission edge cases
  - Run commands quickly back-to-back

That reveals 10x more bugs.

Biggest Mistake People Make During Audits

- Trying to fix everything immediately.
- Better approach:
  - Write findings list
  - Rank severity
  - Fix highest risk first
