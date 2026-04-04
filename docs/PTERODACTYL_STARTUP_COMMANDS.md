# Pterodactyl Startup Commands

Use these commands in the Pterodactyl startup field.

## 1. One-time update + start

Use this when you need to pull the latest `rescue_v3_indestructible` branch into the container and start the bot:

```bash
cd /home/container && git -c core.logallrefupdates=false fetch --no-tags https://github.com/Lukeeeeeeeeeeeeeeeeeeeee/DISCORD-BOT.git refs/heads/rescue_v3_indestructible:refs/tmp/ptero_update && git reset --hard refs/tmp/ptero_update && echo "HEAD=$(git rev-parse --short HEAD)" && export ENABLE_INTERNAL_WORKER=false && exec /usr/local/bin/node /home/container/src/index.js ${NODE_ARGS}
```

Expected after a successful update:

```bash
HEAD=518b698
```

## 2. Normal startup

Use this after the files are already updated:

```bash
cd /home/container && export ENABLE_INTERNAL_WORKER=false && exec /usr/local/bin/node /home/container/src/index.js ${NODE_ARGS}
```

## 3. Quick file-version check

Use this if you want to confirm the latest debug build is actually on disk before starting:

```bash
cd /home/container && echo "HEAD=$(git rev-parse --short HEAD 2>/dev/null || echo no-git)" && grep -n "BOOT: startup entered" src/index.js || true && grep -n "enableInternalWorker: envBool('ENABLE_INTERNAL_WORKER', false)" src/lib/runtime-config.js || true
```

## Required startup settings

- `AUTO_UPDATE=0`
- `NODE_PACKAGES` empty
- `UNNODE_PACKAGES` empty
- Do not run `npm install` on boot
