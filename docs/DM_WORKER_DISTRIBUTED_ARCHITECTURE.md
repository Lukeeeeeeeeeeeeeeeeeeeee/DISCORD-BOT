# Distributed DM Worker Architecture (Design Spec)
Last updated: 2026-03-03
Status: design baseline locked, implementation changes not applied in this document

## 1. Objective
Design a distributed DM system where:
- `/dm` is controlled by the main bot only.
- Main bot does not send campaign DMs.
- 1 to 10 worker bots send campaign DMs.
- All bots share one queue and one DB.
- Routing uses user affinity and worker block history.
- War messages remain worker-sticky per user.
- Non-war messages rotate after streak limits.
- Multiple roles can be targeted in one campaign.
- Main bot posts final delivery reports with actionable failure detail.

## 2. Current State Snapshot
The codebase already includes:
- Queue schema in [`src/db_async.js`](../src/db_async.js): `dm_workers`, `dm_campaigns`, `dm_campaign_targets`, `dm_delivery_attempts`, `dm_user_affinity`, `dm_worker_user_blocks`.
- Main `/dm` control command in [`src/commands/dm.js`](../src/commands/dm.js) with `create`, `status`, `cancel`, `report`, `workers`.
- Worker selector logic in [`src/services/dm/dm-worker-selector.js`](../src/services/dm/dm-worker-selector.js) for:
  - 24h sticky for misc
  - rotate after streak cap
  - war sticky
  - block-aware worker filtering
- Worker runtime in [`src/services/dm/dm-worker.js`](../src/services/dm/dm-worker.js).
- Main-bot report posting in [`src/services/dm/dm-reporter.js`](../src/services/dm/dm-reporter.js).
- Runtime split in [`src/index.js`](../src/index.js) via `BOT_RUNTIME_MODE=main|dm_worker`.

Important gap to close:
- Worker runtime currently claims and sends with the claiming worker, but does not enforce selector-based reassignment before send. Affinity exists in design and helper functions, but routing enforcement is not fully wired.

## 3. Feasibility and DB Constraints
Yes, your target setup is possible.

SQLite constraint:
- Single-host, multi-process worker fleet: acceptable with WAL + busy_timeout.
- Multi-host distributed workers: not safe/reliable on one SQLite file.

Decision:
- Phase A: SQLite on one host, up to 10 workers.
- Phase B: migrate DM queue tables to Postgres before multi-host scale.

## 4. Runtime Topology
### 4.1 Main bot (control plane)
- Accepts `/dm` requests.
- Resolves targets and queues campaign rows.
- Performs no campaign `member.send()` calls.
- Posts campaign reports after completion.

### 4.2 Worker bots (data plane)
- Each worker has unique Discord token and `DM_WORKER_ID`.
- Polls and claims queued targets.
- Applies routing policy (affinity, streak, block fallback).
- Sends DM and records attempts.
- Heartbeats into `dm_workers`.

### 4.3 Required environment variables
- `BOT_RUNTIME_MODE=main|dm_worker`
- `DISCORD_TOKEN=<token for this process>`
- `DM_WORKER_ID=dmw01` (worker mode required)
- `DM_WORKER_DISPLAY_NAME=DM Worker 01`
- `DM_QUEUE_POLL_MS=1500`
- `DM_CLAIM_BATCH_SIZE=25`
- `DM_MIN_DELAY_MS=450`
- `DM_RETRY_LIMIT=2`
- `DM_HEARTBEAT_MS=15000`
- `DM_CLAIM_LEASE_MS=60000`

## 5. Message Types and Routing Rules
Supported campaign types:
- `misc`
- `war_early`
- `war_late`

Rules:
- War messages (`war_early`, `war_late`):
  - Use same `war_worker_id` for that user when eligible.
  - If unavailable/blocked, fallback to another eligible worker.
  - On successful fallback, update `war_worker_id` to the new worker.
- Misc messages:
  - If user was messaged by preferred worker within 24h, keep same worker.
  - If same worker hit 4 consecutive misc sends, rotate.
  - Rotation picks eligible worker using weighted LRU.

## 6. Targeting and Batching
Target modes:
- `everyone`
- `any_roles` (union)
- `all_roles` (intersection)

Multi-role support:
- Keep role list in `dm_campaigns.target_role_ids` JSON array.
- Deduplicate per campaign by unique `(campaign_id, user_id)`.

Batching:
- Default insertion batch size is 25 targets.
- Keep campaign queue split into many batches for worker fleet throughput.
- Optional future command setting: `batch_size` override with safe clamp (10-100).

## 7. Worker Selection and Enforcement
### 7.1 Eligibility set
Worker is eligible when:
- `enabled = 1`
- heartbeat is fresh (`last_seen_at >= now - stale_window`)
- worker is not blocked for `(guild_id, user_id)` in `dm_worker_user_blocks`

### 7.2 Enforcement model
To guarantee routing policy in runtime:
1. Worker claims target row.
2. Worker calculates selected worker via selector (`pickWorker(...)`).
3. If selected worker is self:
   - proceed send.
4. If selected worker is another worker:
   - release target back to `pending`
   - set `assigned_worker_id = selected_worker_id`
   - clear claim lease
   - do not send.
5. Claim query must allow:
   - rows with `assigned_worker_id IS NULL`
   - rows with `assigned_worker_id = self`.

This prevents wrong-worker sends and enforces affinity rules.

## 8. Block and Retry Policy
Error classification:
- `50007`: blocked or closed DMs
- `50001`, `50013`: missing access/perms
- HTTP/code `429`: rate limited
- network timeouts/reset: transient
- else: unknown failure

Handling:
- Block-like errors:
  - record `(guild_id, user_id, worker_id)` in block table
  - never retry same worker for that user
  - requeue for different worker
- If all eligible workers blocked:
  - mark target `undeliverable`
  - include user in replacement report section
- Retryable transient/rate limit:
  - backoff and retry within `DM_RETRY_LIMIT`
  - then mark failed

## 9. Campaign Lifecycle
Campaign statuses:
- `queued`, `running`, `completed`, `completed_with_errors`, `cancelled`, `failed`

Target statuses:
- `pending`, `claimed`, `sent`, `blocked`, `undeliverable`, `failed`, `cancelled`

Completion:
- Campaign completes when no targets remain in `pending|claimed`.
- If any terminal errors exist (`failed|undeliverable|blocked`) => `completed_with_errors`.

## 10. Reporting (Main Bot)
Main bot report includes:
- campaign metadata (id, type, requester, timing)
- totals (targeted, sent, blocked, undeliverable, failed, retries)
- per-worker breakdown
- list of users:
  - blocked
  - undeliverable (all workers exhausted)
  - failed after retries
- CSV attachment with per-user details for replacement workflow

Use case supported:
- Quickly identify users who cannot be DMd and need application replacement.

## 11. Slash Command Contract
### `/dm create`
- Inputs:
  - `message_type`
  - `message`
  - `target_mode`
  - role list (`role_1..role_n`)
  - `preview`
- Output:
  - queued target count
  - total batches
  - campaign id

### `/dm status`
- Campaign live counters and status totals.

### `/dm cancel`
- Cancels pending/claimed rows.

### `/dm report`
- Posts final report immediately.

### `/dm workers`
- List workers and heartbeat status.
- Recommended extension:
  - `enable`, `disable`, `set-weight`, `unblock-user`.

## 12. Schema and Index Baseline
Existing schema already contains required core tables and most columns.

Keep/ensure:
- `dm_campaigns.max_misc_streak`, `dm_campaigns.sticky_window_hours`, `dm_campaigns.strict_war_sticky`
- `dm_campaign_targets.claim_expires_at`, `dm_campaign_targets.worker_switches`
- index for pending claim scan and affinity lookup

Optional additions for operations:
- `dm_campaign_targets.last_routed_worker_id`
- `dm_campaign_targets.route_reason`

## 13. Operational Plan (Design)
### Stage 0: design freeze
- No behavior change deployment yet.
- Align team on routing enforcement model in section 7.

### Stage 1: canary implementation
- Enable 1 worker, run 50-100 target campaign.
- Validate no main-bot sends.
- Validate report accuracy.

### Stage 2: scale to 3 workers
- Validate affinity retention (24h rule).
- Validate rotation after 4 misc sends.
- Validate block reassignment.

### Stage 3: scale to 10 workers
- Monitor lock/contention.
- Track send throughput and failure ratio.

## 14. Acceptance Criteria for Your Requirement
Design is accepted only when all are true:
- Main bot only controls campaigns and reporting.
- Worker bots only perform DM delivery.
- Shared DB queue is single source of truth.
- Misc routing:
  - same worker within 24h
  - rotate after 4 consecutive sends
- War routing:
  - same worker unless unavailable/blocked
- Blocked users:
  - logged per worker
  - reassigned to different worker automatically
- Multi-role target campaign works in one command.
- Final report identifies blocked/undeliverable users and counts.

## 15. Open Decisions
1. Keep max role options at 5 or expand to 10?
2. Expire block records automatically (example: 30 days) or manual only?
3. Keep SQLite single-host for now or prioritize Postgres migration early?
4. Add worker management subcommands now or after routing enforcement lands?

## 16. Implementation Checklist (not executed in this design step)
1. Wire selector enforcement into worker send path (section 7.2).
2. Add command options if expanding multi-role beyond current max.
3. Add worker admin subcommands for operations.
4. Add integration tests:
   - war sticky
   - misc 24h sticky
   - misc rotate at streak 4
   - blocked worker fallback
   - all workers blocked => undeliverable
5. Run canary rollout with report validation.
