```bash
cd /home/container && git -c core.logallrefupdates=false fetch --no-tags https://github.com/Lukeeeeeeeeeeeeeeeeeeeee/DISCORD-BOT.git refs/heads/rescue_v3_indestructible:refs/tmp/ptero_update && git reset --hard refs/tmp/ptero_update && echo "HEAD=$(git rev-parse --short HEAD)" && export ENABLE_INTERNAL_WORKER=false && exec /usr/local/bin/node /home/container/src/index.js ${NODE_ARGS}
```
