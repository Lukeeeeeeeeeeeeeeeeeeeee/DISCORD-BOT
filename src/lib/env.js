function sanitizeEnvToken(rawToken) {
  if (!rawToken) return null;
  let token = String(rawToken).trim();
  if (!token) return null;
  const first = token[0];
  const last = token[token.length - 1];
  if ((first === '"' && last === '"') || (first === '\'' && last === '\'') || (first === '`' && last === '`')) {
    token = token.slice(1, -1).trim();
  }
  token = token.replace(/[\r\n\t]/g, '').trim();
  return token || null;
}

function parseBooleanEnv(rawValue, defaultValue = false) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
    return defaultValue;
  }
  return String(rawValue).trim().toLowerCase() === 'true';
}

function validateRuntimeEnvironment(opts = {}) {
  const minNodeMajor = Number.isFinite(opts.minNodeMajor) ? opts.minNodeMajor : 18;
  const version = process.versions && process.versions.node ? String(process.versions.node) : '';
  const major = Number.parseInt(version.split('.')[0] || '0', 10);
  if (!Number.isFinite(major) || major < minNodeMajor) {
    throw new Error(`Node.js ${minNodeMajor}+ is required. Current runtime: ${version || 'unknown'}`);
  }

  const warnings = [];

  const numericEnvChecks = [
    { name: 'SQLITE_BUSY_TIMEOUT_MS', min: 1000, max: 120000 },
    { name: 'SHARD_HEARTBEAT_CHECK_MS', min: 5000, max: 300000 },
    { name: 'SHARD_HEARTBEAT_TIMEOUT_MS', min: 10000, max: 900000 },
    { name: 'LEADERBOARD_FULL_FETCH_COOLDOWN_MS', min: 1000, max: 3600000 },
    { name: 'RECRUITMENT_REPORT_CONCURRENCY', min: 1, max: 64 },
    { name: 'RECALC_CONCURRENCY', min: 1, max: 64 },
    { name: 'SNAPSHOT_CONCURRENCY', min: 1, max: 64 }
  ];

  for (const check of numericEnvChecks) {
    const raw = process.env[check.name];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const value = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(value)) {
      warnings.push(`${check.name} is not a valid number (${raw}).`);
      continue;
    }
    if (value < check.min || value > check.max) {
      warnings.push(`${check.name}=${value} is outside recommended range [${check.min}, ${check.max}].`);
    }
  }

  if (!process.env.OWNER_ID && !process.env.ANTINUKE_OWNER_ID) {
    warnings.push('OWNER_ID / ANTINUKE_OWNER_ID is not configured; owner-only recovery features will be limited.');
  }

  const encryptionKey = process.env.ANTINUKE_ENCRYPTION_KEY
    ? String(process.env.ANTINUKE_ENCRYPTION_KEY).trim()
    : '';
  const requireBackupEncryption = parseBooleanEnv(process.env.ANTINUKE_REQUIRE_ENCRYPTION, true);
  const allowUnencryptedBackups = parseBooleanEnv(process.env.ANTINUKE_ALLOW_UNENCRYPTED_BACKUPS, false);

  if (encryptionKey) {
    const keyBytes = Buffer.byteLength(encryptionKey, 'utf8');
    if (keyBytes < 32) {
      throw new Error('ANTINUKE_ENCRYPTION_KEY must be at least 32 bytes.');
    }
  } else if (requireBackupEncryption || !allowUnencryptedBackups) {
    throw new Error('ANTINUKE_ENCRYPTION_KEY is required. Set it, or explicitly set ANTINUKE_ALLOW_UNENCRYPTED_BACKUPS=true for insecure local-only mode.');
  } else {
    warnings.push('Running with unencrypted anti-nuke backups (ANTINUKE_ALLOW_UNENCRYPTED_BACKUPS=true).');
  }

  if (!process.env.GUILD_ID) {
    warnings.push('GUILD_ID is not configured; scheduler and guild-scoped jobs may be disabled.');
  }
  return warnings;
}

module.exports = {
  sanitizeEnvToken,
  validateRuntimeEnvironment
};
