# Discord Bot Full Technical Audit and Single-Guild Hardening Roadmap
Date: 2026-02-15
Scope: `C:\discord-bot` (Node.js + Discord.js, single-guild operations)
Audience: Production owner/operator

## 0. Reality Check
This bot is no longer in "raw refactor chaos," but it is still not clean architecture.
Today improved runtime safety and guild scoping materially, but technical debt remains concentrated in a few large files and split execution paths.

Brutal summary:
- The bot can run stably for one guild if discipline is maintained.
- The current design is still fragile under rapid feature churn.
- Scaling to multi-guild would break in predictable places.

## 1. What Was Audited
- Runtime bootstrap, command loading, shutdown lifecycle, scheduler lifecycle.
- Command path consistency (legacy vs refactor paths).
- Active SQL queries and guild scoping.
- Invite subsystem schema/runtime alignment.
- Anti-nuke integration and safety hooks.
- Tests, lint, migration dry-run signals.

Validation results after latest hardening:
- `npm run lint`: pass (2 warnings, 0 errors)
- `node scripts/verify_commands.js`: pass
- `npm run test:p0`: pass
- `npm test -- --runInBand`: pass (41 suites, 95 tests)
- `npm run migration:dry`: pass

## 2. Current High-Impact State (After Today’s Fixes)
- Runtime env checks are now active: `src/index.js:17`, `src/index.js:21`
- Health check server is now wired: `src/index.js:18`, `src/index.js:149`
- Duplicate command hard-fail exists: `src/index.js:110`, `scripts/verify_commands.js:39`
- Scheduler lifecycle stop exists and is called on start/shutdown:
  - `src/scheduler.js:362`
  - `src/scheduler.js:912`
  - `src/index.js:183`
- Invite schema now includes enforced `guild_id`: `src/lib/create-invite-tables.js`
- Invite runtime paths are guild-scoped: `src/lib/invite-system.js`
- Additional guild-scoping fixes applied in live command/scheduler-adjacent paths:
  - `src/commands/recruiting/absent.js:71`
  - `src/commands/recruiting/leaderboard.js:56`
  - `src/commands/recruiting/revoke-recruit.js:40`
  - `src/commands/recruiting/status.js:47`
  - `src/lib/weekly-recalculations.js:109`

## 3. Architecture and Structure Audit
### Folder and layering
Strengths:
- Clear top-level areas (`src/commands`, `src/lib`, `src/repos`, `src/services`, `src/events`).
- Refactor direction exists (service/repo layering is real, not imaginary).

Problems:
- Runtime still favors legacy paths over service/repo paths.
- Refactor modules are partially orphaned by loader ignores.
- Event handling architecture is split (factory modules exist, runtime mostly inline).

Evidence:
- Loader ignores refactor modules:
  - `src/index.js:86`
  - `src/index.js:89`
  - `scripts/verify_commands.js:15`
  - `scripts/verify_commands.js:18`
- Only one event factory is wired:
  - `src/index.js:12`

Verdict:
- Structure is medium quality for single guild, weak for long-term maintainability.

## 4. Code Quality Audit
### Readability and maintainability
Good:
- Many modules are straightforward and test-covered.
- Command verification is explicit and deterministic.

Bad:
- Large monoliths remain:
  - `src/lib/antinuke.js` (~3426 lines)
  - `src/scheduler.js` (~973 lines)
  - `src/commands/recruiting/recruiter.js` (~785 lines)
- Permission handling is mixed: centralized in some commands, manual in others.
- Logging style is inconsistent (`console.*` dominates).

### DRY and dead code
- Refactor drift: `src/services/recruiting/*` and `src/repos/*` exist, but active command paths do not consistently use them.
- `src/commands/recruiting/recruiter-handlers/*` exists but loader intentionally ignores that path (`src/index.js:86`).

Verdict:
- Readable in parts, but maintenance risk is high due to monolith concentration and duplicated paradigms.

## 5. Performance and Optimization Audit
Strengths:
- SQLite pragmas include WAL/synchronous/busy_timeout protections: `src/db_async.js`.
- Scheduler has job tracking and stop lifecycle now: `src/scheduler.js:353`, `src/scheduler.js:362`.

Risks:
- In-memory maps can grow (invite snapshots, anti-nuke state, cooldown maps) with no global cap policy.
- Heavy periodic jobs still sit in one scheduler file with mixed concerns.
- No centralized rate-limit handling policy; behavior is command-specific.

Verdict:
- Acceptable for one guild current scale; not resilient for sustained growth.

## 6. Security Audit
Strengths:
- Token sanitization + runtime validation active: `src/index.js:17`, `src/index.js:21`.
- Admin/staff checks exist throughout critical commands.
- Anti-nuke protections and rollback subsystem are present and tested.

Risks:
- Permission checks are not uniformly centralized.
- Hardcoded IDs are still embedded defaults:
  - `src/constants.js:5`
  - `src/constants.js:7`
  - `src/constants.js:52`
- Engine policy mismatch still exists:
  - runtime enforces Node 18+: `src/index.js:21`
  - package allows Node 16+: `package.json:47`

Verdict:
- Secure enough for controlled ops, but policy consistency gaps remain.

## 7. Stability and Edge Cases Audit
Strengths:
- Shutdown is materially better:
  - scheduler stop: `src/index.js:183`
  - client destroy: `src/index.js:208`
  - db close: `src/index.js:211`
- Uncaught/unhandled handlers trigger flush and fail exit path.

Risks:
- Some error paths still log-and-continue where fail-fast might be safer.
- Scheduler and recruiter logic remain high-complexity hotspots.

Verdict:
- Stability improved from "fragile" to "operationally safe with attention."

## 8. Feature and Logic Audit
Core flow status (single guild):
- Recruit flow: functional and test-backed.
- Leaderboard paths: now explicitly guild-scoped in live command code.
- Anti-nuke and rollback: active and regression tested.
- Invite tracking/storage: schema/runtime alignment fixed.

Remaining feature logic drift:
- Recruitment report command path is currently excluded from loader.
- Legacy and refactor recruiter logic still coexist.

## 9. Scalability Review (Even Though You Are Single Guild)
If you scaled this as-is, first breaks would be:
1. Split runtime architecture (legacy vs service path drift).
2. Process-local state assumptions in scheduler/in-memory locks.
3. Hardcoded default IDs and config coupling.

For your stated constraint (single guild only):
- You do not need multi-guild abstraction now.
- You still need strict guild scoping everywhere to prevent future accidental corruption when data/migrations evolve.

Future-proof verdict:
- Partially future-proof in data model direction, not future-proof in runtime architecture yet.

## 10. Scores (Brutally Honest)
- Overall quality: 6.5 / 10
- Security: 7 / 10
- Scalability: 4 / 10
- Maintainability: 5 / 10

Top 5 fixes by impact:
1. Remove legacy/runtime split for recruiter domain (one execution path only).
2. Break `antinuke.js`, `scheduler.js`, and `recruiter.js` into bounded modules.
3. Standardize authorization + error response wrappers across all commands.
4. Replace ad hoc `console.*` with one structured logger policy.
5. Align runtime and package Node version policy.

## 11. Better Pattern Examples
### 11.1 Atomic balance mutation
```js
await db.run('BEGIN');
try {
  const result = await db.run(
    'UPDATE recruiters SET points = points - ? WHERE guild_id = ? AND id = ? AND points >= ?',
    cost, guildId, recruiterId, cost
  );
  if (!result || result.changes !== 1) throw new Error('INSUFFICIENT_POINTS');
  await db.run(
    'INSERT INTO purchases (guild_id, recruiter_id, item, cost, created_at) VALUES (?, ?, ?, ?, ?)',
    guildId, recruiterId, item, cost, Date.now()
  );
  await db.run('COMMIT');
} catch (err) {
  await db.run('ROLLBACK');
  throw err;
}
```

### 11.2 Strict command registry
```js
function registerCommand(registry, command, source) {
  const name = command?.data?.name;
  if (!name || typeof command.execute !== 'function') {
    throw new Error(`Invalid command module: ${source}`);
  }
  if (registry.has(name)) {
    throw new Error(`Duplicate command "${name}" from ${source}`);
  }
  registry.set(name, command);
}
```

### 11.3 Consistent command auth wrapper
```js
async function requireAdminOrFail(interaction) {
  const ok = await ensureCommandAccess(interaction, {
    allowStaff: false,
    deniedMessage: 'Administrator permission required.'
  });
  return ok;
}
```

## 12. Same-Day Single-Guild Hardening Roadmap (Iterative Evolution)
Constraint alignment:
- Single guild only
- No canary rollout
- No broad rewrite today
- Deploy directly after validation

### Iteration 0 (Initial Draft)
What it looked like:
- Fix all architecture drift immediately.
- Refactor monoliths and command/event systems same day.

Why this was wrong:
- Too much blast radius for one-day stability target.
- High regression risk, low confidence deploy.

### Iteration 1 (Refined for Today)
Changed to:
- Focus on runtime correctness first (command loading, guild scoping, startup/shutdown safety).
- Defer monolith breakup.

Expected gain:
- Major drop in corruption/regression risk without large rewrites.

Remaining risk:
- Legacy/refactor dual-path remains.

### Iteration 2 (Risk-Managed)
Added:
- Explicit P0/P1 prioritization and hard validation gates.
- Rollback triggers and "stop conditions" per phase.

Expected gain:
- Fast execution with controlled failure handling.

Remaining risk:
- Hidden behavior in monolith files still possible.

### Final Plan (Ready to Execute Same Day)
Status legend:
- Done: implemented and validated.
- Pending: recommended next actions before/after direct deploy.

#### Phase A (P0) Runtime Integrity - 2.5h - Done
Target:
- No duplicate command ambiguity.
- No scheduler double-run residue.
- Safe startup/shutdown.

Tasks:
1. Enforce duplicate command hard-fail.
2. Ignore legacy wrapper collision path.
3. Track and stop scheduler jobs.
4. Add health server startup hook.
5. Ensure shutdown closes scheduler/client/db.

Done when:
- Command verification passes.
- Shutdown path includes scheduler/client/db cleanup.
- App can restart without duplicate scheduler behavior.

Fallback:
- Revert to previous hotfix commit if boot fails.

#### Phase B (P0) Guild-Scoped Data Safety - 2h - Done (core), 45m pending sweep
Target:
- Active runtime SQL paths use `guild_id`.

Tasks completed:
1. Invite schema/runtime guild alignment.
2. Scheduler guild scoping in critical queries.
3. Guild scoping fixes in `absent`, `leaderboard`, `revoke-recruit`, `status`, and weekly recalculations.

Pending sweep:
1. Review non-loaded legacy/stale files and either delete or archive to reduce future accidental reuse.

Done when:
- All loaded command SQL touching recruiter/recruit/warning tables is guild-scoped.

Fallback:
- Restore DB from snapshot + revert latest scoping commit if query behavior regresses.

#### Phase C (P1) Operational Hardening - 1h - Done (with one bounded residual)
Target:
- Reduce incident response time and policy drift.

Tasks completed:
1. Aligned `package.json` engine with runtime policy (`node >=18`).
2. Standardized admin/staff denial handling through `ensureCommandAccess` across loaded anti-nuke/admin command modules.
3. Added structured runtime event logging for startup/shutdown critical paths.

Residual:
1. `src/commands/recruiting/recruiter.js` still contains legacy manual permission checks in several subcommand branches because the file is not safely patchable with the standard UTF-8 patch flow.

Done when:
- Lint clean, tests pass, and startup logs are consistent and parseable.

Fallback:
- Keep functionality as-is and only ship engine policy + minimal log wrapper.

#### Phase D Deploy Gate (Direct Deploy, No Canary) - 30m - Ready
Deploy only if all conditions are true:
1. `npm run lint` passes.
2. `node scripts/verify_commands.js` passes.
3. `npm run test:p0` passes.
4. `npm test -- --runInBand` passes.
5. `npm run migration:dry` passes.
6. Fresh DB backup snapshot exists.

Immediate rollback triggers after deploy:
1. Command failure rate > 1% sustained for 10 minutes.
2. Any unhandled rejection loop.
3. Scheduler errors repeating in same job cycle.
4. Recruit flow cannot complete end-to-end in live smoke test.

Rollback action:
1. `git revert <hotfix_commit>`
2. restart bot
3. restore DB snapshot only if data inconsistency is confirmed

## 13. Final Call
This is now deployable for a single guild with disciplined operations.
It is still not architecture-clean.
If you keep adding features before collapsing split runtime paths and breaking monoliths, you will re-enter instability quickly.
