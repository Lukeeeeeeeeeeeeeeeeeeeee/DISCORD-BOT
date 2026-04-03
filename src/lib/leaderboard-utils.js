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

function isMissingWeeklyOverrideTableError(error) {
  const message = error && error.message ? String(error.message).toLowerCase() : '';
  return message.includes('no such table: weekly_recruit_overrides');
}

function isMissingWeeklyCalculationsTableError(error) {
  const message = error && error.message ? String(error.message).toLowerCase() : '';
  return message.includes('no such table: weekly_calculations');
}

function isMissingRecruitsTableError(error) {
  const message = error && error.message ? String(error.message).toLowerCase() : '';
  return message.includes('no such table: recruits');
}

function buildLeaderboardSql(valuesSql, options = {}) {
  const useOverride = options.useOverride === true;
  const useWeeklyCalculations = options.useWeeklyCalculations !== false;
  const useRecruits = options.useRecruits !== false;
  const region = options.region || null;
  const cntExpr = useOverride
    ? `MAX(COALESCE(wro.total, 0), ${useRecruits ? 'COALESCE(c.cnt, 0)' : '0'})`
    : (useRecruits ? 'COALESCE(c.cnt, 0)' : '0');
  const overrideJoin = useOverride
    ? 'LEFT JOIN weekly_recruit_overrides wro ON wro.guild_id = ? AND wro.recruiter_id = r.id AND wro.week_start = ?'
    : '';
  const weeklyCalcSelect = useWeeklyCalculations ? 'wc.calculated_min_req AS min_req' : 'NULL AS min_req';
  const weeklyCalcJoin = useWeeklyCalculations
    ? 'LEFT JOIN weekly_calculations wc ON wc.guild_id = ? AND wc.recruiter_id = r.id AND wc.week_start = ?'
    : '';
  const regionRecruitJoin = useRecruits
    ? `
      LEFT JOIN (
        SELECT recruiter_id, COUNT(*) as cnt
        FROM recruits
        WHERE guild_id = ? AND region = ? AND valid = 1 AND created_at >= ?
        GROUP BY recruiter_id
      ) c ON c.recruiter_id = r.id`
    : '';
  const globalRecruitJoin = useRecruits
    ? `
    LEFT JOIN (
      SELECT recruiter_id, COUNT(*) as cnt
      FROM recruits
      WHERE guild_id = ? AND valid = 1 AND created_at >= ?
      GROUP BY recruiter_id
    ) c ON c.recruiter_id = r.id`
    : '';

  if (region) {
    return `
      WITH r(id) AS (VALUES ${valuesSql})
      SELECT
        r.id AS recruiter_id,
        ${cntExpr} AS cnt,
        COALESCE(db_rec.points, 0) AS points,
        ${weeklyCalcSelect}
      FROM r
      ${regionRecruitJoin}
      ${overrideJoin}
      LEFT JOIN recruiters db_rec ON db_rec.guild_id = ? AND db_rec.id = r.id
      ${weeklyCalcJoin}
    `;
  }

  return `
    WITH r(id) AS (VALUES ${valuesSql})
    SELECT
      r.id AS recruiter_id,
      ${cntExpr} AS cnt,
      COALESCE(db_rec.points, 0) AS points,
      ${weeklyCalcSelect}
    FROM r
    ${globalRecruitJoin}
    ${overrideJoin}
    LEFT JOIN recruiters db_rec ON db_rec.guild_id = ? AND db_rec.id = r.id
    ${weeklyCalcJoin}
  `;
}

function buildLeaderboardParams(chunk, options = {}) {
  const params = [...chunk];
  if (options.useRecruits !== false) {
    params.push(options.guildId);
    if (options.region) {
      params.push(options.region);
    }
    params.push(options.sinceTs);
  }
  if (options.useOverride) {
    params.push(options.guildId, options.weekStart);
  }
  params.push(options.guildId);
  if (options.useWeeklyCalculations !== false) {
    params.push(options.guildId, options.weekStart);
  }
  return params;
}

async function fetchLeaderboardRows(db, recruiterIds, opts = {}) {
  if (!db || !recruiterIds || !recruiterIds.length) return [];
  const guildId = resolveGuildId(opts.guild || opts.guildId);
  const region = opts.region || null;
  const weekStart = Number.isFinite(opts.weekStart) ? opts.weekStart : null;
  const hasWeekStart = Number.isFinite(weekStart);
  const sinceTs = Number.isFinite(opts.sinceTs) ? opts.sinceTs : weekStart || Date.now();
  const allowMissingTables = opts.allowMissingTables === true || process.env.NODE_ENV === 'test';
  const chunks = chunkArray(recruiterIds, opts.chunkSize);
  const rows = [];

  for (const chunk of chunks) {
    const valuesSql = chunk.map(() => '(?)').join(',');
    if (!valuesSql) continue;
    let queryOptions = {
      guildId,
      region,
      sinceTs,
      weekStart,
      useOverride: hasWeekStart,
      useWeeklyCalculations: true,
      useRecruits: true
    };
    let rowsBase = [];

    for (;;) {
      try {
        rowsBase = await db.all(
          buildLeaderboardSql(valuesSql, queryOptions),
          ...buildLeaderboardParams(chunk, queryOptions)
        );
        break;
      } catch (error) {
        let nextOptions = queryOptions;
        let changed = false;

        if (allowMissingTables && queryOptions.useOverride && isMissingWeeklyOverrideTableError(error)) {
          nextOptions = { ...nextOptions, useOverride: false };
          changed = true;
        }
        if (allowMissingTables && queryOptions.useWeeklyCalculations && isMissingWeeklyCalculationsTableError(error)) {
          nextOptions = { ...nextOptions, useWeeklyCalculations: false, useOverride: false };
          changed = true;
        }
        if (allowMissingTables && queryOptions.useRecruits && isMissingRecruitsTableError(error)) {
          nextOptions = { ...nextOptions, useRecruits: false };
          changed = true;
        }

        if (!changed) throw error;
        queryOptions = nextOptions;
      }
    }
    if (rowsBase && rowsBase.length) rows.push(...rowsBase);
  }

  return rows;
}

async function loadRecruiterIdsFromRecentRecruits(db, opts = {}) {
  if (!db) return [];
  const guildId = resolveGuildId(opts.guild || opts.guildId);
  const sinceTs = Number.isFinite(opts.sinceTs) ? opts.sinceTs : Date.now();
  const region = opts.region || null;

  try {
    const rows = region
      ? await db.all(
        'SELECT DISTINCT recruiter_id FROM recruits WHERE guild_id = ? AND region = ? AND valid = 1 AND created_at >= ?',
        guildId,
        region,
        sinceTs
      )
      : await db.all(
        'SELECT DISTINCT recruiter_id FROM recruits WHERE guild_id = ? AND valid = 1 AND created_at >= ?',
        guildId,
        sinceTs
      );
    return (rows || []).map(row => row && row.recruiter_id).filter(Boolean);
  } catch (error) {
    if (isMissingRecruitsTableError(error)) return [];
    throw error;
  }
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
  loadRecruiterIdsFromRecentRecruits,
  loadRecruiterMeta,
  loadPreviousMinReqs
};
