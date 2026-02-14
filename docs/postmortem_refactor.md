# Postmortem: Post-Refactor Stabilization Issues

Date: 2026-02-11
Owner: Lead Dev

## Summary
During stabilization after the async refactor, several issues surfaced around database migrations and operational visibility. The most impactful issue was a migration failing when normalized views referenced tables that were being rebuilt. This blocked some flows until fixed.

## Impact
- Migration `2026-02-07-guild-columns` could fail on older schemas with normalized views present, preventing DB init from completing.
- Anti-nuke warnings appeared in tests and staging when required env vars were missing (`OWNER_ID`, `ANTINUKE_ENCRYPTION_KEY`), reducing coverage for owner-only actions and encrypted backups.
- Command-level observability was limited; failure diagnosis relied on stack traces only.

## Timeline (local)
- 2026-02-10: Migration failures observed in test logs referencing `rookie_points_normalized`.
- 2026-02-11: Migration updated to drop/recreate views during table rebuilds. Verbose command logging and health check added.

## Root Cause
- Normalized views were created before the migration that drops/rebuilds tables; SQLite validates view dependencies, causing migration failures when referenced tables were in flux.

## Fixes
- Migration now drops normalized views before rebuilding tables and recreates them after the new schema is in place.
- Added a `VERBOSE_LOGGING` toggle for command start/finish logging to aid triage.
- Added optional health check endpoint and a migration dry-run helper.

## Preventative Actions
- [ ] Run `npm run migration:dry` against a production DB copy before each release.
- [ ] Require staging validation for recruit -> leaderboard -> promotion -> status flows.
- [ ] Ensure `OWNER_ID` and `ANTINUKE_ENCRYPTION_KEY` are set in staging/prod.
- [ ] Add monitoring for command failure rate and DB errors.

## Appendix
- Logs: see `error.log`, `failures.txt`, `final_test_results.txt`, `jest_failures.txt`.
