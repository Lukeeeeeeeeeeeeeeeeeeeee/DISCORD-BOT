#!/bin/bash
set -euo pipefail

cd /home/container

git -c core.logallrefupdates=false fetch --no-tags \
  https://github.com/Lukeeeeeeeeeeeeeeeeeeeee/DISCORD-BOT.git \
  refs/heads/rescue_v3_indestructible:refs/tmp/ptero_update

git reset --hard refs/tmp/ptero_update

echo "HEAD=$(git rev-parse --short HEAD)"

export ENABLE_INTERNAL_WORKER=false
export SCHEDULER_FORCE_FULL_FETCH_ON_EMPTY=false
export SCHEDULER_ALLOW_FULL_MEMBER_FETCH=false
export SCHEDULER_FULL_FETCH_MAX=2000
export MEMBER_CACHE_WARM_COOLDOWN_MS=1800000

exec /usr/local/bin/node /home/container/src/index.js "$@"
