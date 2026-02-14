# MEGA AUDIT TRACKER (Consolidated Audit Phase)

This document tracks all bugs, architectural flaws, system stability risks, and performance bottlenecks identified during the **Exhaustive Audit Phase (Rounds 2-5)**.

---

## 🛑 Critical Issues
- `invite-system.js`: **Sharding-Unsafe Invite State**: Active invites and cooldowns are tracked in-memory (`this.activeInvites`). A user can create duplicate invites if their requests hit different shards, as Shard B won't know about Shard A's in-memory "Active" link (line 9).
- `leaderboard-service.js`: **Shard-Level API Thrashing**: The full-member fetch cooldown is per-shard. A cold start in a multi-shard cluster can trigger simultaneous full-member fetches (millions of members), leading to IP bans from Discord (line 10).
- `index.js`: **Trace ID Collisions**: Trace IDs use `Date.now().toString(36)`. Across multiple shards under high load, colliding IDs will make recruitment logs unusable for debugging (index.js:25).
- `index.js`: **Permanent Invite-Tracking Deadlock**: `inviteTrackLocks` uses an unbounded promise chain. If a database call or Discord API fetch hangs, all subsequent join-processing for that guild is permanently blocked until restart (index.js:534).
- `promote.js`: **Silent Attribution Failure**: The verification recorder swallows `db.get` errors when looking up the recruiter ID. If the database is busy, the verification is recorded as "Anonymous," permanently breaking recruitment stats and rewards for that staff member (promote.js:113).
- `db_async.js`: **Atomicity Risk in DDL Migrations**: Large migrations drop and recreate triggers/views. If interrupted, the database may lose its integrity triggers permanently (db_async.js:781).
- `economy.js`: **Discord API Denial-of-Service**: `computeRetentionFromGuild` performs sequential API calls. This can trigger 50-100 sequential requests per join event, hitting limits and blocking the event loop (economy.js:200).
- `index.js`: **Aggressive Crash-on-Rejection**: The bot handles unhandled rejections by exiting. This makes the bot fragile to transient network errors, potentially leading to restart loops (index.js:182).

---

## ⚡ High Priority
- `analytics.js`: **Row-by-Row Speaker Flush**: The analytics flusher performs individual `INSERT` calls for EVERY unique speaker. During busy periods, this can trigger 1000+ sequential DB writes, locking the DB for seconds (analytics.js:216).
- `scheduler.js` vs `weekly-recalculations.js`: **Logic Fragmentation**: Weekly reset logic is duplicated. Fixes/optimizations in the scheduler do not affect manual recalculations (scheduler.js:629).
- `concurrency.js`: **Total Failure Masking**: The worker loop masks system-wide failures (DB lock, network down) as individual item errors, making mass failures look like individual successes/logs (concurrency.js:26).
- `scheduler.js`: **N+1 Query Explosion**: `enforceQuotaWarnings` performs DB queries inside recruiter loops. In large guilds, this results in hundreds of sequential DB round-trips (scheduler.js:190).
- `index.js` & `shard.js`: **Resource Leaks (Timers)**: Several `setInterval` calls (heartbeats) are not cleared during shutdown/respawn, leading to memory bloat (shard.js:45).
- `scheduler.js`: **Excessive Lock TTL**: The `weekly_snapshot_lock` has a 2-hour TTL. Bot crashes block the weekly reset for 2 hours across all shards (line 642).

---

## ⚠️ Medium Priority
- `recruiter-multiplier-service.js`: **Horizontal Info Leakage**: `multiplier-view` subcommands lack permission checks. Any user can view the active multipliers of any other staff (line 31).
- `recruiter.js`: **Decentralized Permission Risk**: The top-level command router does not enforce permissions before delegating to handlers. Any new handler added is a "fail-open" vulnerability (line 19).
- `promote.js`: **UI Desync**: Errors during leaderboard recomputation are silently swallowed. Successful promotions might not show up for hours (line 132).
- `status-service.js`: **Degraded Observability**: Disk I/O errors are silently swallowed. If the backup directory is unreachable, the system provides false "N/A" info (line 12).
- `weekly-recalculations.js`: **Clock Drift Vulnerability**: `weekStart` calculation relies on local time. In distributed shards, clock drift can cause double-recalculations (line 63).

---

## 📝 Low Priority / Style
- `invite-system.js`: **Sharding-Unsafe Singleton State**: Use of module-level `Map` objects for active invites means state is not shared across shards.
- `handleExpiredAbsences`: **Unnecessary Full Fetches**: Loops over expired absences and performs individual member fetches instead of batching.

---

## 📦 Next Phase: Remediation (The "Fix It All" Plan)
1. **Fix Critical Deadlocks & Data Loss**: Implement timeouts for locks and robust error handling in `promote.js`.
2. **Shard-Safe State**: Move active invites/cooldowns to the DB and unify member fetch throttles.
3. **Performance & DoS**: Parallelize API calls in `economy.js` and batch DB flushes in `analytics.js`.
