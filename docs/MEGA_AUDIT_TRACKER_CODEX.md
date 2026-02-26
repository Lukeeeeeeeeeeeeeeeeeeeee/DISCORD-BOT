# Stabilization Tracker (Codex)
Last Updated: 2026-02-26
Primary Audit: `docs/BOT_FULL_AUDIT.md`
Recent Commits:
- `f275f8d` (`fix(startup): treat command compatibility shim as info`)
- `9568468` (`fix(stability): add scheduler locks and recruit rollback safeguards`)

## Current Gate Status
- `npm run stability:check` -> pass
- `npm run migration:dry` -> pass
- `npm test -- --runInBand` -> pass (56 suites / 155 tests)
- `node scripts/verify_commands.js` -> pass (29 commands)
- `npm run lint` -> pass (4 warnings)
- `npm audit --json` -> 14 vulnerabilities (8 moderate, 6 high)

## Active Workstreams

### WS-01: P0 Reliability
Status: completed
- [x] Add distributed scheduler locks around cron jobs
  - Implemented in: `src/scheduler.js`
- [x] Fix recruit flow ordering/compensation to prevent partial Discord-state commits
  - Implemented in: `src/commands/recruiting/recruit.js`
- [x] Add failure-mode tests for recruit DB rollback/compensation
  - Implemented in: `tests/recruit.test.js`

### WS-02: P1 Architecture Convergence
Status: in_progress
- [ ] Move inline event handling to event factory modules consistently
  - Reference: `src/index.js`, `src/events/*.js`
- [ ] Standardize privileged command authorization through `ensureCommandAccess`
  - Reference: `src/lib/command-auth.js`, `src/commands/**`
- [ ] Decide and execute service/repo strategy:
  - adopt `src/services/**` + `src/repos/**` in live paths, or
  - remove dead layer to reduce drift

### WS-03: P2 Hardening
Status: in_progress
- [ ] Normalize runtime logging via AECS wrappers (reduce direct `console.*`)
- [ ] Reduce SQL scatter into repository layer with tests
- [ ] Burn down dependency vulnerabilities with staged upgrades and canary

## Acceptance Criteria (Stabilization Exit)
- Core flow verified end-to-end in staging:
  - recruit -> points -> leaderboard -> promotion -> status
- No P0 findings open
- P1 findings either fixed or converted into approved backlog with owners/dates
- Migration dry-run and restore drill completed on DB snapshot
- Alert thresholds defined for command failure, DB error, scheduler failure, anti-nuke anomaly

## Recommended PR Order
1. `[fix] event wiring convergence`
2. `[fix] command auth normalization`
3. `[refactor] anti-nuke/scheduler/recruiter module split`
4. `[chore] observability normalization (AECS routing + alerts)`
5. `[chore] dependency vulnerability burndown + canary validation`

## Rollback Notes
- App rollback: `git revert <commit>` then redeploy
- DB rollback: restore snapshot before migration batch
- Operational fallback: disable risky command path behind env flag if introduced
