const { ROLE_IDS, RECRUITER_ROLE_IDS, CHANNELS } = require('../constants');
const { formatPointsValue } = require('./economy');
const { resolveGuildId } = require('./guild');
const { fetchMembersByIds } = require('./member-fetch');

function toUnixSeconds(ms) {
  return Math.floor(ms / 1000);
}

function safeDaysLeftFromEndDate(endDateStr) {
  if (!endDateStr) return null;
  const d = new Date(`${endDateStr}T23:59:59.000Z`);
  const diffMs = d.getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return null;
  return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
}

function formatPct(x) {
  if (!Number.isFinite(x)) return '0%';
  return `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%`;
}

function hasRecruiterRole(member) {
  if (!member || !member.roles || !member.roles.cache) return false;
  const recruiterRoleIds = [
    ROLE_IDS.RECRUITER,
    ROLE_IDS.TRIAL_RECRUITER,
    ...(RECRUITER_ROLE_IDS ? Object.values(RECRUITER_ROLE_IDS) : [])
  ].filter(Boolean);
  return recruiterRoleIds.some(roleId => member.roles.cache.has(roleId));
}

async function getAverageWeeklyRecruits(db, recruiterId, guildId, weeks = 4) {
  try {
    const rows = await db.all(
      'SELECT recruits7d FROM weekly_calculations WHERE guild_id = ? AND recruiter_id = ? ORDER BY COALESCE(week_start, timestamp) DESC LIMIT ?',
      guildId,
      recruiterId,
      weeks
    );
    if (rows && rows.length) {
      const total = rows.reduce((sum, r) => sum + (Number(r.recruits7d) || 0), 0);
      return Math.round((total / rows.length) * 10) / 10;
    }
  } catch (e) {
    console.error(e);
  }

  try {
    const since = Date.now() - (28 * 24 * 60 * 60 * 1000);
    const row = await db.get(
      'SELECT COUNT(*) as c FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1 AND created_at >= ?',
      guildId,
      recruiterId,
      since
    );
    const count = row ? Number(row.c || 0) : 0;
    return Math.round((count / 4) * 10) / 10;
  } catch (e) {
    return 0;
  }
}

async function getAverageWeeklyRecruitsMap(db, recruiterIds, guildId, weeks = 4) {
  const ids = Array.isArray(recruiterIds) ? recruiterIds.filter(Boolean) : [];
  const map = new Map();
  if (!ids.length) return map;

  const safeWeeks = Number.isFinite(weeks) && weeks > 0 ? Math.floor(weeks) : 4;

  try {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT recruiter_id, recruits7d, COALESCE(week_start, timestamp) AS sort_ts
       FROM weekly_calculations
       WHERE guild_id = ? AND recruiter_id IN (${placeholders})
       ORDER BY recruiter_id ASC, sort_ts DESC`,
      guildId,
      ...ids
    );

    const agg = new Map();
    for (const row of rows || []) {
      if (!row || !row.recruiter_id) continue;
      const key = row.recruiter_id;
      let cur = agg.get(key);
      if (!cur) {
        cur = { count: 0, total: 0 };
        agg.set(key, cur);
      }
      if (cur.count >= safeWeeks) continue;
      cur.count += 1;
      cur.total += Number(row.recruits7d || 0);
    }

    for (const [id, cur] of agg.entries()) {
      if (!cur.count) continue;
      map.set(id, Math.round((cur.total / cur.count) * 10) / 10);
    }
  } catch (e) {
    console.error(e);
  }

  const unresolved = ids.filter(id => !map.has(id));
  if (!unresolved.length) return map;

  try {
    const since = Date.now() - (28 * 24 * 60 * 60 * 1000);
    const placeholders = unresolved.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT recruiter_id, COUNT(*) AS c
       FROM recruits
       WHERE guild_id = ? AND valid = 1 AND created_at >= ? AND recruiter_id IN (${placeholders})
       GROUP BY recruiter_id`,
      guildId,
      since,
      ...unresolved
    );
    const fallbackCounts = new Map();
    for (const row of rows || []) {
      if (!row || !row.recruiter_id) continue;
      fallbackCounts.set(row.recruiter_id, Number(row.c || 0));
    }

    for (const id of unresolved) {
      const count = fallbackCounts.has(id) ? fallbackCounts.get(id) : 0;
      map.set(id, Math.round((count / 4) * 10) / 10);
    }
  } catch (e) {
    for (const id of unresolved) {
      if (!map.has(id)) map.set(id, 0);
    }
  }

  return map;
}

async function postPurchaseLog({ guild, userId, item, cost }) {
  if (!guild) return;
  try {
    const channelId = CHANNELS && CHANNELS.ECONOMY_NOTIFICATIONS;
    if (!channelId) return;
    const channel = guild.channels && guild.channels.cache
      ? guild.channels.cache.get(channelId)
      : null;
    if (channel && channel.send) {
      const formattedCost = formatPointsValue(cost);
      await channel.send(`<@${userId}> bought **${item}** for **${formattedCost}** pts!`).catch(err => {
        console.error('Failed to post purchase log:', err);
      });
    }
  } catch (e) {
    // best-effort logging
  }
}

async function computeRetentionCounts({ db, guild, recruiterId, cohortStartMs, cohortEndMs, cap = 30 } = {}) {
  if (!db || !guild || !recruiterId) return { cohortSize: 0, retained: 0, sampled: false };

  const rows = await db.all(
    'SELECT recruited_id, created_at FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1 AND created_at >= ? AND created_at < ? ORDER BY created_at DESC',
    resolveGuildId(guild),
    recruiterId,
    cohortStartMs,
    cohortEndMs
  );

  const cohortSize = rows ? rows.length : 0;
  const slice = rows && rows.length > cap ? rows.slice(0, cap) : (rows || []);
  const sampled = !!rows && rows.length > cap;

  const ids = slice.map(r => r.recruited_id);
  const members = await fetchMembersByIds(guild, ids).catch(() => new Map());
  return { cohortSize, retained: members.size, sampled };
}

module.exports = {
  toUnixSeconds,
  safeDaysLeftFromEndDate,
  formatPct,
  hasRecruiterRole,
  getAverageWeeklyRecruits,
  getAverageWeeklyRecruitsMap,
  postPurchaseLog,
  computeRetentionCounts
};

