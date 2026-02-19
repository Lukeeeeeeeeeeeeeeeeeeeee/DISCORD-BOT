# Stabilization Tracker

## Scope
- Stabilize command loading after refactor drift.
- Ensure CI/deploy gates block regressions.
- Keep mutable anti-nuke state out of test/smoke runs.

## Active Gates
- `npm run stability:check`
  - `npm run lint`
  - `npm run verify:commands`
  - `npm test -- --runInBand`
  - `npm run require-walk`

## Command Loading Guardrails
- Shared loader: `src/lib/command-loader.js`
- Runtime uses shared loader: `src/index.js`
- Verification script uses shared loader: `scripts/verify_commands.js`
- Proxy shim skip + duplicate detection covered by tests:
  - `tests/command_loader.test.js`

## CI/Deploy Enforcement
- CI workflow runs `npm run stability:check`:
  - `.github/workflows/test.yml`
- Deploy workflow runs predeploy stability checks:
  - `.github/workflows/deploy.yml`

## Test/Smoke State Isolation
- Anti-nuke supports override file path via `ANTINUKE_DATA_FILE`:
  - `src/lib/antinuke.js`
- Jest sets temp anti-nuke state file:
  - `tests/setup-env.js`
  - `package.json` (`jest.setupFiles`)
- Require-walk sets temp anti-nuke state file:
  - `scripts/require-walk.js`

## Operational Notes
- `src/data/antinuke_data.json` must remain valid JSON.
- SQLite sidecar files ignored in git:
  - `.gitignore` includes `*.db-wal`, `*.db-shm`.
- PR template enforces rollback/testing checklist:
  - `.github/pull_request_template.md`

## Remaining Follow-ups
- Resolve lint warnings:
  - `src/commands/recruiting/recruitment_report.js` (`resolveGuildId` unused)
  - `src/lib/weekly-recalculations.js` (`postRetentionToInviteChannels` unused)
