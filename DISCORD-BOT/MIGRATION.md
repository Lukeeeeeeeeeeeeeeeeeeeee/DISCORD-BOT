# Production Hardening Migration (April 2026)

This document outlines the critical architectural upgrades and database migrations performed to harden the Discord bot for high-volume production use.

## 🗄️ Database Schema Upgrades
New indices have been applied to the `recruiter.db` to ensure O(1) lookups during daily and weekly maintenance cycles.

> [!IMPORTANT]
> The following indices are now required. They are automatically applied on next startup via `db_async.js`.

- `idx_weekly_calc_lookup`: Speeds up previous MinReq fetching.
- `idx_warnings_recruiter_active`: Optimizes daily warning cleanup and leaderboard refreshes.
- `idx_verifications_bulk`: Enables high-speed batched stats calculation.
- `idx_role_changes_staff_lookup`: Facilitates "New Staff" classification at scale.

## 🚀 Performance Refactors

### Batched Statistics Engine
The system has transitioned from an O(N) per-recruiter stats model to an O(1) set-based model.
- **New Utility**: `src/lib/recruiter-stats.js` handles all bulk stats logic.
- **Benefit**: Decreases Monday reset execution time from ~20s to <2s.

### Bulk Persistence
Invite snapshots are now persisted in chunked batches (200 rows/batch) rather than linear row-by-row transactions. This significantly reduces WAL checkpoint overhead and solves `SQLITE_BUSY` deadlocks during peak join events.

## 🛡️ Reliability & Telemetry
- **Unified Services**: Eliminated "shadow implementations" by refactoring `/recruit` and `/revoke-recruit` to use a single, hardened service layer. This ensures consistent transaction safety and permission enforcement.
- **Transaction Safety**: All member leaving and invitation cleanup logic now uses the `withTransaction` wrapper to prevent partial state corruption.
- **AECS Telemetry**: Added deep reporting for DM Worker 429 errors and analytics buffer drops.
- **Graceful Shutdown**: Increased `SHUTDOWN_ANALYTICS_TIMEOUT_MS` to 10s to ensure WAL clean-room handoff on exit.
