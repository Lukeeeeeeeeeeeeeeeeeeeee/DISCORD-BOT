# Recruit Bot

Discord bot for recruiting, leaderboards, analytics, and anti-nuke protection.

## Quick start

1. Copy `.env.example` to `.env` and fill in your token, client id, guild id, and database path.
2. Install Node.js (v16.9+). If you get "node not recognized", install Node from https://nodejs.org/ and reopen your terminal.
3. Run `npm install` in the bot folder.
4. Register commands and start the bot:
   - `npm run register-commands`
   - `npm start`

Notes:
- Keep your `DISCORD_TOKEN` secret. If you accidentally expose it, regenerate the token in the Discord Developer Portal immediately.

Quick checks:
- `node src/check.js` will show DB tables and a sample query.
- If you make changes to commands, re-run `npm run register-commands` to update slash commands for the guild.

## Feature Overview
- Recruiting workflow with invite attribution, regional roles, verification checks, and member-leave invalidation.
- Recruiter economy: points, multipliers, purchases, and optional role grants (VIP/MVP/custom).
- Requirements and status: weekly min-req calculations, warning tracking, absences, and new recruiter grace.
- Leaderboards and reports: regional leaderboards, demotion watch, and recruitment report by team.
- Rookie onboarding system: rookie points, chat activity tracking, war logs, and promotions.
- Anti-nuke suite with rollback, quarantine controls, backups, log export, and admin controls.
- Analytics and telemetry: messages, voice minutes, invite usage, role changes, and command usage.

## Slash Commands
- Recruiting: `/recruit`, `/info`, `/revoke-recruit`, `/invite`, `/recruiter info`.
- Economy: `/recruiter buy`, `/recruiter multiplier-list`, `/recruiter multiplier-view`, `/recruiter multiplier-active`, `/recruiter multiplier-apply`, `/recruiter multiplier-reset`.
- Moderation: `/recruiter warn`, `/recruiter warnings-revoke`, `/absent`, `/rookiepoints add/remove`, `/rookie_promote`.
- Reporting: `/leaderboard show/init`, `/recruitment_report`, `/dm`.
- Anti-nuke: `/antinuke_status`, `/antinuke_rollback`, `/simulate_attack`, `/toggle_strict_mode`, `/toggle_aggressive_ban`, `/set_quarantine_options`.
- Ops/backups: `/force_backup`, `/view_backups`, `/emergency_recover`, `/export_logs`, `/set_log_channel`, `/whitelist`, `/check_score`, `/reset_scores`, `/status`.

## Scheduler & Maintenance
- Monday 00:00 UTC: weekly recruiter recalculation; Monday 00:05 UTC: weekly snapshot and min-req storage.
- Sunday 12:00 UTC: weekly recruit validity sweep and leaderboard refresh.
- Daily cleanup: expire multipliers and recompute warning counts.
- Hourly cleanup: expire tracked invites.
- Monthly maintenance: optional point reset announcement (points preserved by default).

## Configuration & Storage
- SQLite storage at `./data/recruiter.db` by default (override with `DATABASE_PATH`).
- Slash commands are registered via `src/register-commands.js`.
- Role/channel IDs are in `src/constants.js` and overrideable via `config.json`/`config.local.json`.
- See `docs/WALKTHROUGH.md` for manual verification steps.
- Scripts in `scripts/`: `backup-db.js` (SQLite backup), `recalculate-points.js` (recompute recruit points), `require-walk.js` (module load check).

## Deployment (Pterodactyl)

If you deploy with Pterodactyl, ensure the following so the host can find the bot entrypoint and safely pull updates:

- Add a root `index.js` that requires the real start file. Example:

```js
// index.js
require('./src/index.js');
```

- Pterodactyl startup settings:
  - Auto Update = 1
  - Git Repo Address = `https://github.com/Lukeeeeeeeeeeeeeeeeeeeee/DISCORD-BOT-1`
  - Install Branch = `main`
  - Bot JS file = `index.js`

- Do NOT commit your SQLite DB. Add to `.gitignore`:

```
data/recruiter.db
```

If you see `Error: Cannot find module '/home/container/index.js'`, it means Pterodactyl didn't pull the latest repo or the startup file is incorrect. Check the host file manager and confirm `index.js` exists at the container root.

This is a minimal, extendable implementation. Adjust logic, thresholds, and messaging to taste.
