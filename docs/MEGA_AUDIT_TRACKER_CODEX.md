# Mega Audit Tracker (Codex Expanded - Cross-Repo)

Status: Tracking only (no fixes in this document).
Last updated: 2026-02-07

## Scope
- Local snapshot: code in this repo as of 2026-02-07.
- External repo: the bot is hosted in another GitHub location; items labeled External need verification there.
- Exclusions: .env and environment-variable management are intentionally out of scope.

## Severity Legend
- Critical: Security/data loss risk or systemic failure with immediate impact.
- High: High-likelihood failures or major correctness gaps.
- Medium: Performance, reliability, or consistency risks that can degrade over time.
- Low: Maintainability, UX, or minor correctness issues.

## Summary (Approximate)
- Local snapshot: Critical 9 | High 30 | Medium 36 | Low 26 (101 total).
- External repo (needs verification): Critical 4 | High 8 | Medium 8 | Low 4 (24 total).
- Total approx: 125.

## Findings (Local Snapshot)

### Critical
1) C-01 Global whitelist is shared across all guilds; a user whitelisted in one guild becomes whitelisted everywhere. Files: `src/lib/antinuke.js`.
2) C-02 Anti-nuke confirmation/DM fallback is hard-coded to a specific user ID, risking log leakage or failure outside that environment. Files: `src/lib/antinuke.js`.
3) C-03 Invite system tables have no `guild_id`, so invites and cooldowns collide across guilds for the same recruiter. Files: `src/lib/create-invite-tables.js`, `src/lib/invite-system.js`.
4) C-04 Invite cooldowns are in-memory only; a restart clears cooldown and allows bypass. Files: `src/lib/invite-system.js`.
5) C-05 Anti-nuke state defaults to per-process Maps and file backend; multi-instance/sharded deployments will diverge. Files: `src/lib/antinuke.js`, `src/lib/antinuke-system.js`.
6) C-06 Rollback data is stored on disk with role/channel metadata and no retention cap. Files: `src/lib/antinuke-rollback.js`.
7) C-07 Rollback integration records rapid/beast-mode actions as `ban` regardless of the actual action type, so rollback cannot reliably restore non-ban actions. Files: `src/lib/antinuke-system.js`.
8) C-08 Anti-nuke backups rely on cache-only role/channel data; incomplete caches produce incomplete backups and partial recovery. Files: `src/lib/antinuke.js`.
9) C-09 Core recruiting/economy tables lack `guild_id`; multi-guild deployments mix data across servers. Files: `src/db_async.js`.

### High
1) H-01 Anti-nuke backups omit channel metadata (topic, slowmode, nsfw) and role icons/emoji; recovery is not faithful. Files: `src/lib/antinuke.js`.
2) H-02 Anti-nuke log history is kept only in memory; export logs lose history after restart. Files: `src/lib/antinuke.js`, `src/commands/export_logs.js`.
3) H-03 Backup and rollback JSON writes are not file-locked; concurrent writes can corrupt state files. Files: `src/lib/antinuke.js`, `src/lib/antinuke-rollback.js`.
4) H-04 Audit log attribution uses small fetch limits and minimal filtering; high-volume events can misattribute executors. Files: `src/lib/antinuke.js`.
5) H-05 Invite creation chooses the first channel with invite permission, which can expose invites from sensitive channels. Files: `src/lib/invite-system.js`.
6) H-06 Invite system singleton is global and not guild-scoped; recruiter activity across multiple guilds collides in memory. Files: `src/lib/invite-system.js`.
7) H-07 `/recruiter buy` charges points before attempting role grants; role grant failure leaves users charged without the role. Files: `src/commands/recruiter.js`.
8) H-08 Economy role grants do not verify bot role hierarchy or `ManageRoles` permissions before spending points. Files: `src/commands/recruiter.js`.
9) H-09 `member.roles.set` during promotions can drop roles if cache is incomplete or roles change concurrently. Files: `src/lib/promote.js`.
10) H-10 Recruit flows use sequential `guild.members.fetch` loops, risking rate limits in large guilds. Files: `src/commands/recruit.js`, `src/commands/recruiter.js`.
11) H-11 `calculate7DayStats` falls back to per-member fetch when bulk fetch fails, leading to heavy API usage. Files: `src/lib/recruiting-system.js`.
12) H-12 `/dm` can full-fetch all members when enabled, causing large memory use and API load. Files: `src/commands/dm.js`.
13) H-13 `/dm` background job is fire-and-forget with no persistence; restarts lose progress and status. Files: `src/commands/dm.js`.
14) H-14 Weekly snapshot/recompute runs without a distributed lock; multiple instances can double-run. Files: `src/scheduler.js`.
15) H-15 Weekly recalculation relies on cached role membership; if cache is cold and full fetch is disabled, results are incomplete. Files: `src/lib/weekly-recalculations.js`, `src/scheduler.js`.
16) H-16 Member fetch helper has no rate-limit backoff and does not retry on 429 errors. Files: `src/lib/member-fetch.js`.
17) H-17 Anti-nuke bulk role changes and backup creation are sequential; large guilds risk global rate-limit lockouts. Files: `src/lib/antinuke.js`.
18) H-18 Anti-nuke backups store permission bitfields as strings and restore without validation, risking mismatches on restore. Files: `src/lib/antinuke.js`.
19) H-19 Analytics flush drains buffers before DB writes; if a flush fails, buffered data is lost. Files: `src/lib/analytics.js`.
20) H-20 Analytics writes unique speaker rows per user per channel without batching; large guilds can lock the DB. Files: `src/lib/analytics.js`.
21) H-21 Member leave/revoke actions trigger full leaderboard recompute per event, creating heavy load bursts. Files: `src/lib/memberLeave.js`, `src/commands/revoke-recruit.js`, `src/scheduler.js`.
22) H-22 Recruitment report loops per recruiter and can exceed interaction timing even with a deferred reply on large datasets. Files: `src/commands/recruitment_report.js`.
23) H-23 Recruit flow updates roles/nicknames and DB separately; partial failures can leave mismatched state. Files: `src/commands/recruit.js`.
24) H-24 Recruit flow deletes invalid prior recruits before inserting, losing audit history and risking partial loss on failure. Files: `src/commands/recruit.js`.
25) H-25 Trial fast-track uses `INSERT OR REPLACE` with multiple updates; concurrent recruits can reset progress. Files: `src/commands/recruit.js`.
26) H-26 Promotion records verification even if role updates or nickname changes fail; verified state without roles. Files: `src/lib/promote.js`.
27) H-27 Invite channel selection uses `guild.members.me` without a null guard; invite creation can throw on cold cache. Files: `src/lib/invite-system.js`.
28) H-28 Economy purchases allow items whose role IDs are missing; points are spent with no effect. Files: `src/commands/recruiter.js`, `src/constants.js`.
29) H-29 Points updates are not isolated from concurrent purchases/earnings across processes; double-spend or drift risk. Files: `src/commands/recruiter.js`, `src/commands/recruit.js`, `src/lib/memberLeave.js`.
30) H-30 Role-change analytics writes are immediate with no queueing; burst role changes can saturate the DB. Files: `src/index.js`, `src/lib/analytics.js`.

### Medium
1) M-01 Schema changes use best-effort `ALTER TABLE` without migration gating; hosts can end up on inconsistent schemas. Files: `src/db_async.js`.
2) M-02 Tables do not define foreign keys; referential integrity is not enforced. Files: `src/db_async.js`.
3) M-03 Key query paths are missing indices (example: recruits recruiter_id + created_at), leading to full scans. Files: `src/db_async.js`, `src/lib/leaderboard-utils.js`.
4) M-04 Analytics `recordJoin`/`recordLeave` perform multi-statement updates without transactions; partial updates possible on crash. Files: `src/lib/analytics.js`.
5) M-05 Analytics `recordRoleChange` writes immediately to DB with no buffering; high-volume role changes can spike DB I/O. Files: `src/lib/analytics.js`.
6) M-06 Recruit flow does not check bot `ManageRoles`/`ManageNicknames` before attempting role/nickname updates; failures can leave partial state. Files: `src/commands/recruit.js`.
7) M-07 Recruit join-time cutoff and account-age requirements are hard-coded; no config override. Files: `src/commands/recruit.js`.
8) M-08 Recruiter info embed uses unbounded warning/flag text; can exceed embed field limits and fail to send. Files: `src/commands/recruiter.js`.
9) M-09 Recruiter info embed can exceed the 6000-char total embed limit with multiple fields. Files: `src/commands/recruiter.js`.
10) M-10 Recruitment report percentiles are unstable on small samples and may misclassify staff in low-activity windows. Files: `src/commands/recruitment_report.js`.
11) M-11 Recruitment report truncates output to 24 fields; results beyond that are silently dropped. Files: `src/commands/recruitment_report.js`.
12) M-12 Leaderboard SQL uses large `VALUES` clauses; for large recruiter sets the SQL size can hit SQLite limits. Files: `src/lib/leaderboard-utils.js`.
13) M-13 Invite command logs invite codes to console; operational logs can leak sensitive invite data. Files: `src/commands/invite.js`.
14) M-14 Invite system does not persist `activeInvites` usage counts across restart; in-memory state can desync from DB. Files: `src/lib/invite-system.js`.
15) M-15 Invite system cleanup deletes used invites after 7 days; no configuration or audit retention. Files: `src/lib/invite-system.js`.
16) M-16 Snapshot persistence for invite attribution uses TTL; when TTL expires, attribution accuracy drops. Files: `src/index.js`.
17) M-17 Anti-nuke backup pruning is count-based only; no size-based limit; disk usage can grow. Files: `src/lib/antinuke.js`.
18) M-18 Anti-nuke log history is not persisted to DB; audit trail is incomplete. Files: `src/lib/antinuke.js`.
19) M-19 Scheduler `primeMemberCache` uses memberCount to decide full fetch; stale counts can cause unbounded fetch. Files: `src/scheduler.js`.
20) M-20 Scheduler `FORCE_FULL_FETCH_ON_EMPTY` defaults to true; on large guilds with cold cache this can still trigger large fetches when `memberCount` is below threshold. Files: `src/scheduler.js`.
21) M-21 Member fetch helper does not report missing IDs; downstream logic may assume missing = left. Files: `src/lib/member-fetch.js`.
22) M-22 Retention computation uses `recruitedIds.includes` within message loops (O(n^2)); expensive on large cohorts. Files: `src/lib/economy.js`.
23) M-23 Retention computation returns `null` on permission errors but callers may treat it as a number. Files: `src/lib/economy.js`.
24) M-24 Rookie points getter writes to DB during reads, creating hidden write side-effects. Files: `src/lib/rookie-points.js`.
25) M-25 Rookie nickname parsing accepts scientific notation (example: `1e5`), which can set unexpected points. Files: `src/lib/rookie-points.js`.
26) M-26 Team inference depends on role caches; if roles are missing or renamed, promotion can assign wrong team. Files: `src/lib/promote.js`.
27) M-27 Absence table has no unique constraint on active absences; concurrent updates can create duplicate actives. Files: `src/commands/absent.js`, `src/db_async.js`.
28) M-28 Warning and absence DMs are best-effort only; failures are not persisted for review. Files: `src/commands/recruiter.js`, `src/lib/weekly-recalculations.js`.
29) M-29 Status command scans backups directory without limit; many files can slow response. Files: `src/commands/status.js`.
30) M-30 Auto command registration runs on startup without a rate-limit guard; repeated restarts can hit API limits. Files: `src/index.js`, `src/register-commands.js`.
31) M-31 Absence date validation uses local time while DB checks use SQLite UTC; off-by-one day risk. Files: `src/commands/absent.js`, `src/lib/weekly-recalculations.js`.
32) M-32 Recruiter points are updated in multiple flows without a single ledger; drift requires manual recompute. Files: `src/commands/recruit.js`, `src/commands/recruiter.js`, `src/commands/revoke-recruit.js`, `src/lib/memberLeave.js`, `scripts/recalculate-points.js`.
33) M-33 IGN/nickname length is not validated; Discord nickname limits can fail after DB writes. Files: `src/commands/recruit.js`.
34) M-34 Invite attribution snapshot persistence performs per-join DB writes per invite; large invite sets can create DB hot spots. Files: `src/index.js`, `src/db_async.js`.
35) M-35 Leaderboard and report code recompute minReq and stats per recruiter with repeated DB calls; heavy on large datasets. Files: `src/commands/leaderboard.js`, `src/commands/recruitment_report.js`, `src/lib/recruiting-system.js`.
36) M-36 Leaderboard upsert ignores DB insert/update failures; message pointers can drift or duplicate. Files: `src/lib/messages.js`.

### Low
1) L-01 `replyError` defaults to public responses unless callers pass flags; admin errors can leak in public channels. Files: `src/lib/embeds.js`.
2) L-02 Logging is inconsistent (mix of console.log/warn/error) with no structured log levels. Files: `src/**/*.js`.
3) L-03 Many commands re-fetch members even when `interaction.member` is already present, causing extra API calls. Files: `src/commands/recruit.js`, `src/commands/recruiter.js`.
4) L-04 `register-commands.js` choice list can exceed Discord's 25-choice limit if multipliers/items grow. Files: `src/register-commands.js`.
5) L-05 Slash command choices are built at boot; changes to economy config require command re-register. Files: `src/register-commands.js`.
6) L-06 Command responses mix ephemeral and public modes without a shared convention. Files: `src/commands/*.js`.
7) L-07 `dm` preview returns only the first 10 recipients; no paging or export. Files: `src/commands/dm.js`.
8) L-08 `TESTING_USER_ID` returns infinite points in `/recruiter info`; misconfig leaks incorrect production display. Files: `src/commands/recruiter.js`, `src/constants.js`.
9) L-09 Anti-nuke thresholds are hard-coded; tuning requires code changes. Files: `src/lib/antinuke.js`.
10) L-10 Economy min-req formula uses hard-coded bounds (2..8); no per-guild config. Files: `src/lib/economy.js`.
11) L-11 Region and role IDs are duplicated across modules; rebranding requires multiple updates. Files: `src/constants.js`, `src/lib/regions.js`, `src/commands/recruit.js`.
12) L-12 Interaction error logs lack correlation IDs; tracing related errors is harder. Files: `src/commands/*.js`.
13) L-13 Inconsistent timezone formatting across embeds; some use UTC strings, some relative timestamps. Files: `src/lib/time.js`, `src/commands/*.js`.
14) L-14 `status` command pulls DB size by stat; slow on remote/mounted storage. Files: `src/commands/status.js`.
15) L-15 `inviteSnapshots` TTL is fixed default; no per-guild override. Files: `src/index.js`.
16) L-16 Several commands use repeated `require` calls inside handlers; increases cold-path latency. Files: `src/commands/*.js`.
17) L-17 Some embeds include long IDs and fields without clamping, risking Discord reject errors in edge cases. Files: `src/commands/recruiter.js`, `src/commands/recruitment_report.js`.
18) L-18 No explicit command usage metrics for admin-only flows; analytics coverage is partial. Files: `src/lib/analytics.js`, `src/index.js`.
19) L-19 Anti-nuke state persistence uses JSON stringify of Maps; large states can block the event loop during save. Files: `src/lib/antinuke.js`.
20) L-20 Leaderboard text truncation hides tail entries with no paging. Files: `src/lib/messages.js`.
21) L-21 Status command does not surface recent integrity/health checks; operators lack quick health snapshot. Files: `src/commands/status.js`.
22) L-22 Console logging lacks timestamps/structure; correlation across processes is hard. Files: `src/**/*.js`.
23) L-23 Error responses do not include error codes; support triage requires log digging. Files: `src/lib/embeds.js`.
24) L-24 DM audit channel is hard-wired to the invites channel; no per-command config. Files: `src/commands/dm.js`, `src/constants.js`.
25) L-25 `formatPointsValue` omits thousands separators; large values are hard to scan. Files: `src/lib/economy.js`.
26) L-26 Documentation lacks a disaster-recovery runbook (backup, restore, rollback). Files: `README.md`.

## External Repo Audit Checklist (Needs Verification)

### Critical
1) X-C01 Secrets or tokens could leak via CI/CD logs or artifacts; verify secret redaction in workflows. Paths: external repo (TBD).
2) X-C02 Production DB backups may not be restore-tested; verify end-to-end restore drills. Paths: external repo (TBD).
3) X-C03 Any web/admin panel must enforce strong auth and RBAC; verify MFA and least-privilege. Paths: external repo (TBD).
4) X-C04 Multi-instance/sharded deployment must share security state (anti-nuke, whitelist, cooldowns); verify shared backend. Paths: external repo (TBD).

### High
1) X-H01 Deployment pipeline may allow auto-deploy from unprotected branches; verify branch protections. Paths: external repo (TBD).
2) X-H02 Supply-chain hardening: lockfiles, checksum verification, and pinned versions should be enforced. Paths: external repo (TBD).
3) X-H03 Container/runtime hardening: non-root user, read-only FS, and minimal permissions. Paths: external repo (TBD).
4) X-H04 Centralized logging/alerting may be missing; verify retention and access controls. Paths: external repo (TBD).
5) X-H05 Database migrations may be manual; verify automated, reversible migration strategy. Paths: external repo (TBD).
6) X-H06 Rate-limit and load testing coverage may be absent; verify stress tests for weekly jobs. Paths: external repo (TBD).
7) X-H07 Backup rotation/retention policy may be missing; verify storage lifecycle rules. Paths: external repo (TBD).
8) X-H08 Access to production Discord bot token should be audited and rotated regularly. Paths: external repo (TBD).

### Medium
1) X-M01 Monitoring and health checks might not include shard health and job lag. Paths: external repo (TBD).
2) X-M02 Command registration strategy (global vs guild) may drift across environments. Paths: external repo (TBD).
3) X-M03 Webhook endpoints (if any) should enforce auth, replay protection, and rate limits. Paths: external repo (TBD).
4) X-M04 Metrics for anti-nuke triggers and quarantine actions may not be captured. Paths: external repo (TBD).
5) X-M05 Staging vs production config drift may cause inconsistent behavior; verify config parity. Paths: external repo (TBD).
6) X-M06 Incident response procedures for anti-nuke false positives may be undocumented. Paths: external repo (TBD).
7) X-M07 Log redaction for user PII and invite URLs should be verified. Paths: external repo (TBD).
8) X-M08 Dependency vulnerability scanning may be missing in CI. Paths: external repo (TBD).

### Low
1) X-L01 Operator docs and onboarding guides may be out of date. Paths: external repo (TBD).
2) X-L02 Release notes/changelog practices may be missing. Paths: external repo (TBD).
3) X-L03 Linting/formatting enforcement in CI may be absent. Paths: external repo (TBD).
4) X-L04 SLOs and alert thresholds may be undefined. Paths: external repo (TBD).

## Verification Notes (future)
- Validate cross-guild data isolation for recruits, economy, and rookie tables.
- Load-test weekly snapshot + leaderboards under large datasets.
- Validate backup/restore completeness against role/channel metadata.
- Confirm external repo hardening items (CI/CD, secrets, monitoring, backups).
