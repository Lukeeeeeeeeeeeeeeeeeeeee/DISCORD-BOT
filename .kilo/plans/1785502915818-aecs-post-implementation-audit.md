# AECS Post-Implementation Audit — Action Plan

## Audit Summary

**Overall verdict:** Phases 1-3 are well-implemented and production-capable, but two blocking issues and several improvements are needed before production release.

| Area | Score | Grade |
|------|-------|-------|
| Architecture | 85/100 | B+ |
| Maintainability | 80/100 | B- |
| Reliability | 88/100 | B+ |
| Performance | 78/100 | B- |
| Security | 75/100 | C+ |
| Developer Experience | 90/100 | A- |

---

## Blocking Issues (Must Fix Before Production)

### 1. BUG-01: `forceWriteSync` can corrupt vault files during concurrent flush
- **File:** `vault.js:310-337`
- **Problem:** `flush()` uses async `WriteStream.write()` to JSONL/IDX files. `forceWriteSync()` uses `fs.appendFileSync()` to the same files. If both run simultaneously, writes can interleave, corrupting the binary index or JSONL records. Additionally, `forceWriteSync` does not check `isFlushing` flag.
- **Fix:** In `forceWriteSync`, before the sync write:
  1. Check if `isFlushing` or streams are active — if so, destroy them to interrupt concurrent writes
  2. Destroy and null both `logStream` and `idxStream`
  3. Reset offset tracking (`currentDateKey`, `currentJsonlPath`, `currentIdxPath`, `currentOffset`)
  4. Proceed with existing synchronous write logic

  ```javascript
  forceWriteSync(record) {
    if (!record || typeof record !== 'object') return;
    if (!this.ensurePersistenceReady()) {
      this.droppedRecords += 1;
      return;
    }

    // FIX (BUG-01): Close async streams before sync write to prevent interleaving
    if (this.isFlushing || this.logStream || this.idxStream) {
      if (this.logStream) { this.logStream.destroy(); this.logStream = null; }
      if (this.idxStream) { this.idxStream.destroy(); this.idxStream = null; }
      this.currentDateKey = null;
      this.currentJsonlPath = null;
      this.currentIdxPath = null;
      this.currentOffset = 0;
    }
    // ... rest of existing forceWriteSync logic
  }
  ```
- **Validation:** Test concurrent `flush()` + `forceWriteSync()` — verify no corruption by reading back written records

### 2. SECURITY-01: Missing `session`/`cookie` in secret blacklists
- **Files:** `sanitize.js:2`, `logger.js:3`
- **Problem:** `BLACKLISTED_KEYS` and `SECRET_KEYS` both miss `session`, `cookie`, `refresh_token`, `access_token`. These keys in error metadata will be exposed in vault logs and telemetry webhooks.
- **Fix:** Add missing keys to both lists:
  ```javascript
  // sanitize.js line 2
  const BLACKLISTED_KEYS = new Set([
    'token', 'secret', 'password', 'key', 'auth', 'authorization',
    'api_key', 'apikey', 'session', 'cookie', 'refresh_token',
    'access_token', 'private_key'
  ]);
  // logger.js line 3 — same set
  const SECRET_KEYS = new Set([...same keys...]);
  ```
- **Validation:** Test `sanitizeMeta({ session_id: 'abc123' }, { safeMetaKeys: ['session_id'] })` returns `[REDACTED]`

---

## High Priority Improvements (Before Phase 4)

### 3. BUG-02: UUID replacement happens after number replacement in `normalizeMessage`
- **File:** `Dispatcher.js:19-29`
- **Problem:** The `.replace(/\b\d+\b/g, '[NUM]')` replacement (line 26) runs before the UUID replacement (line 27). A UUID like `550e8400-e29b-41d4-a716-446655440000` has all its digits replaced with `[NUM]`, producing `[NUM]e84a-e29b-[NUM]d4-a716-[NUM][NUM][NUM][NUM][NUM]e`, which no longer matches the UUID regex `[0-9a-f]{8}-...`.
- **Impact:** UUIDs in error messages are not normalized to `[UUID]`. This causes fingerprint fragmentation — two similar errors with different UUIDs (e.g., different Discord user IDs embedded in an error message) will produce different fingerprints, defeating the suppression circuit breaker's ability to group them as the same error pattern.
- **Fix:** Move the UUID replacement to BEFORE the number replacement:
  ```javascript
  // Current order (line 22-28):
  .replace(/\b\d{17,20}\b/g, '[ID]')          // Snowflake IDs
  .replace(/\b[a-fA-F0-9]{24,128}\b/g, '[HEX_LONG]')  // Long hex
  .replace(/\b0x[a-fA-F0-9]+\b/g, '[HEX]')   // 0x hex
  .replace(/\b\d+\b/g, '[NUM]')              // numbers — RUNS BEFORE UUID
  .replace(/[0-9a-f]{8}-.../gi, '[UUID]')    // UUIDs — can't match anymore

  // Fixed order:
  .replace(/\b\d{17,20}\b/g, '[ID]')
  .replace(/\b[a-fA-F0-9]{24,128}\b/g, '[HEX_LONG]')
  .replace(/\b0x[a-fA-F0-9]+\b/g, '[HEX]')
  .replace(/[0-9a-f]{8}-...\b/gi, '[UUID]')   // UUIDs FIRST
  .replace(/\b\d+\b/g, '[NUM]')              // numbers AFTER UUIDs
  ```
- **Validation:** Test `normalizeMessage('550e8400-e29b-41d4-a716-446655440000')` returns string containing `[UUID]`; test that messages with different UUIDs but otherwise identical text produce the same fingerprint (suppression grouping works)

### 4. ARCH-02: Anti-nuke-purge escalator check duplicated across 5 dictionaries
- **Files:** `dictionaries/db.js:30`, `dictionaries/cmd.js:43`, `dictionaries/recruit.js:37`, `dictionaries/dm.js:28`, `dictionaries/economy.js:10`
- **Problem:** Each escalator repeats `if (traceContext && traceContext.command === 'anti-nuke-purge') return 95;`
- **Constraint:** Dictionary files currently have no `require()` imports — they are pure data modules. `Dispatcher.js` imports from `dictionaries/index.js`, so dictionaries cannot import from `Dispatcher.js` (circular dependency).
- **Fix:** Add `getAntinukeEscalation(traceContext)` to `sanitize.js` (which has no circular dep concerns), export it, then have each dictionary import and call it:
  ```javascript
  // sanitize.js
  function getAntinukeEscalation(traceContext) {
    return traceContext && traceContext.command === 'anti-nuke-purge';
  }
  module.exports = { ..., getAntinukeEscalation };
  ```
  Then each dictionary escalator becomes:
  ```javascript
  const { getAntinukeEscalation } = require('../sanitize');
  escalator: (meta, traceContext) => {
    if (getAntinukeEscalation(traceContext)) return 95;
    // ...domain-specific logic remaining...
  }
  ```
- **Validation:** All existing escalator tests must pass — anti-nuke-purge must still return 95 for all 5 dictionaries

### 5. FIND-01: SuppressionMap grows unbounded
- **File:** `Dispatcher.js:92, 151-179`
- **Problem:** `this.suppressionMap = new Map()` at line 92. The `shouldSuppress` method (line 151-179) creates new Map entries for each unique fingerprint and never deletes them. The `flushSuppressionSummaries` method only resets `count`/`windowStart` for entries with `suppressed <= 0` (lines 184-190) but never deletes entries from the Map. Over time, every unique error fingerprint accumulates as a permanent Map entry in memory.
- **Root cause:** The Map only grows — there's no max-size guard or TTL-based eviction.
- **Fix:** Add a max-size eviction in `shouldSuppress`. When the suppressionMap exceeds a threshold (e.g., 10,000 entries), evict the oldest 20% by `windowStart`:
  ```javascript
  // In shouldSuppress, after creating the new state entry (line 164):
  if (this.suppressionMap.size > 10000) {
    const entries = [...this.suppressionMap.entries()]
      .sort((a, b) => a[1].windowStart - b[1].windowStart);
    for (let i = 0; i < 2000; i++) {
      this.suppressionMap.delete(entries[i][0]);
    }
  }
  ```
  **Why max-size over TTL:** TTL-based eviction requires `flushSuppressionSummaries` to run, but that only happens on the scheduler interval. Max-size eviction is deterministic and prevents unbounded growth regardless of flush timing.
- **Validation:** Test with 10001 unique fingerprints, verify suppressionMap size stays at ~10000 (eviction triggers)

### 6. ARCH-01: `getDomainForCode` duplicated
- **Files:** `Dispatcher.js:47-52`, `dictionaries/index.js:36-42`
- **Problem:** Identical implementations in two files
- **Fix:** Remove from `Dispatcher.js`, import from `dictionaries`
- **Validation:** All domain extraction tests pass

### 7. ARCH-03: Secret lists duplicated and inconsistent matching
- **Files:** `sanitize.js:2`, `logger.js:3`
- **Problem:** `BLACKLISTED_KEYS` and `SECRET_KEYS` are duplicated lists with identical content. Additionally, the matching logic differs: `sanitize.js` uses `key.includes(secret)` (substring match, catches `session_id`) while `logger.js` uses `/\b${secret}\b/i.test(key)` (word boundary match, misses `session_id`).
- **Fix:** 
  1. Export `BLACKLISTED_KEYS` from `sanitize.js` (after Task 2 adds new keys)
  2. Import in `logger.js` instead of local `SECRET_KEYS`
  3. Refactor `logger.js`'s `stripSecrets` to use the same `shouldSkipKey` pattern from `sanitize.js` for consistency
- **Validation:** Both lists produce identical sanitization results — `session_id` should be `[REDACTED]` in both paths

---

## Medium Priority Improvements (Recommended Before Phase 4)

### 8. FIND-02: Vault file retention policy missing
- **File:** `vault.js`
- **Problem:** No cleanup of old `aecs-*.jsonl`/`.idx` files. Disk grows unbounded.
- **Fix:**
  1. Add `cleanupOldFiles(maxAgeDays = 90)` method to `AecsVault`
  2. Import AECS in `scheduler.js` and call `AECS.vault.cleanupOldFiles(90)` in the monthly maintenance job
- **Validation:** Run with `maxAgeDays=0` on temp directory, verify old files deleted

### 9. ABSTRACT-01: Telemetry adapter return type inconsistency
- **File:** `telemetry-adapter.js`
- **Problem:** `sendToWebhook` returns `{ ok, retryable }`, `sendToWebhookWithRetry` returns `boolean`, `send` returns `{ sent, reason }`
- **Fix:** Document clearly in JSDoc, or standardize `sendToWebhookWithRetry` to return `{ ok, retryable }`
- **Validation:** All existing tests pass unchanged

---

## Nice-to-Have Improvements (Post-Production)

### 10. RETRY-01: No retry attempt logging in telemetry
- **File:** `telemetry-adapter.js:186-198`
- **Fix:** Add `console.warn('[AECS] Telemetry retry attempt', attempt, 'for', url)` before retry
- **Effort:** 2 lines

### 11. SECURITY-02: SECRET_RE doesn't match short Discord tokens
- **File:** `sanitize.js:1`
- **Fix:** Add pattern for Discord bot tokens: `[a-zA-Z0-9_-]{24,32}\.[a-zA-Z0-9_-]{6,12}\.[a-zA-Z0-9_-]{27,45}` already covers standard JWT-like. Add Discord-specific pattern for shorter tokens.
- **Effort:** 5 lines regex

### 12. TypeScript `.d.ts` declares internal functions as module exports
- **File:** `index.d.ts:244-266`
- **Problem:** The `declare module '../src/lib/aecs'` block declares `dictionaries`, `createSupportId`, `createFingerprint`, `sanitizeMeta`, etc. as `export const`/`export function`. However, `index.js` only exports `AECS`, `CodexError`, `TelemetryAdapter`, `provisionTelemetryWebhooks`. These internal functions are NOT accessible from `require('./aecs')`.
- **Fix:** Remove the incorrect `export` declarations for internal functions (lines 244-266), OR properly re-export them from `index.js` to match the types
- **Effort:** 15 lines (remove) or 5 lines (add re-exports)

---

## Implementation Order

```
Phase 3.5 (Pre-Production Hardening) — All tasks are independent except where noted

Task 1: BUG-01 — forceWriteSync stream coordination (vault.js)
  └─ Independent

Task 2: SECURITY-01 — Add session/cookie to secret lists (sanitize.js + logger.js)
  └─ Independent

Task 3: BUG-02 — Fix UUID regex ordering (Dispatcher.js:19-29)
  └─ Independent

Task 4: ARCH-02 — Extract anti-nuke-purge escalation utility
  ├── Step 4a: Add getAntinukeEscalation() to sanitize.js
  ├── Step 4b: Update 5 dictionary files to import + use the utility
  └─ Must all be done atomically (can't have some dictionaries using old pattern)

Task 5: FIND-01 — Add suppressionMap max-size eviction (Dispatcher.js:92, 151-179)
  └─ Independent

Task 6: ARCH-01 — Delegate getDomainForCode to dictionaries (Dispatcher.js)
  └─ Independent

Task 7: ARCH-03 — Consolidate BLACKLISTED_KEYS (depends on Task 2)
  ├── Export BLACKLISTED_KEYS from sanitize.js (after Task 2 adds new keys)
  └── Import in logger.js instead of local SECRET_KEYS

Task 8: FIND-02 — Add vault file retention (vault.js + scheduler.js)
  └─ Independent

Task 9: ABSTRACT-01 — Document telemetry return types (telemetry-adapter.js)
  └─ Independent

Task 10: TYPEDEFS — Fix index.d.ts exports (remove internal sanitize functions)
  └─ Independent

Validation: Run full test suite (372 existing + N new tests in `aecs_hardening.test.js`)

### Test File: `tests/aecs_hardening.test.js` (NEW)

```
describe('AECS Pre-Production Hardening')

  describe('BUG-01: forceWriteSync concurrency')
    test: concurrent flush() + forceWriteSync — no corruption
    test: forceWriteSync during active flush — streams destroyed, write succeeds
    test: forceWriteSync after flush disabled — works normally

  describe('SECURITY-01: secret key redaction')
    test: sanitizeMeta with session_id in safeMetaKeys — redacted
    test: sanitizeMeta with cookie_session in safeMetaKeys — redacted
    test: sanitizeMeta with refresh_token — redacted
    test: sanitizeMeta with access_token — redacted

  describe('BUG-02: UUID normalization')
    test: normalizeMessage replaces UUID with [UUID]
    test: two different UUIDs produce same normalized form
    test: messages with only UUID (different UUIDs) produce same fingerprint

  describe('ARCH-02: anti-nuke-purge escalation')
    test: all 5 dictionaries return 95 for anti-nuke-purge
    test: getAntinukeEscalation returns true for antinuke context
    test: getAntinukeEscalation returns false for other commands

  describe('FIND-01: suppressionMap bounds')
    test: suppressionMap evicts when exceeding max size
    test: eviction preserves entries with suppressed > 0

  describe('FIND-02: vault file retention')
    test: cleanupOldFiles(0) deletes all files
    test: cleanupOldFiles(30) preserves recent, deletes old
    test: cleanupOldFiles skips non-aecs files
```
---

## Dependencies

| Task | Depends On | Notes |
|------|-----------|-------|
| Task 4b (Update dictionaries) | Task 4a (Add utility) | Must add utility before updating dictionary files |
| Task 7 (Consolidate secrets) | Task 2 (Add new keys) | Must add `session`/`cookie` before consolidating the list |
| Task 10 (Fix d.ts) | Task 4a (New export) | If we choose to re-export `getAntinukeEscalation` from `index.js`, must add type declaration |
| Validation (tests) | All tasks | Must run after all changes |

### File-level Change Summary

| File | Changes |
|------|---------|
| `sanitize.js` | Add `session`/`cookie` to BLACKLISTED_KEYS; add `getAntinukeEscalation` export |
| `logger.js` | Add `session`/`cookie` to SECRET_KEYS; refactor stripSecrets to use sanitize.js `shouldSkipKey` for consistency |
| `vault.js` | Fix forceWriteSync concurrency; add `cleanupOldFiles()` method |
| `Dispatcher.js` | Fix UUID regex order; delegate `getDomainForCode` to dictionaries; add suppressionMap eviction |
| `dictionaries/db.js` | Import `getAntinukeEscalation` from sanitize.js |
| `dictionaries/cmd.js` | Import `getAntinukeEscalation` from sanitize.js |
| `dictionaries/recruit.js` | Import `getAntinukeEscalation` from sanitize.js |
| `dictionaries/dm.js` | Import `getAntinukeEscalation` from sanitize.js |
| `dictionaries/economy.js` | Import `getAntinukeEscalation` from sanitize.js |
| `scheduler.js` | Import AECS; call `AECS.vault.cleanupOldFiles(90)` in monthly maintenance |
| `telemetry-adapter.js` | Add JSDoc to `sendToWebhookWithRetry` documenting boolean return |
| `index.d.ts` | Remove internal sanitize exports from ambient module declaration |
| `tests/aecs_hardening.test.js` (NEW) | Tests for BUG-01, BUG-02, SECURITY-01, FIND-01, FIND-02 |

---

## Validation Plan

### Pre-Deployment Checklist
- [ ] All tests pass (existing 372 + new hardening tests)
- [ ] ESLint clean on all modified files
- [ ] `verify_commands.js` — 32 commands load
- [ ] CI gates pass (tests + lint + verify_commands)
- [ ] All tests in `aecs_hardening.test.js` pass

### Production Monitoring After Deploy
- Vault buffer `droppedRecords` metric — should stay 0 under normal load
- SuppressionMap size — should stabilize after warmup period
- Telemetry webhook delivery success rate — should remain >99%
- No `[SCRUBBED]` tokens in support lookup URLs (verifies secret sanitization working in prod)

---

## Rollback Plan

If any pre-production fix causes issues:
1. Revert the specific file change via `git checkout -- <file>`
2. Run tests to confirm baseline behavior restored
3. Deploy with known-good state (Phases 1-3 without hardening)
4. Re-attempt the fix with additional test coverage

For production deployment failure:
1. Use `exitOnFatal: false` (default) to prevent crash loops
2. Vault persistence auto-disables on errors — system degrades gracefully to console-only logging
3. Telemetry failures are caught and logged — no process crash
4. Re-deploy previous image/tag (all changes are backward-compatible configuration)

---

## What Should Never Be Changed

These are core design decisions that should remain stable:
1. **`Dispatcher.dispatch()` pipeline** (Dispatcher.js:287-359) — The linear flow is the foundation of AECS
2. **`CodexError` frozen stack** (CodexError.js:42-49) — Prevents downstream mutation
3. **`forceWriteSync` for FATAL** (vault.js:310-337) — Provides crash durability (fix concurrency, don't remove)
4. **Declarative dictionary escalators** — Pure functions in data files isolate business logic
5. **`normalizeMessage` fingerprint normalization** (Dispatcher.js:19-29) — Prevents suppression bypass
6. **Suppression circuit breaker** (Dispatcher.js:151-223) — Core observability mechanism
