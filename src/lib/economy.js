const ECONOMY_CONFIG = {
  BASE_VALUE: 4,
  ROLE_MODIFIERS: {
    NONE: 1.00,
    VIP: 0.90,
    MVP: 0.85,
    CUSTOM: 0.80
  },
  ROLE_POINTS: {
    NONE: 0,
    VIP: 25,
    MVP: 35,
    CUSTOM: 50
  },
  MULTIPLIERS: {
    'm1.15_14d': { value: 1.15, cost: 10, days: 14 },
    'm1.25_14d': { value: 1.25, cost: 15, days: 14 },
    'm1.5_7d': { value: 1.5, cost: 15, days: 7 },
    'm2.0_7d': { value: 2.0, cost: 25, days: 7 }
  },
  STRENGTH_ALPHA: 0.18,
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

function calculateMinRecruitsRequired({
  channelBase = ECONOMY_CONFIG.BASE_VALUE,
  roleModifier = ECONOMY_CONFIG.ROLE_MODIFIERS.NONE,
  total28d = 0,
  distinctWeeks = 1,
  retention = 0,
  activeWarnings = 0,
  daysSinceLastRecruit = Number.POSITIVE_INFINITY,
  activeMultiplierValue = 1.0
} = {}) {
  const B = channelBase;
  const R = roleModifier;
  const T = Math.max(0, total28d);
  const Wk = Math.max(1, Math.min(4, Math.floor(distinctWeeks) || 1));
  const activityRate = T / Wk;
  let S = 1 + ECONOMY_CONFIG.STRENGTH_ALPHA * Math.log(1 + activityRate);
  S = Math.min(S, ECONOMY_CONFIG.STRENGTH_MAX);
  const Q = 1 + ECONOMY_CONFIG.QUALITY_FACTOR * Math.max(0, Math.min(1, retention));
  const W = 1 + ECONOMY_CONFIG.WARNING_WEIGHT * Math.max(0, activeWarnings);

  let I = ECONOMY_CONFIG.INACTIVITY_DEFAULT;
  if (daysSinceLastRecruit < 7) I = 1.0;
  else if (daysSinceLastRecruit < 28) I = 0.95;
  else if (daysSinceLastRecruit < 56) I = 0.85;
  else I = 0.70;

  const M = Math.max(1.0, activeMultiplierValue);
  const raw = (B * R * S * Q * W * I) / Math.sqrt(M);
  const minReq = Math.ceil(raw);
  return Math.max(2, Math.min(8, minReq));
}

function calculateRecruitPoints({ recruiterRole: _recruiterRole = 'NONE', multiplierValue = 1.0 } = {}) {
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

async function getActiveMultiplier(db, recruiterId) {
  try {
    const now = Date.now();
    await db.run('DELETE FROM multipliers WHERE recruiter_id = ? AND expires_at <= ?', recruiterId, now).catch(() => { });
    const row = await db.get('SELECT * FROM multipliers WHERE recruiter_id = ? AND expires_at > ? ORDER BY value DESC LIMIT 1', recruiterId, now);
    return row ? { value: row.value, expiresAt: row.expires_at, type: row.type } : { value: 1.0, expiresAt: 0, type: null };
  } catch (e) {
    // If the multipliers table doesn't exist or other DB error, fall back to no multiplier
    return { value: 1.0, expiresAt: 0, type: null };
  }
}

async function applyMultiplier(db, recruiterId, multiplierKey) {
  const cfg = ECONOMY_CONFIG.MULTIPLIERS[multiplierKey];
  if (!cfg) throw new Error('Unknown multiplier type');
  const expiresAt = Date.now() + cfg.days * 24 * 60 * 60 * 1000;
  await db.run('INSERT INTO multipliers (recruiter_id, value, type, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', recruiterId, cfg.value, multiplierKey, Date.now(), expiresAt);
  return cfg;
} 

async function resetMultipliers(db, recruiterId) {
  await db.run('DELETE FROM multipliers WHERE recruiter_id = ?', recruiterId);
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
  const sinceTs = Date.now() - daysWindow * 24 * 60 * 60 * 1000;

  // Ensure channels collection exists
  const rawCache = (guild.channels && guild.channels.cache) ? guild.channels.cache : [];
  const cacheVals = typeof rawCache.values === 'function' ? Array.from(rawCache.values()) : Array.from(rawCache || []);
  const channels = cacheVals.filter(c => (typeof c.isTextBased === 'function' ? c.isTextBased() : true)).slice(0, maxChannels);
  const activeSet = new Set();

const counts = Object.create(null);
  let hadPermissionError = false;
  for (const ch of channels) {
    if (activeSet.size >= recruitedIds.length) break;
    try {
      // messages.fetch may return a Collection or Array in mocks
      const msgs = await (ch.messages && typeof ch.messages.fetch === 'function' ? ch.messages.fetch({ limit: perChannelLimit }) : []);
      const iterable = msgs && typeof msgs.values === 'function' ? Array.from(msgs.values()) : Array.isArray(msgs) ? msgs : [];
      for (const m of iterable) {
        const authorId = m.author && m.author.id;
        if (!authorId) continue;
        const time = (m.createdTimestamp || (m.createdAt ? new Date(m.createdAt).getTime() : 0));
        if (time < sinceTs) continue;
        if (recruitedIds.includes(authorId)) {
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
    if (opts && opts.fallbackToHeuristic) return 0.5;
    // otherwise indicate we couldn't compute retention via messages by returning -1
    return -1;
  }

  return activeSet.size / recruitedIds.length;
}

module.exports = {
  ECONOMY_CONFIG,
  calculateMinRecruitsRequired,
  calculateRecruitPoints,
  formatPointsValue,
  getActiveMultiplier,
  applyMultiplier,
  resetMultipliers,
  computeRetentionFromGuild
};
