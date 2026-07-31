#!/bin/bash
set -euo pipefail

cd /home/container

git -c core.logallrefupdates=false pull --no-tags --ff-only origin rescue_v3_indestructible

echo "HEAD=$(git rev-parse --short HEAD)"

if [ -f package.json ]; then npm install --no-fund --no-audit; fi

export ENABLE_INTERNAL_WORKER=false
export SCHEDULER_FORCE_FULL_FETCH_ON_EMPTY=false
export SCHEDULER_ALLOW_FULL_MEMBER_FETCH=false
export SCHEDULER_FULL_FETCH_MAX=2000
export MEMBER_CACHE_WARM_COOLDOWN_MS=1800000

exec /usr/local/bin/node /home/container/src/index.js "$@"
