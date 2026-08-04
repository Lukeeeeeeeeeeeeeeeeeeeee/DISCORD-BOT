# Plan: AECS Due Diligence — Findings & Implementation Tasks

## Status: COMPLETE — Analysis deliverable ready, implementation tasks defined

**Analysis Document:** `C:\discord-bot\.kilo\plans\AECS_SUPER_ANALYSIS_AND_ROADMAP.md` (V3, 1040 lines)

## Summary

AECS (Automated Error Codex System) is operational in production at `DISCORD-BOT/src/lib/aecs/`. Three analysis passes were performed, validating every finding against source code. Five P1 issues and five P2 issues identified, ranked by production impact.

## Key Corrections (vs initial assessment)
- AECS HAS test coverage (5 test files), not zero
- `exitOnFatal` defaults to `false` — not an active production risk
- `DISCORD-BOT/` is a deliberate deployment tree, not a divergence
- `toHexTraceId` does NOT lose entropy (`.toLowerCase()` is called first)

## P1 Issues — Fix in Order

### 1. SYS-700 fingerprint collision (Dispatcher.js:211)
- **Problem:** `state.message` is undefined → all SYS-700 summaries hash to same fingerprint → summaries self-suppress after 50/60s
- **Fix:** Replace `state.message` with `state.scope`
- **Validation:** Run `aecs_core.test.js` after fix

### 2. Unsanitized stack traces (telemetry-adapter.js:113)
- **Problem:** `truncateText(record.stack, 950)` without `sanitizeString()` — leaks file paths and potential secrets to Discord
- **Fix:** Apply `sanitizeString()` to `record.stack` before truncation
- **Validation:** Test with error containing secret in stack

### 3. No telemetry retry (telemetry-adapter.js:147-180)
- **Problem:** Single `fetch` attempt; 5xx/timeout = permanent telemetry loss
- **Fix:** Add 2x retry with 500ms/1s backoff (only for 5xx, not 4xx)
- **Validation:** Mock fetch returning 502, verify retry occurs

### 4. Missing domain dictionaries (logger.js:50-58)
- **Problem:** 40% of scopes (`service.*`, `economy.*`, `dm.*`, `recruiting.*`) → SYS-500
- **Fix:** Add `RECRUIT`, `DM`, `ECONOMY`, `ANALYTICS` dictionary files; update `inferCodeFromScope`
- **Validation:** Grep for new scope patterns; verify correct codes in test

### 5. Unbounded vault buffer (vault.js:86-90)
- **Problem:** `buffer.push()` with no size limit → memory pressure under error storms
- **Fix:** Add `maxBufferSize` (default 10,000), drop oldest + increment `droppedRecords`
- **Validation:** Queue >10k records, verify oldest dropped

## P2 Issues

### 6. Escalator exceptions silently swallowed (Dispatcher.js:145)
- **Fix:** Replace `void error;` with `console.error`

### 7. exitOnFatal premature exit (Dispatcher.js:348-352)
- **Problem:** Only active if `AECS_EXIT_ON_FATAL=1` (not set in prod)
- **Fix:** Add `vault.stop()` call before `process.exit(1)` as safety
- **Risk:** Very low (currently defaults off)

### 8. Missing session/cookie in blacklist (sanitize.js:2, logger.js:3)
- **Fix:** Add `session`, `cookie` to both blacklists

### 9. No vault file retention
- **Fix:** Add 90-day cleanup to scheduler monthly maintenance (scheduler.js:907-918)

### 10. No telemetry rate limiting
- **Fix:** Add local limiter (10 events/minute/webhook)

## Affected Boundaries
- **Files to modify:** Dispatcher.js, telemetry-adapter.js, sanitize.js, logger.js, vault.js, dictionaries/index.js, scheduler.js
- **New files:** dictionaries/recruit.js, dictionaries/dm.js, dictionaries/economy.js, dictionaries/analytics.js
- **Backward compatibility:** All P1-P3 changes are backward-compatible (additive codes, optional config, bug fixes)

## Rollout Strategy
- Deploy P1 fixes as a single hotfix PR
- Run `npm test -- --runInBand` + `node scripts/verify_commands.js`
- Canary: deploy to staging for 2 hours before production
- No DB migration needed (all changes are in-memory + code files)

## Validation Plan
1. Run existing AECS test suite: `5 test files`
2. Run P0 regression: `scripts/run-p0-regression.js`
3. Verify `node scripts/verify_commands.js` passes
4. Health endpoint: `GET /healthz` → verify `aecs` metrics present
5. For each P1 fix: add test case to corresponding `aecs_*.test.js` file
