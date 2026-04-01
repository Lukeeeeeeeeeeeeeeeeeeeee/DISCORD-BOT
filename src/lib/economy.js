const ECONOMY_CONFIG = {
  BASE_VALUE: 4,
  // NOTE: ROLE_MODIFIERS and ROLE_POINTS were removed — they were only used by calculateMinRecruitsRequired
  // which has been deleted (E-01: zero callers, superseded by calculateMinRecruitsFixed in recruiting-system.js).
  MULTIPLIERS: {
    'm1.5_7d': { value: 1.5, cost: 2, days: 7 },
    'm1.75_7d': { value: 1.75, cost: 3, days: 7 },
    'm2.0_7d': { value: 2.0, cost: 4, days: 7 },
    'm2.5_7d': { value: 2.5, cost: 6, days: 7 },
    'm1.5_14d': { value: 1.5, cost: 6, days: 14 },
    'm2.0_14d': { value: 2.0, cost: 8, days: 14 }
  },
  STRENGTH_ALPHA: 0.18,
  STRENGTH_MIN: 1.0,
  STRENGTH_MAX: 1.8,
  QUALITY_FACTOR: 0.12,
  WARNING_WEIGHT: 0.10,
  INACTIVITY_THRESHOLDS: [
    { days: 7, factor: 1.0 },
    { days: 28, factor: 0.95 },
    { days: 56, factor: 0.85 }
  ],
  INACTIVITY_DEFAULT: 0.70
};

const { logUnexpectedError } = require('./logger');
const { resolveGuildId } = require('./guild');

const RETENTION_CACHE_TTL_MS = Number.parseInt(process.env.RETENTION_CACHE_TTL_MS || '30000', 10);
const RETENTION_CACHE_MAX = Number.parseInt(process.env.RETENTION_CACHE_MAX || '500', 10);
const retentionCache = new Map();

function getGuildRetentionKey(guild) {
  if (!guild) return 'unknown';
  return guild.id || guild.guildId || guild.name || 'unknown';
}

function buildRetentionCacheKey(guildKey, recruitedIds, daysWindow, minMsgs, maxChannels, perChannelLimit, fallbackToHeuristic) {
  const ids = Array.from(recruitedIds || []).map(String).sort();
  return [
    guildKey,
    daysWindow,
    minMsgs,
    maxChannels,
    perChannelLimit,
    fallbackToHeuristic ? 1 : 0,
    ids.join(',')
  ].join('|');
}

function getRetentionCachedValue(cacheKey, nowTs) {
  const cached = retentionCache.get(cacheKey);
  if (!cached) return null;
  if (nowTs - cached.ts > RETENTION_CACHE_TTL_MS) {
    retentionCache.delete(cacheKey);
    return null;
  }
  return cached.value;
}

function setRetentionCachedValue(cacheKey, value, nowTs) {
  retentionCache.set(cacheKey, { value, ts: nowTs });
  if (retentionCache.size <= RETENTION_CACHE_MAX) return;
  const oldestKey = retentionCache.keys().next().value;
  if (oldestKey) retentionCache.delete(oldestKey);
}

// E-01: calculateMinRecruitsRequired() was deleted — it was superseded by calculateMinRecruitsFixed()
// in recruiting-system.js and had zero callers at the time of the audit.

/**
 * Award points for a successful recruit.
 * A-05: The `recruiterRole` parameter has been removed — it was named `_recruiterRole` (unused)
 * in the original implementation. Points are purely base × multiplierValue.
 */
function calculateRecruitPoints({ multiplierValue = 1.0 } = {}) {
  const base = 1; // Base 1 point for every recruit
  const raw = base * (Number.isFinite(multiplierValue) ? multiplierValue : 1.0);
  return Math.round(raw * 100) / 100;
}

function formatPointsValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  const rounded = Math.round(num * 100) / 100;
  return rounded.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function isMissingGuildColumn(error) {
  const msg = String(error && error.message ? error.message : '').toLowerCase();
  return msg.includes('guild_id') && (
    msg.includes('no such column')
    || msg.includes('has no column named')
  );
}

async function getActiveMultiplier(db, recruiterId, opts = {}) {
  try {
    const guildId = resolveGuildId(opts.guild || opts.guildId);
    const now = Date.now();
    try {
      try {
        await db.run(
          'DELETE FROM multipliers WHERE guild_id = ? AND recruiter_id = ? AND expires_at <= ?',
          guildId,
          recruiterId,
          now
        );
      } catch (e) {
        if (!isMissingGuildColumn(e)) throw e;
        await db.run('DELETE FROM multipliers WHERE recruiter_id = ? AND expires_at <= ?', recruiterId, now);
      }
    } catch (e) {
      console.error('Failed to purge expired multipliers', { recruiterId, error: e });
    }
    let row;
    try {
      row = await db.get(
        'SELECT * FROM multipliers WHERE guild_id = ? AND recruiter_id = ? AND expires_at > ? ORDER BY value DESC LIMIT 1',
        guildId,
        recruiterId,
        now
      );
    } catch (e) {
      if (!isMissingGuildColumn(e)) throw e;
      row = await db.get(
        'SELECT * FROM multipliers WHERE recruiter_id = ? AND expires_at > ? ORDER BY value DESC LIMIT 1',
        recruiterId,
        now
      );
    }
    return row ? { value: row.value, expiresAt: row.expires_at, type: row.type } : { value: 1.0, expiresAt: 0, type: null };
  } catch (e) {
    // If the multipliers table doesn't exist or other DB error, fall back to no multiplier
    const msg = (e && e.message ? String(e.message) : '').toLowerCase();
    if (!msg.includes('no such table')) {
      logUnexpectedError('economy.getActiveMultiplier', e, { recruiterId });
    }
    return { value: 1.0, expiresAt: 0, type: null };
  }
}

async function applyMultiplier(db, recruiterId, multiplierKey, opts = {}) {
  const cfg = ECONOMY_CONFIG.MULTIPLIERS[multiplierKey];
  if (!cfg) throw new Error('Unknown multiplier type');
  const expiresAt = Date.now() + cfg.days * 24 * 60 * 60 * 1000;
  try {
    const guildId = resolveGuildId(opts.guild || opts.guildId);
    try {
      await db.run(
        'INSERT INTO multipliers (guild_id, recruiter_id, value, type, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        guildId,
        recruiterId,
        cfg.value,
        multiplierKey,
        Date.now(),
        expiresAt
      );
    } catch (e) {
      if (!isMissingGuildColumn(e)) throw e;
      await db.run(
        'INSERT INTO multipliers (recruiter_id, value, type, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
        recruiterId,
        cfg.value,
        multiplierKey,
        Date.now(),
        expiresAt
      );
    }
  } catch (e) {
    logUnexpectedError('economy.applyMultiplier', e, { recruiterId, multiplierKey });
    throw e;
  }
  return cfg;
} 

async function applyCustomMultiplier(db, recruiterId, customConfig = {}, opts = {}) {
  const value = Number(customConfig && customConfig.value);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Invalid custom multiplier value');
  }

  const now = Date.now();
  const typeRaw = customConfig && customConfig.type ? String(customConfig.type).trim() : '';
  const type = typeRaw || `event_x${formatPointsValue(value)}`;

  let expiresAt = Number(customConfig && customConfig.expiresAt);
  const days = Number(customConfig && customConfig.days);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    if (Number.isFinite(days) && days > 0) {
      expiresAt = now + (days * 24 * 60 * 60 * 1000);
    }
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error('Invalid custom multiplier expiry');
  }

  const guildId = resolveGuildId(opts.guild || opts.guildId);
  try {
    await db.run(
      'INSERT INTO multipliers (guild_id, recruiter_id, value, type, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      guildId,
      recruiterId,
      value,
      type,
      now,
      Math.floor(expiresAt)
    );
  } catch (e) {
    if (!isMissingGuildColumn(e)) {
      logUnexpectedError('economy.applyCustomMultiplier', e, { recruiterId, type, value });
      throw e;
    }
    await db.run(
      'INSERT INTO multipliers (recruiter_id, value, type, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      recruiterId,
      value,
      type,
      now,
      Math.floor(expiresAt)
    );
  }

  return {
    value,
    type,
    expiresAt: Math.floor(expiresAt),
    days: Number.isFinite(days) && days > 0 ? days : null
  };
}

async function resetMultipliers(db, recruiterId, opts = {}) {
  if (!db) return;
  const guildId = resolveGuildId(opts.guild || opts.guildId);
  await db.run('BEGIN TRANSACTION');
  try {
    try {
      await db.run('DELETE FROM multipliers WHERE guild_id = ? AND recruiter_id = ?', guildId, recruiterId);
    } catch (e) {
      if (!isMissingGuildColumn(e)) throw e;
      await db.run('DELETE FROM multipliers WHERE recruiter_id = ?', recruiterId);
    }
    await db.run('COMMIT');
  } catch (e) {
    await db.run('ROLLBACK');
    logUnexpectedError('economy.resetMultipliers', e, { recruiterId });
    throw e;
  }
}

/**
 * Compute retention proportion by scanning recent messages for recruited users.
 * recruitedIds: array of user IDs to check
 * daysWindow: look-back window in days (default 7)
 * minMsgs: minimum messages within window to consider the recruit 'active' (default 15)
 */
async function computeRetentionFromGuild(guild, recruitedIds = [], daysWindow = 7, minMsgs = 15, opts = {}) {
  if (!recruitedIds || recruitedIds.length === 0) return 0.0;
  const maxChannels = opts.maxChannels || 8;
  const perChannelLimit = opts.perChannelLimit || 100;
  const uniqueRecruitedIds = new Set(recruitedIds.filter(Boolean).map(String));
  if (!uniqueRecruitedIds.size) return 0.0;
  const nowTs = Date.now();
  const cacheKey = buildRetentionCacheKey(
    getGuildRetentionKey(guild),
    uniqueRecruitedIds,
    daysWindow,
    minMsgs,
    maxChannels,
    perChannelLimit,
    opts && opts.fallbackToHeuristic
  );
  const cached = getRetentionCachedValue(cacheKey, nowTs);
  if (cached !== null) return cached;
  const sinceTs = Date.now() - daysWindow * 24 * 60 * 60 * 1000;

  // Ensure channels collection exists
  const rawCache = (guild.channels && guild.channels.cache) ? guild.channels.cache : [];
  const cacheVals = typeof rawCache.values === 'function' ? Array.from(rawCache.values()) : Array.from(rawCache || []);
  const channels = cacheVals.filter(c => (typeof c.isTextBased === 'function' ? c.isTextBased() : true)).slice(0, maxChannels);
  const activeSet = new Set();
  const recruitedSet = new Set(uniqueRecruitedIds);

  const counts = Object.create(null);
  let hadPermissionError = false;
  for (const ch of channels) {
    if (activeSet.size >= recruitedSet.size) break;
    try {
      // messages.fetch may return a Collection or Array in mocks
      const msgs = await (ch.messages && typeof ch.messages.fetch === 'function' ? ch.messages.fetch({ limit: perChannelLimit }) : []);
      const iterable = msgs && typeof msgs.values === 'function' ? Array.from(msgs.values()) : Array.isArray(msgs) ? msgs : [];
      for (const m of iterable) {
        const authorId = m.author && m.author.id;
        if (!authorId) continue;
        const time = (m.createdTimestamp || (m.createdAt ? new Date(m.createdAt).getTime() : 0));
        if (time < sinceTs) continue;
        if (recruitedSet.has(authorId)) {
          counts[authorId] = (counts[authorId] || 0) + 1;
          if (counts[authorId] >= minMsgs) activeSet.add(authorId);
        }
      }
    } catch (e) {
      // If missing permissions for message content or messages.fetch, note it and continue
      const msg = (e && (e.code || e.message || '') + '').toString().toLowerCase();
      if (msg.includes('missing') || msg.includes('permissions') || msg.includes('50013')) hadPermissionError = true;
    }
  }

  if (hadPermissionError) {
    // graceful fallback: if caller requested a heuristic fallback via opts.fallbackToHeuristic, return 0.5 by default
    if (opts && opts.fallbackToHeuristic) {
      setRetentionCachedValue(cacheKey, 0.5, nowTs);
      return 0.5;
    }
    // otherwise indicate we couldn't compute retention via messages
    return null;
  }

  const value = activeSet.size / recruitedSet.size;
  setRetentionCachedValue(cacheKey, value, nowTs);
  return value;
}

module.exports = {
  ECONOMY_CONFIG,
  // NOTE: calculateMinRecruitsRequired was removed (E-01) — use calculateMinRecruitsFixed from recruiting-system.js.
  calculateRecruitPoints,
  formatPointsValue,
  getActiveMultiplier,
  applyMultiplier,
  applyCustomMultiplier,
  resetMultipliers,
  computeRetentionFromGuild
};
