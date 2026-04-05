```bash
cd /home/container && (git -c remote.origin.fetch= -c core.logallrefupdates=false fetch --no-tags origin refs/heads/rescue_v3_indestructible:refs/tmp/ptero_update || true) && git rev-parse --verify --short refs/tmp/ptero_update && git archive refs/tmp/ptero_update | tar -x -C /home/container && export ENABLE_INTERNAL_WORKER=false && exec /usr/local/bin/node /home/container/src/index.js
```
