# Deploy Activitycheck Fix

Use this startup command in Pterodactyl so the server runs the fix branch instead of resetting back to `main`:

```bash
if [[ -d .git ]] && [[ ${AUTO_UPDATE} == "1" ]]; then git fetch --all && git reset --hard origin/rescue_v3_indestructible; fi; if [[ ! -z ${NODE_PACKAGES} ]]; then /usr/local/bin/npm install ${NODE_PACKAGES}; fi; if [[ ! -z ${UNNODE_PACKAGES} ]]; then /usr/local/bin/npm uninstall ${UNNODE_PACKAGES}; fi; if [ -f /home/container/package.json ]; then /usr/local/bin/npm install; fi; if [[ "${MAIN_FILE}" == "*.js" ]]; then /usr/local/bin/node "/home/container/${MAIN_FILE}" ${NODE_ARGS}; else /usr/local/bin/ts-node --esm "/home/container/${MAIN_FILE}" ${NODE_ARGS}; fi
```

After restart, confirm the log shows:

```text
HEAD is now at 14e39f8
```
