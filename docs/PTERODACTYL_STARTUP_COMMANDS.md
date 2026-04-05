# Pterodactyl Startup Commands

Use these commands in the Pterodactyl startup field.

## 1. Safe startup right now

Use this when the server files are already in place and you just want the bot to start without the broken egg wrapper:

```bash
cd /home/container && export ENABLE_INTERNAL_WORKER=false && exec /usr/local/bin/node /home/container/src/index.js
```

## 2. One-time update + start

Use this to pull the latest branch into `refs/tmp/ptero_update`, overlay the files into `/home/container`, and start the bot without touching broken reflogs:

```bash
cd /home/container && (git -c remote.origin.fetch= -c core.logallrefupdates=false fetch --no-tags origin refs/heads/rescue_v3_indestructible:refs/tmp/ptero_update || true) && git rev-parse --verify --short refs/tmp/ptero_update && git archive refs/tmp/ptero_update | tar -x -C /home/container && export ENABLE_INTERNAL_WORKER=false && exec /usr/local/bin/node /home/container/src/index.js
```

Expected after a successful update:

```bash
d4da5d8
```

## 3. Script startup after the latest files are uploaded

Use this only after the latest repo files have already been copied to the container and `/home/container/scripts/pterodactyl_start.sh` exists:

```bash
bash /home/container/scripts/pterodactyl_start.sh
```

## 4. Quick file-version check

Use this if you want to confirm the latest debug build is actually on disk before starting:

```bash
cd /home/container && echo "HEAD=$(git rev-parse --short HEAD 2>/dev/null || echo no-git)" && grep -n "BOOT: startup entered" src/index.js || true && grep -n "enableInternalWorker: envBool('ENABLE_INTERNAL_WORKER', false)" src/lib/runtime-config.js || true
```

## 5. Notes

- Do not run `npm install` on boot.
- Do not use `AUTO_UPDATE=1`.
- Git in this container has been unreliable because `.git/logs/...` writes are not supported.
- If the startup script hits GitHub auth prompts, update files through the Pterodactyl file manager/SFTP instead.

## Required startup settings

- `AUTO_UPDATE=0`
- `NODE_PACKAGES` empty
- `UNNODE_PACKAGES` empty
- Do not run `npm install` on boot
