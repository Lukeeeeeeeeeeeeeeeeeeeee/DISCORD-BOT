# Stabilization Status (Post-Refactor)

Last updated: 2026-02-14

Phase 0 - Immediate Safety
- [x] Feature freeze communicated.
- [x] Hotfix branch created locally (`hotfix/stabilise`).
- [x] Verbose logging toggle added (`VERBOSE_LOGGING`).
- [x] Local tests passing (`npm test -- --runInBand`).
- [x] Command verification passing (`node scripts/verify_commands.js`).
- [ ] CI green on latest commit (pending after push).

Phase 1 - Triage and Prioritise
- [x] Local failure logs collected (`error.log`, `failures.txt`, `final_test_results.txt`, `jest_failures.txt`, `verify_output.txt`).
- [x] Initial triage items recorded in `docs/MEGA_AUDIT_TRACKER_CODEX.md`.
- [ ] Reproduced each failure in staging (not prod).
- [ ] P0/P1 items assigned in a tracking board.

Phase 2 - Stabilise Critical Flows
- [x] Migration view rebuild issue fixed in `2026-02-07-guild-columns`.
- [x] Leaderboard message upsert edits by ID and suppresses mentions to prevent spam.
- [x] Leaderboard message creation race fixed with pending-owner upsert flow (prevents duplicate posts on concurrent refreshes).
- [x] DB schema bootstrap serialized with cross-process lock (prevents concurrent migration races on multi-process starts).
- [x] Migration failures now fail fast by default outside tests (`DB_MIGRATION_STRICT`) to avoid partial-schema runtime.
- [x] Recruit command failure path now returns schema/lock/permission-specific errors instead of generic fallback.
- [x] i18n locale loading switched to async preload with startup initialization (no sync locale read on command path).
- [x] Recruiter insert triggers are self-healed on startup to recover from partial migration states.
- [x] Recruitment report now preloads per-recruiter weekly averages in batched queries (reduces per-member DB query storms).
- [x] Emergency recovery channel restore now runs in bounded batches with safe error-path channel ID handling.
- [x] Shared concurrency runner now preserves deterministic result ordering across report/scheduler/member-fetch batch tasks.
- [x] Recruit command fallback errors now include per-request trace IDs for production triage.
- [x] Recruit flow now stages DB row as pending, applies Discord changes, then finalizes points/validity (with cleanup on failure).
- [x] Role-item purchases now reserve points first and auto-refund on role grant persistence failures.
- [x] Scheduler quota warning enforcement now uses bounded concurrency to reduce sequential API storms.
- [x] Weekly invalid-recruit cleanup now batches DB updates instead of per-row writes.
- [x] Scheduler startup now hard-gates on configured `GUILD_ID` to prevent accidental duplicate cron execution.
- [x] Invite attribution now uses a lightweight DB lock bucket to reduce cross-shard/process misattribution races.
- [x] Runtime singleton setters now ignore null/undefined overwrite attempts to prevent accidental global state nullification.
- [x] Shutdown path now explicitly clears runtime singleton handles after DB flush/close.
- [x] Recruit policy now supports admin-only late-join override to prevent permanent unrecruitable states after downtime.
- [x] 7-day retention calculation now applies a capped cohort size to avoid uncapped member fetch pressure in large guilds.
- [x] Leaderboard and warning-board recruiter enrichment now use bounded concurrency to reduce sequential DB/API stalls.
- [x] Region leaderboard recomputation now uses bounded concurrency instead of strict sequential region loops.
- [x] Absence upsert now merges overlapping historical windows instead of creating fragmented records.
- [x] Hardcoded `TESTING_USER_ID` constant removed from runtime config surface.
- [x] Scheduler startup now reconciles stale pending recruits (`valid=0`) to clean/finalize half-migrated recruit states.
- [x] Emergency recovery now has a per-guild in-flight lock to prevent duplicate concurrent restores.
- [x] Leaderboard upsert distributed lock now fail-closes on lock uncertainty to avoid duplicate posts.
- [x] Leaderboard message pointer persistence now logs DB write failures instead of silently swallowing them.
- [x] Join invite attribution path now reuses cached invite system state instead of re-initializing per join.
- [x] Anti-nuke rollback owner validation now supports owner fallback semantics through anti-nuke owner checks.
- [x] Voice state analytics path now runs through a hardened handler with non-fatal error capture and traceable event telemetry (prevents shard crash on voice analytics exceptions).
- [x] Anti-nuke audit lookup now uses adaptive fetch depth + 429-aware retry and dedupes audit-driven ban/kick tracking across audit event and gateway event paths.
- [x] Anti-nuke whitelist now supports per-guild scoping and emergency bypass semantics aligned with `emergencyForceProtect` (removes cross-guild whitelist bleed risk).
- [x] Rookie points increments now use atomic DB updates, nickname parsing rejects scientific notation, and read-path no longer seeds DB state from nickname strings.
- [x] Rookie war log flow now requires structured evidence, writes with `guild_id`, and returns explicit cap feedback when the per-window limit is reached.
- [x] Concurrency utility now preserves input ordering and captures worker failures without reordering outputs.
- [x] Runtime singleton test hooks restored (`resetForTests`, explicit clear methods) and null/undefined overwrite attempts are ignored.
- [x] Legacy multiplier table compatibility restored for schemas without `guild_id` column.
- [x] Compatibility shim restored for legacy loader path `src/commands/recruiter.js` (fixes syntax/load failure in tooling expecting old command path).
- [x] Rookie promotion role mutation now uses granular `roles.remove` + `roles.add` by default (avoids destructive `roles.set` wiping unrelated custom roles).
- [x] Anti-nuke rollback history now enforces TTL/max-action pruning with bounded guild retention and atomic temp-file swap persistence (reduces stale state growth and JSON corruption risk).
- [x] Permission checks now share centralized elevated-permission and role-match helpers (removes duplicated decision logic across admin/staff paths).
- [x] i18n now preloads locale files asynchronously on startup (`preloadLocales`) with cached runtime access and sync fallback.
- [x] Message-layer dynamic i18n requires removed and leaderboard pointer update failures are now logged instead of silently swallowed.
- [x] Analytics flush path now emits slow-flush telemetry and caps requeue accounting after failed flushes to avoid unbounded pending growth.
- [x] Shared command auth preflight helper added (`src/lib/command-auth.js`) and applied to high-risk admin commands for consistent fail-close replies and optional role-hierarchy enforcement.
- [x] Anti-nuke rollback integration now records dynamic `actionType` tokens (`rapid_*`, `beast_mode`) with shard metadata and multi-shard integration coverage.
- [x] Analytics role-change ingestion moved to buffered transactional queue with adaptive batch sizing and configurable flush windows.
- [x] Retention computation now deduplicates recruits with `Set` semantics and short-TTL memoization to reduce repeated channel scans.
- [x] Recruits hot-path indexes added (`idx_recruits_guild_recruiter_valid_created`, `idx_recruits_guild_valid_created`, `idx_recruits_recruited_valid`) plus `EXPLAIN` verifier script (`npm run db:verify-indexes`).
- [x] Synthetic analytics stress gate added (`npm run test:synthetic:analytics`) to validate queue flush behavior and event-loop lag under burst load.
- [x] Local SQLite integrity incident recovered by restoring `data/recruiter.db` from `data/recruiter.db.bak`; corrupted snapshot preserved as `data/recruiter.db.corrupt-20260214-141534`.
- [x] Local quality gates are green (`npm test -- --runInBand`, `node scripts/verify_commands.js`, `npm run lint` with warnings only).
- [ ] Antinuke event simulation in staging (role/channel delete).
- [ ] Recruit flow end-to-end staging validation.
- [ ] Leaderboard initialization check in staging.
- [ ] Scheduler job validation in staging (no double-run).
- [ ] Permissions edge-case checks in staging.

Phase 3 - Harden and Automate
- [x] CI gates include tests, lint, and `verify_commands`.
- [x] Health check endpoint added (set `HEALTHCHECK_PORT`).
- [x] Migration dry-run helper added (`npm run migration:dry`).
- [x] Recruits index-plan verification helper added (`npm run db:verify-indexes`).
- [x] Command registration deployment lock + robust token sanitization added (`src/register-commands.js`).
- [x] DB backup snapshot and restore drill completed (`npm run backup:drill`).
- [x] Local log rotation guard added for oversized operational logs (`LOG_ROTATE_MAX_BYTES`, `LOG_ROTATE_KEEP`).
- [ ] Canary rollout completed with monitoring and alerts.
- [ ] Rollback drill executed.

Phase 4 - Clean-up and Documentation
- [x] Stabilization notes captured in `docs/MEGA_AUDIT_TRACKER_CODEX.md`.
- [x] Post-mortem doc completed (`docs/postmortem_refactor.md`).
- [x] Recruiter command refactor (file >600 lines) - split into handlers/helpers.
- [x] Additional stabilization/integration regression tests added (invite cooldown scope, anti-nuke audit scope, rookie war cap/matching, transaction + legacy schema safety).
