const DEFAULT_CHUNK_SIZE = Number.parseInt(process.env.LEADERBOARD_CHUNK_SIZE || '400', 10);
const { resolveGuildId } = require('./guild');

function chunkArray(items, size = DEFAULT_CHUNK_SIZE) {
  const out = [];
  if (!items || !items.length) return out;
  const safeSize = Math.max(1, size || DEFAULT_CHUNK_SIZE);
  for (let i = 0; i < items.length; i += safeSize) {
    out.push(items.slice(i, i + safeSize));
  }
  return out;
}

async function fetchLeaderboardRows(db, recruiterIds, opts = {}) {
  if (!db || !recruiterIds || !recruiterIds.length) return [];
  const guildId = resolveGuildId(opts.guild || opts.guildId);
  const region = opts.region || null;
  const weekStart = opts.weekStart || null;
  const sinceTs = Number.isFinite(opts.sinceTs) ? opts.sinceTs : weekStart || Date.now();
  const chunks = chunkArray(recruiterIds, opts.chunkSize);
  const rows = [];

  for (const chunk of chunks) {
    const valuesSql = chunk.map(() => '(?)').join(',');
    if (!valuesSql) continue;

    if (region) {
      const rowsBase = await db.all(`
        WITH r(id) AS (VALUES ${valuesSql})
        SELECT
          r.id AS recruiter_id,
          COALESCE(c.cnt, 0) AS cnt,
          COALESCE(db_rec.points, 0) AS points,
          wc.calculated_min_req AS min_req
        FROM r
        LEFT JOIN (
          SELECT recruiter_id, COUNT(*) as cnt
          FROM recruits
          WHERE guild_id = ? AND region = ? AND valid = 1 AND created_at >= ?
          GROUP BY recruiter_id
        ) c ON c.recruiter_id = r.id
        LEFT JOIN recruiters db_rec ON db_rec.guild_id = ? AND db_rec.id = r.id
        LEFT JOIN weekly_calculations wc ON wc.guild_id = ? AND wc.recruiter_id = r.id AND wc.week_start = ?
      `, ...chunk, guildId, region, sinceTs, guildId, guildId, weekStart);
      if (rowsBase && rowsBase.length) rows.push(...rowsBase);
    } else {
      const rowsBase = await db.all(`
        WITH r(id) AS (VALUES ${valuesSql})
        SELECT
          r.id AS recruiter_id,
          COALESCE(c.cnt, 0) AS cnt,
          COALESCE(db_rec.points, 0) AS points,
          wc.calculated_min_req AS min_req
        FROM r
        LEFT JOIN (
          SELECT recruiter_id, COUNT(*) as cnt
          FROM recruits
          WHERE guild_id = ? AND valid = 1 AND created_at >= ?
          GROUP BY recruiter_id
        ) c ON c.recruiter_id = r.id
        LEFT JOIN recruiters db_rec ON db_rec.guild_id = ? AND db_rec.id = r.id
        LEFT JOIN weekly_calculations wc ON wc.guild_id = ? AND wc.recruiter_id = r.id AND wc.week_start = ?
      `, ...chunk, guildId, sinceTs, guildId, guildId, weekStart);
      if (rowsBase && rowsBase.length) rows.push(...rowsBase);
    }
  }

  return rows;
}

async function loadRecruiterMeta(db, recruiterIds, opts = {}) {
  const absencesMap = new Map();
  const warningsMap = new Map();
  const systemWarnSet = new Set();
  if (!db || !recruiterIds || recruiterIds.length === 0) {
    return { absences: absencesMap, warnings: warningsMap, systemWarnings: systemWarnSet };
  }

  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const guildId = resolveGuildId(opts.guild || opts.guildId);
  const chunks = chunkArray(recruiterIds, opts.chunkSize);
  for (const chunk of chunks) {
    const placeholders = chunk.map(() => '?').join(',');
    if (!placeholders) continue;
    try {
      const [absences, warnings, systemWarnings] = await Promise.all([
        db.all(
          `SELECT recruiter_id FROM absences WHERE guild_id = ? AND active = 1 AND end_date >= date("now") AND recruiter_id IN (${placeholders})`,
          guildId,
          ...chunk
        ).catch(() => []),
        db.all(
          `SELECT recruiter_id, COUNT(*) as c FROM warnings WHERE guild_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?) AND recruiter_id IN (${placeholders}) GROUP BY recruiter_id`,
          guildId,
          now,
          ...chunk
        ).catch(() => []),
        db.all(
          `SELECT recruiter_id FROM warnings WHERE guild_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?) AND note LIKE ? AND recruiter_id IN (${placeholders}) GROUP BY recruiter_id`,
          guildId,
          now,
          'Quota warning%',
          ...chunk
        ).catch(() => [])
      ]);

      (absences || []).forEach(row => absencesMap.set(row.recruiter_id, true));
      (warnings || []).forEach(row => warningsMap.set(row.recruiter_id, Number(row.c || 0)));
      (systemWarnings || []).forEach(row => systemWarnSet.add(row.recruiter_id));
    } catch (e) {
      console.error('Failed to load recruiter meta chunk:', e);
    }
  }

  return { absences: absencesMap, warnings: warningsMap, systemWarnings: systemWarnSet };
}

async function loadPreviousMinReqs(db, recruiterIds, weekStart, opts = {}) {
  const map = new Map();
  if (!db || !recruiterIds || !recruiterIds.length || !Number.isFinite(weekStart)) return map;
  const guildId = resolveGuildId(opts.guild || opts.guildId);
  const chunks = chunkArray(recruiterIds, opts.chunkSize);
  for (const chunk of chunks) {
    const placeholders = chunk.map(() => '?').join(',');
    if (!placeholders) continue;
    const rows = await db.all(
      `SELECT recruiter_id, calculated_min_req, week_start
       FROM weekly_calculations
       WHERE guild_id = ? AND week_start < ? AND recruiter_id IN (${placeholders})
       ORDER BY week_start DESC`,
      guildId,
      weekStart,
      ...chunk
    ).catch(() => []);
    for (const row of rows || []) {
      if (!map.has(row.recruiter_id)) {
        map.set(row.recruiter_id, row.calculated_min_req);
      }
    }
  }
  return map;
}

module.exports = {
  chunkArray,
  fetchLeaderboardRows,
  loadRecruiterMeta,
  loadPreviousMinReqs
};
