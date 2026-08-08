# Post-Fix Regression Audit - 2026-04-02

## Scope

This audit records the post-stabilisation state of the current worktree after the Phase 0-4 implementation pass. It is focused on regression discovery, local validation, and residual production risks.

Reviewed areas:

- recruit flow: command -> service -> ledger -> leaderboard -> promotion
- DM campaign creation, cancellation, worker routing, and retry compatibility
- scheduler startup, weekly recalculation, warning refresh, and leaderboard rebuild paths
- DB bootstrap, referential preflight, recruiter write boundaries, and migration dry-run behavior
- config loading, runtime config handling, health endpoint, and analytics metrics exposure
- repo hygiene and lint debt on refactor-heavy modules

## Local Validation Evidence

Commands run on the current branch:

- `node node_modules/jest/bin/jest.js --runInBand`
- `node node_modules/jest/bin/jest.js --runInBand --detectOpenHandles`
- `node scripts/verify_commands.js`
- `node scripts/migration-dry-run.js`
- `node node_modules/eslint/bin/eslint.js . --ext .js`

Results:

- Jest: `73/73` suites passed, `260/260` tests passed
- Detect-open-handles pass: `73/73` suites passed, `260/260` tests passed
- Command verification: passed, `32` commands loaded
- Migration dry-run: passed, integrity checks OK, referential preflight unresolved set empty
- ESLint: passed, `0` errors, `0` warnings

Additional targeted coverage added during stabilisation:

- config loading and malformed explicit config handling
- health endpoint metrics exposure
- recruiter-linked write paths auto-seeding recruiter rows
- DM worker claim behavior and retry/cancellation compatibility
- recruit -> promote flow integration

## Implemented Workstreams

### Phase 0-2 engineering work completed locally

- Stabilisation baseline captured and rollback anchor tagged
- DM queue creation restored to transactional behavior with compatibility for existing queue rows
- DM cancellation expanded to cover retry-state targets
- worker selection compatibility helpers restored without reintroducing earlier DM regressions
- recruit command behavior brought back in line with service-layer authority and crediting rules
- leaderboard and promotion helpers hardened against minimal test schemas without silently masking production schema issues
- recruiter-linked writes now seed recruiter rows consistently across absence, promotion, trial fast-track, and economy paths

### Phase 3 engineering work completed locally

- config loading centralized through `src/lib/config-loader.js`
- runtime env parsing centralized through `src/lib/runtime-config.js`
- startup no longer mutates AECS env state directly; channel inheritance is passed explicitly
- health server now accepts injected metrics and logs the real bound port
- analytics exposes queue/backlog/drop counters for monitoring
- DB bootstrap responsibilities split into `src/lib/db-bootstrap.js`
- duplicate DM schema ownership removed from invite-table setup
- repo hygiene improved: transient artifacts ignored, refactor leftovers removed, full lint clean

## Deep Regression Audit Findings

### No new local P0/P1 regressions found

The current worktree does not show a newly introduced blocker or core-flow break under local test coverage. The highest-risk repaired areas remain green:

- recruit -> ledger -> leaderboard -> promotion
- DM queue creation, cancellation, worker routing, and reporting
- scheduler recompute and warning-leaderboard rebuild paths
- config/bootstrap/migration startup sequence

### Residual risks that still remain

#### 1. Staging and canary validation are still outstanding

The local environment cannot verify:

- real Discord permission failures in a staging guild
- anti-nuke live event handling against real audit logs
- real DM rate-limit behavior across worker accounts
- deployment-time branch / startup script drift

This means Phase 5 remains open even though the local engineering gate is green.

#### 2. Plain Jest still prints the generic async-operations banner

`jest --runInBand` still ends with the standard "Jest did not exit one second after the test run has completed" banner.

Important qualification:

- `--detectOpenHandles` passes cleanly
- no failing handle was surfaced by Jest
- this looks like low-severity test/runtime noise rather than a confirmed production leak

This should still be tracked until the noisy module or timer source is identified.

#### 3. Some expected console noise remains in tests

The current suite still emits warnings/errors for intentionally degraded or minimal setups:

- missing optional/minimal test tables such as `analytics_role_changes` or `recruits`
- missing anti-nuke env such as `OWNER_ID` and `ANTINUKE_ENCRYPTION_KEY`
- expected AECS/job-lock diagnostics

These no longer fail validation, but they reduce signal quality when scanning test logs.

#### 4. Dependency vulnerability status is not closed by this pass

Previous deploy logs reported `19` vulnerabilities. This stabilisation pass did not include dependency remediation, and `npm audit` was not rerun in this shell with a new report snapshot.

## Regression-Focused Critique

### What improved materially

- The branch is now lint-clean, so real defects are less likely to hide behind warning noise.
- DB/write-boundary behavior is less dependent on implicit row existence.
- startup/config behavior is more deterministic and easier to reason about.
- observability is better than before because queue metrics and health information are now available without scraping raw logs.

### What still needs operational follow-through

- run the documented staging flow checks against a real guild
- run canary rollout monitoring for DM queue depth, scheduler skips, and command failures
- verify anti-nuke hierarchy and live actionability in deployment, not just in unit tests
- decide whether the remaining test-log noise should be downgraded, suppressed, or refactored into structured warnings

## Sign-Off Status

### Complete locally

- Phase 0 baseline and rollback prep
- Phase 1 runtime safety hotfixes
- Phase 2 core flow and DB safety work
- Phase 3 operational hardening work
- Phase 4 local deep post-fix regression audit

### Still pending outside this workspace

- staging flow audit
- canary rollout
- live monitoring/alert verification
- production rollback rehearsal

## Recommendation

The branch is ready for staging validation and canary rollout, not blind full production rollout.

Local engineering sign-off is justified because:

- tests are green
- lint is clean
- command verification is green
- migration dry-run is green
- the repaired high-risk paths were re-audited after the final cleanup pass

Operational sign-off still depends on Phase 5 execution.
