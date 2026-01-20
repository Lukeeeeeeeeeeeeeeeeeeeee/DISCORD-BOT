# Recruit Bot

Discord bot implementing recruit/leaderboard/recruiter rules.

Quick start:

1. Copy `.env.example` to `.env` and fill in your token, client id, guild id and database path.
2. Install Node.js (v16.9+). If you get "node not recognized", install Node from https://nodejs.org/ and reopen your terminal.
3. Run `npm install` in the bot folder.

4. Create your `.env` file:
   - Copy `.env.example` to `.env` and fill the values (do **not** commit `.env`):
     ```env
     DISCORD_TOKEN=
     CLIENT_ID=
     GUILD_ID=
     DATABASE_PATH=./data/recruiter.db
     ```

5. Register commands and start the bot:
   - `npm run register-commands`
   - `npm start`

Notes:
- Keep your `DISCORD_TOKEN` secret. If you accidentally expose it, regenerate the token in the Discord Developer Portal immediately.

Quick checks:
- `node src/check.js` will show DB tables and a sample query.
- If you make changes to commands, re-run `npm run register-commands` to update slash commands for the guild.

Leaderboards:
- Weekly leaderboards are shown in sections (PODIUM, PEOPLE WITH +3, OTHER) and require a minimum of 5 active weekly recruiters to display; otherwise they show a prompt saying not enough data.

Notes:
- The bot stores data in an sqlite DB (default `./data/recruiter.db`).
- Weekly scheduler runs every Sunday 12:00 UTC and computes weekly flags/leaderboard (leaderboards are weekly), posting warnings where appropriate.
- Monthly reset of recruiter points runs on the 1st of each month (00:00 UTC).
- The code uses the IDs provided in the spec; update `src/config.example.json` or constants as needed.

Commands implemented (slash commands):
- `/recruit member region ign` — register a recruit (with checks)
- `/info member` — show recruit info
- `/recruiter info [member]` — show recruiter stats
- `/recruiter buy item` — spend points on items
- `/recruiter warn member note` — **ADMIN**: issue a warning to a recruiter
- `/recruiter dismiss member reason` — **ADMIN**: dismiss flags for a recruiter
- `/leaderboard [region]` — shows leaderboard
- `/leaderboard init` — **ADMIN**: initialize persistent leaderboard messages in invite channels
- `/status` — **ADMIN**: show bot status (DB size, uptime, last backup, counts)
- `/dm` — **ADMIN**: DM broadcast with batching, retries, and audit logs

See `TESTING.md` for a manual test checklist and `scripts/force_recompute.js` for forcing recompute during tests.

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
