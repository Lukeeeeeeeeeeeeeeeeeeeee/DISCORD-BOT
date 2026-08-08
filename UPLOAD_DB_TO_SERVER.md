# URGENT: Upload Database to Pterodactyl Server

## The Problem
Your LOCAL database has the correct points, but your PTERODACTYL SERVER has a different database file with 0 points.

## Current Points (LOCAL):
- AvoidMyRevol (1381692847018868778): 6 pts ✓
- Str1k3_C0re (1238882108097953864): 4 pts ✓
- Centurion5866 (882597723864449054): 2 pts ✓
- Hikaru (573654608971563029): 10 pts ✓
- pero0244421 (1385608712080851075): 1 pt ✓

## How to Fix

### Option 1: Upload via Pterodactyl File Manager (EASIEST)
1. Go to your Pterodactyl panel
2. Navigate to Files tab
3. Go to `/home/container/data/` folder
4. Upload your LOCAL `c:\discord-bot\data\recruiter.db` file
5. Overwrite the existing `recruiter.db` on the server
6. Restart the server

### Option 2: Run Migration on Server Startup
Add this to your startup command BEFORE `node ${STARTUP_FILE}`:

```bash
cd /home/container && if [ ! -d .git ]; then git init && git remote add origin https://github.com/Lukeeeeeeeeeeeeeeeeeeeee/DISCORD-BOT.git && git fetch --depth=1 origin rescue_v3_indestructible && git reset --hard FETCH_HEAD; else git fetch origin rescue_v3_indestructible && git reset --hard origin/rescue_v3_indestructible; fi && if [ -f package.json ]; then npm install --no-fund --no-audit; fi && node manual_restore_points.js && node ${STARTUP_FILE}
```

This will run `manual_restore_points.js` on EVERY startup to ensure points are always correct.

### Option 3: Use SFTP
1. Use an SFTP client (FileZilla, WinSCP)
2. Connect to your server
3. Navigate to `/home/container/data/`
4. Upload `recruiter.db` from `c:\discord-bot\data\recruiter.db`
5. Restart server

## Why This Keeps Happening
The server starts with an empty/old database, and the migration script migrates empty data from the old guild ID. You need to get the CORRECT database file onto the server.
