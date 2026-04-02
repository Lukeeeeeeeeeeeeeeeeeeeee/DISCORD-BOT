const { envBool, envInt } = require('./env-utils');

function trimString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function splitCsv(value) {
  return trimString(value)
    .split(',')
    .map((entry) => trimString(entry))
    .filter(Boolean);
}

function buildRuntimeConfig(env = process.env, opts = {}) {
  const guildId = trimString(opts.guildId || env.GUILD_ID || '', '');
  const shutdownStepTimeoutMs = envInt('SHUTDOWN_STEP_TIMEOUT_MS', 4000, 1000, 60000);

  return {
    botRuntimeMode: trimString(env.BOT_RUNTIME_MODE, 'main').toLowerCase(),
    enableMessageContent: envBool('ENABLE_MESSAGE_CONTENT', false),
    inviteSnapshotTtlMs: envInt('INVITE_SNAPSHOT_TTL_MS', 900000, 0, 86400000),
    shutdownStepTimeoutMs,
    shutdownAnalyticsTimeoutMs: envInt('SHUTDOWN_ANALYTICS_TIMEOUT_MS', 10000, 1000, 120000),
    shutdownAntinukeSaveTimeoutMs: envInt('SHUTDOWN_ANTINUKE_SAVE_TIMEOUT_MS', shutdownStepTimeoutMs, 1000, 120000),
    enforcedMemberId: trimString(env.BOOT_ENFORCED_MEMBER_ID),
    enforcedRoleId: trimString(env.BOOT_ENFORCED_ROLE_ID),
    enforcedGuildId: trimString(env.BOOT_ENFORCED_GUILD_ID || guildId),
    enforcedCheckIntervalMs: envInt('BOOT_ENFORCED_CHECK_INTERVAL_MS', 300000, 15000, 3600000),
    healthcheckPort: envInt('HEALTHCHECK_PORT', 0, 0, 65535),
    healthcheckPath: trimString(env.HEALTHCHECK_PATH, '/healthz'),
    aecsTelemetryChannelId: trimString(env.AECS_TELEMETRY_CHANNEL_ID),
    dmWorkerId: trimString(env.DM_WORKER_ID),
    dmWorkerDisplayName: trimString(env.DM_WORKER_DISPLAY_NAME),
    dmWorkerTokens: splitCsv(env.DM_WORKER_TOKENS),
    enableInternalWorker: envBool('ENABLE_INTERNAL_WORKER', true)
  };
}

module.exports = { buildRuntimeConfig };
