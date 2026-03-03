# Stabilization Tracker (Codex)
Last Updated: 2026-02-28
Primary Audit: `docs/BOT_FULL_AUDIT.md`

Recent Stabilization Commits:
- `7232c8d` - `hotfix: restore AECS telemetry routing and stabilize anti-nuke/recruit flows`
- `1035d12` - `hotfix: reduce AECS threshold and suppress anti-nuke DM spam`

## Current Gate Status
Validated locally on 2026-02-28:
- `npm run stability:check` -> pass
- `npm run lint` -> pass (0 errors, 8 warnings)
- `node scripts/verify_commands.js` -> pass (30 commands loaded)
- `npm test -- --runInBand` -> pass (60 suites / 172 tests)
- `node scripts/require-walk.js` -> pass (133 modules)
- `npm run migration:dry` -> pass (last known run on 2026-02-26; rerun required before next prod schema change)
- `npm audit --json` -> 14 vulnerabilities (8 moderate, 6 high) (open)

## Phase Status
- Phase 0 (Immediate Safety): complete
- Phase 1 (Triage & Prioritise): complete (board below)
- Phase 2 (Critical Flow Stabilization): in progress, P0 closed, selected P1 closed
- Phase 3 (CI/Monitoring/Deploy Safety): in progress
- Phase 4 (Cleanup/Docs): in progress

## Triage Board (Current)
Owner model: single-dev execution (Lead/DB/QA/Ops combined)

| ID | Title | Steps to Reproduce | Expected | Actual | Severity | Owner | Status |
|---|---|---|---|---|---|---|---|
| TRIAGE-P0-001 | AECS telemetry channel not receiving events | Set log channel, trigger AECS event in production | Event delivered to configured channel/webhook | No channel output despite config | P0 | Lead Dev | Fixed (`7232c8d`) |
| TRIAGE-P0-002 | Anti-nuke backup notifications caused DM flood | Leave anti-nuke backups running with default config | Backup system runs without owner DM spam | Hourly incremental backup messages DM owner repeatedly | P0 | Lead Dev | Fixed (`1035d12`) |
| TRIAGE-P1-001 | `/recruit` cannot credit recruit to alternate recruiter | Recruit performed by staff on behalf of recruiter | Optional explicit credited recruiter supported | Points always credited to caller | P1 | Lead Dev | Fixed (`7232c8d`) |
| TRIAGE-P1-002 | `/set_log_channel` accepted channels without bot send permissions | Configure channel lacking bot embed/send access | Command rejects invalid target with clear error | Configuration accepted; downstream logs silently fail | P1 | Lead Dev | Fixed (`7232c8d`) |
| TRIAGE-P2-001 | Lint warnings duplicated due nested workspace mirror (`DISCORD-BOT/`) | Run lint from repo root | Single-path lint output | Duplicate warnings from mirrored path | P2 | Lead Dev | Open |
| TRIAGE-P2-002 | Runtime warning noise for missing owner/encryption env in tests/non-prod | Run full stability gate in clean local env | Warnings only when materially actionable | Repeated warning noise in test logs | P2 | Lead Dev | Open |
| TRIAGE-P2-003 | Dependency vulnerability backlog | Run `npm audit --json` | Zero known moderate/high vulns | 14 outstanding vulns (8 moderate, 6 high) | P2 | Lead Dev | Open |

## Critical Flow Checkpoint
- Recruit flow: stabilized (transaction + rollback + optional recruiter crediting)
- Points + leaderboard update chain: stabilized (tests passing)
- Promotion/status command paths: passing in gate tests
- Anti-nuke: critical routing and spam behavior stabilized; further modularization pending
- Scheduler/background jobs: lock protections are in place; canary verification still required

## Active Workstreams

### WS-01: P0 Reliability
Status: complete
- [x] AECS telemetry provisioning/routing hardening
- [x] Anti-nuke backup DM spam suppression by default
- [x] Recruit attribution flexibility for staff workflows

### WS-02: P1 Architecture Convergence
Status: in progress
- [ ] Move inline event handlers in `src/index.js` to event-factory modules consistently
- [ ] Standardize privileged command authorization via `ensureCommandAccess`
- [ ] Finalize service/repo strategy for runtime command paths

### WS-03: P2 Hardening
Status: in progress
- [ ] Reduce direct `console.*` usage in runtime paths where AECS/log wrappers exist
- [ ] Resolve lint duplication from nested workspace mirror
- [ ] Address dependency vulnerability backlog with staged upgrades

## Next Deployment Checklist (Canary)
1. Confirm production env includes:
   - `OWNER_ID`
   - `ANTINUKE_OWNER_ID` / `ANTINUKE_LOG_DM_ID` (if DM mode enabled)
   - `ANTINUKE_ENCRYPTION_KEY`
   - `AECS_TELEMETRY_CHANNEL_ID` or webhook envs
2. Restart one canary guild bot instance.
3. Verify within first hour:
   - AECS event appears in configured channel
   - Backup cycle does not DM spam by default
   - `/recruit` with `credit_to` credits correct recruiter
   - `/set_log_channel` rejects channels without send/embed perms
4. Observe 24h metrics:
   - command failure rate
   - DB errors
   - scheduler failures/duplicates
   - anti-nuke trigger anomalies

## Rollback Notes
- Quick app rollback:
  - `git revert 1035d12`
  - `git revert 7232c8d`
  - redeploy
- DB rollback:
  - restore snapshot taken before migration batch
- Operational fallback:
  - keep `ANTINUKE_LOG_DM_MODE=off` and `ANTINUKE_LOG_AUTOMATIC_BACKUPS=false` until canary confidence is met
