const { resolveGuildId } = require('./guild');
const { fetchMembersByIds } = require('./member-fetch');

/**
 * Batched calculation of 7-day stats for multiple recruiters.
 * Replaces O(N) queries with O(1) bulk queries.
 */
async function batchCalculate7DayStats(database, recruiterIds, guild, opts = {}) {
  if (!recruiterIds || recruiterIds.length === 0) return new Map();
  
  const guildId = resolveGuildId(guild || opts.guildId);
  const windowEnd = Number.isFinite(opts.untilTs) ? opts.untilTs : Date.now();
  const windowStart = Number.isFinite(opts.sinceTs)
    ? opts.sinceTs
    : (windowEnd - (7 * 24 * 60 * 60 * 1000));
  
  const retentionEnd = Number.isFinite(opts.retentionEndTs) ? opts.retentionEndTs : (windowStart || (Date.now() - (7 * 24 * 60 * 60 * 1000)));
  const retentionStart = Number.isFinite(opts.retentionStartTs)
    ? opts.retentionStartTs
    : (retentionEnd - (7 * 24 * 60 * 60 * 1000));

  const statsMap = new Map();
  // Initialize map for all requested IDs
  for (const id of recruiterIds) {
    statsMap.set(id, { recruits7d: 0, activityRate: 0, verifyRate: 0, retention: 0 });
  }

  try {
    const placeholders = recruiterIds.map(() => '?').join(',');
    
    // 1. Bulk Recruit Counts
    const regionFilter = opts.region ? ' AND region = ?' : '';
    const recruitParams = [guildId, ...recruiterIds];
    if (opts.region) recruitParams.push(opts.region);
    recruitParams.push(windowStart, windowEnd);

    const recruitRows = await database.all(
      `SELECT recruiter_id, COUNT(*) as c 
       FROM recruits 
       WHERE guild_id = ? AND recruiter_id IN (${placeholders})${regionFilter} AND created_at >= ? AND created_at < ? AND valid = 1
       GROUP BY recruiter_id`,
      ...recruitParams
    );
    
    for (const row of recruitRows) {
      if (statsMap.has(row.recruiter_id)) {
        const stats = statsMap.get(row.recruiter_id);
        stats.recruits7d = Number(row.c || 0);
        stats.activityRate = stats.recruits7d;
      }
    }

    // 2. Bulk Overrides
    const overrideRows = await database.all(
      `SELECT recruiter_id, total 
       FROM weekly_recruit_overrides 
       WHERE guild_id = ? AND recruiter_id IN (${placeholders}) AND week_start = ?`,
      guildId, ...recruiterIds, windowStart
    ).catch(() => []);
    
    for (const row of overrideRows) {
      if (statsMap.has(row.recruiter_id) && Number.isFinite(Number(row.total))) {
        const stats = statsMap.get(row.recruiter_id);
        stats.recruits7d = Math.max(0, Number(row.total));
        stats.activityRate = stats.recruits7d;
      }
    }

    // 3. Bulk Verification Rates
    const verifyParams = [guildId, ...recruiterIds];
    if (opts.region) verifyParams.push(opts.region);
    verifyParams.push(windowStart, windowEnd);

    const verifyRows = await database.all(
      `SELECT r.recruiter_id, COUNT(*) as c
       FROM recruits r
       INNER JOIN verifications v ON v.guild_id = r.guild_id AND v.recruited_id = r.recruited_id
       WHERE r.guild_id = ? AND r.recruiter_id IN (${placeholders})${regionFilter} AND r.created_at >= ? AND r.created_at < ? AND r.valid = 1
       GROUP BY r.recruiter_id`,
      ...verifyParams
    ).catch(() => []);

    for (const row of verifyRows) {
      if (statsMap.has(row.recruiter_id)) {
        const stats = statsMap.get(row.recruiter_id);
        stats.verifyRate = stats.recruits7d > 0 ? (Number(row.c || 0) / stats.recruits7d) : 0;
        stats.verifyRate = Math.max(0, Math.min(1, stats.verifyRate));
      }
    }

    // 4. Bulk Retention Cohorts
    const retentionParams = [guildId, ...recruiterIds];
    if (opts.region) retentionParams.push(opts.region);
    retentionParams.push(retentionStart, retentionEnd);

    const retentionCohortRows = await database.all(
      `SELECT recruiter_id, recruited_id 
       FROM recruits 
       WHERE guild_id = ? AND recruiter_id IN (${placeholders})${regionFilter} AND created_at >= ? AND created_at < ? AND valid = 1`,
      ...retentionParams
    );

    if (retentionCohortRows.length > 0 && guild) {
      const allRecruitedIds = Array.from(new Set(retentionCohortRows.map(r => r.recruited_id)));
      const memberMap = await fetchMembersByIds(guild, allRecruitedIds).catch(() => new Map());
      
      const cohortByRecruiter = new Map();
      for (const row of retentionCohortRows) {
        if (!cohortByRecruiter.has(row.recruiter_id)) cohortByRecruiter.set(row.recruiter_id, { total: 0, present: 0 });
        const c = cohortByRecruiter.get(row.recruiter_id);
        c.total++;
        if (memberMap.has(row.recruited_id)) c.present++;
      }
      
      for (const [id, c] of cohortByRecruiter.entries()) {
        if (statsMap.has(id)) {
          const stats = statsMap.get(id);
          stats.retention = c.total > 0 ? (c.present / c.total) : 0;
          stats.retention = Math.max(0, Math.min(1, stats.retention));
        }
      }
    }

    return statsMap;
  } catch (e) {
    console.error('Error in batchCalculate7DayStats:', e);
    return statsMap;
  }
}

/**
 * Single-query batch replacement for per-recruiter isNewStaff() calls.
 * Aligning with isNewStaff() logic: first check analytics_role_changes, then fallback to calculation counts.
 */
async function batchIsNewStaff(db, recruiterIds, guildId, newStaffWindow = 14 * 24 * 60 * 60 * 1000) {
  if (!recruiterIds || recruiterIds.length === 0) return new Map();
  const { ROLE_IDS, RECRUITER_ROLE_IDS } = require('../constants');
  
  const cutoff = Date.now() - newStaffWindow;
  const result = new Map();
  for (const id of recruiterIds) result.set(id, false);

  try {
    const recruiterRoleIds = [
      ROLE_IDS.RECRUITER,
      ROLE_IDS.TRIAL_RECRUITER,
      ...(RECRUITER_ROLE_IDS ? Object.values(RECRUITER_ROLE_IDS) : [])
    ].filter(Boolean);

    const placeholders = recruiterIds.map(() => '?').join(',');
    const rolePlaceholders = recruiterRoleIds.map(() => '?').join(',');

    // 1. Check role change history
    if (recruiterRoleIds.length) {
      const rows = await db.all(
        `SELECT user_id, MAX(created_at) as last_added
         FROM analytics_role_changes
         WHERE guild_id = ? AND action = 'added' 
         AND user_id IN (${placeholders})
         AND role_id IN (${rolePlaceholders})
         GROUP BY user_id`,
        guildId, ...recruiterIds, ...recruiterRoleIds
      );
      for (const row of rows) {
        if (row && row.last_added && Number(row.last_added) >= cutoff) {
          result.set(row.user_id, true);
        }
      }
    }

    // 2. For those still false, check calculation counts (less than 2 weeks of history)
    const pendingIds = recruiterIds.filter(id => !result.get(id));
    if (pendingIds.length) {
      const pendingPlaceholders = pendingIds.map(() => '?').join(',');
      const rows = await db.all(
        `SELECT recruiter_id, COUNT(*) as c 
         FROM weekly_calculations 
         WHERE guild_id = ? AND recruiter_id IN (${pendingPlaceholders})
         GROUP BY recruiter_id`,
        guildId, ...pendingIds
      );
      for (const row of rows) {
        if (row && row.c < 2) {
          result.set(row.recruiter_id, true);
        }
      }
      
      // Those with 0 calculations (not in DB yet) are also new staff
      const foundIds = new Set(rows.map(r => r.recruiter_id));
      for (const id of pendingIds) {
        if (!foundIds.has(id)) result.set(id, true);
      }
    }

    return result;
  } catch (e) {
    console.error('Failed to batch check new staff status:', e);
    return result;
  }
}

module.exports = {
  batchCalculate7DayStats,
  batchIsNewStaff
};
