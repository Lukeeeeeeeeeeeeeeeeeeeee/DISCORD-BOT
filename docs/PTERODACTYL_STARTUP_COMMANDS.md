# Pterodactyl Startup Commands

Use these commands in the Pterodactyl startup field.

## 1. Safe startup right now

Use this when the server files are already in place and you just want the bot to start without the broken egg wrapper:

```bash
cd /home/container && export ENABLE_INTERNAL_WORKER=false && exec /usr/local/bin/node /home/container/src/index.js
```

## 2. Script startup after the latest files are uploaded

Use this after the latest repo files have been copied to the container and `/home/container/scripts/pterodactyl_start.sh` exists:

```bash
bash /home/container/scripts/pterodactyl_start.sh
```

Expected after a successful scripted update:

```bash
HEAD=dbe6895
```

## 3. Quick file-version check

Use this if you want to confirm the latest debug build is actually on disk before starting:

```bash
cd /home/container && echo "HEAD=$(git rev-parse --short HEAD 2>/dev/null || echo no-git)" && grep -n "BOOT: startup entered" src/index.js || true && grep -n "enableInternalWorker: envBool('ENABLE_INTERNAL_WORKER', false)" src/lib/runtime-config.js || true
```

## 4. Notes

- Do not run `npm install` on boot.
- Do not use `AUTO_UPDATE=1`.
- Git in this container has been unreliable because `.git/logs/...` writes are not supported.
- If the startup script hits GitHub auth prompts, update files through the Pterodactyl file manager/SFTP instead.

## Required startup settings

- `AUTO_UPDATE=0`
- `NODE_PACKAGES` empty
- `UNNODE_PACKAGES` empty
- Do not run `npm install` on boot
