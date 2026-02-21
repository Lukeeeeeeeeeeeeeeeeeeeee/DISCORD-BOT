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
- Runtime default anti-nuke state file is local and ignored:
  - `src/data/antinuke_data.local.json`
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

## Backup/Recovery Hardening (2026-02-21)
- Backups now capture extended snapshot data:
  - Server metadata (name/settings/icon/banner)
  - Roles/channels/overwrites
  - Threads/forums metadata
  - Emojis/stickers
  - Ban list
  - Onboarding configuration
- Recovery supports cross-server clone-style restore:
  - Run `/emergency_recover source_guild_id:<SOURCE_GUILD_ID>` in target server.
- Dangerous anti-nuke commands are owner-only at execution time:
  - `/emergency_recover`
  - `/simulate_attack`
  - `/toggle_strict_mode`
  - `/toggle_aggressive_ban`
  - `/set_quarantine_options`
  - Whitelist add/remove remains owner-only.
- Added safety guard for backup/logging crash:
  - Prevents `Cannot read properties of undefined (reading 'cache')` when client cache is unavailable.

### Post-Deploy Checklist
- Set `ANTINUKE_OWNER_ID` (or `OWNER_ID`) to the bot owner user ID.
- Re-register slash commands after deploy (`src/register-commands.js`).
- Validate in staging:
  - `/force_backup` creates backup with expanded counts.
  - `/view_backups` shows threads/emojis/stickers/bans counts.
  - `/emergency_recover source_guild_id:<id>` works for owner and blocks non-owner.

## Remaining Follow-ups
- Resolve lint warnings:
  - `src/commands/recruiting/recruitment_report.js` (`resolveGuildId` unused)
  - `src/lib/weekly-recalculations.js` (`postRetentionToInviteChannels` unused)
