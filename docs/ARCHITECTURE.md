# Architecture Overview

This codebase is organized around commands, domain logic, and infrastructure utilities.

## Layout (current)
- `src/index.js`: app bootstrap, Discord client setup, lifecycle hooks.
- `src/commands/`: command entry points only; keep handlers thin.
- `src/services/`: domain services (business logic without Discord response formatting).
- `src/repos/`: database access (SQL centralized here).
- `src/lib/`: shared utilities and domain logic (recruiting, economy, permissions, scheduling, transactions).
- `src/lib/respond.js`: interaction reply/defer helper to reduce command boilerplate.
- `src/scheduler.js`: scheduled jobs and leaderboard recompute orchestration.
- `src/db_async.js`: SQLite schema, migrations, and database helpers.
- `scripts/`: operational scripts (backup, migration dry-run, etc).

## Command Structure
- Each command file should be a small dispatcher.
- Subcommand logic lives in `*-handlers/` modules.
- Shared helpers live in `*-helpers.js`.
- Commands should call services; services call repos.
- Use `src/lib/transactions.js` for multi-step DB writes to keep state consistent.

Example: `recruiter` command
- Entry point: `src/commands/recruiting/recruiter.js`
- Handlers: `src/commands/recruiting/recruiter-handlers/*.js`
- Helpers: `src/commands/recruiting/recruiter-helpers.js`

## Dependency Direction
- `commands` -> `lib` / `scheduler` / `db_async`
- `commands` -> `services` -> `repos`
- `lib` should not depend on `commands`
- `scheduler` should not depend on `commands`

## Refactor Guidance
- Prefer extracting reusable logic into `src/lib` (pure functions).
- Keep command handlers focused on input validation and response formatting.
- Database access should flow through `db_async` and small, testable helper functions.

## Target Direction (next)
- Group domain logic under `src/services/<domain>` and keep commands as thin adapters.
- Keep SQL in `src/repos` only; avoid direct SQL in command handlers.
- Reserve `src/lib` for pure utilities and cross-domain helpers.
- Add a `src/config` module to validate env vars at startup and document defaults.
- Standardize error handling with `AppError` and user-safe messages, plus structured logs.
- Add domain-level integration tests for critical flows (recruit -> points -> leaderboard -> promotion).
