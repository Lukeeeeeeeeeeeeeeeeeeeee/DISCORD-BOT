# Stabilisation Baseline - 2026-04-02

## Scope

This baseline captures the repo state and validation results at the start of the post-refactor stabilisation pass.

## Branch and Rollback State

- Current working branch: `rescue_v3_indestructible`
- Current `HEAD`: `4cb6875`
- Rollback anchor tag created: `stabilise-baseline-20260402`
- Existing branch divergence:
  - `hotfix/stabilise` already exists at `179f828`
  - the current worktree contains local changes that prevented switching to that branch without overwriting files
  - stabilisation work is therefore continuing on the current worktree until the changes are checkpointed

## Saved Artifacts

- `final_test_results.txt`
- `verify_output.txt`
- `jest_detect_open_handles.txt`
- existing historical artifacts also present in repo root:
  - `error.log`
  - `failures.txt`
  - `jest_failures.txt`

## Verification Results

### Full test suite

Command:

```powershell
$env:Path = 'C:\Users\Admin\AppData\Local\nvm\v24.12.0;' + $env:Path
& 'C:\Users\Admin\AppData\Local\nvm\v24.12.0\npm.cmd' test -- --runInBand
```

Result:

- `68/68` suites passed
- `252/252` tests passed
- Jest reported asynchronous operations still active after completion, so a dedicated open-handle pass was run next

### Command verification

Command:

```powershell
$env:Path = 'C:\Users\Admin\AppData\Local\nvm\v24.12.0;' + $env:Path
& 'C:\Users\Admin\AppData\Local\nvm\v24.12.0\node.exe' scripts/verify_commands.js
```

Result:

- passed
- `32` commands loaded

### Open-handle verification

Command:

```powershell
$env:Path = 'C:\Users\Admin\AppData\Local\nvm\v24.12.0;' + $env:Path
& 'C:\Users\Admin\AppData\Local\nvm\v24.12.0\npx.cmd' jest --runInBand --detectOpenHandles
```

Result:

- `68/68` suites passed
- `252/252` tests passed
- no blocking open-handle failure remained

## Known Baseline Noise

These did not fail the baseline, but they remain visible in test output:

- scheduler and recruiter-stats warnings for missing test tables such as `analytics_role_changes` and `recruits`
- anti-nuke warnings for unset `OWNER_ID` and `ANTINUKE_ENCRYPTION_KEY`
- explicit expected console output in job-lock and AECS tests
- deprecation warning for `fs.rmdir(..., { recursive: true })`

## Next Phase

Proceed to Phase 1 in this order:

1. DM campaign atomicity and cancellation safety
2. DM worker correctness and re-entry defects
3. startup double-run and scheduler re-entry guards
