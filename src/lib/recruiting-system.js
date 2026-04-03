const { ROLE_IDS, RECRUITER_ROLE_IDS } = require('../constants');
const { hasAdministrator } = require('./permissions');
const { resolveGuildId } = require('./guild');
const { fetchMembersByIds } = require('./member-fetch');
const { logUnexpectedError } = require('./logger');
const { ensureRecruiter } = require('../repos/recruiters-repo');

// Role hierarchy for permissions
const ROLE_HIERARCHY = {
  [ROLE_IDS.HELPER]: 1,
  [ROLE_IDS.HELPER_PLUS]: 1,
  [ROLE_IDS.MOD]: 2,
  [ROLE_IDS.CHIEF]: 2,
  [ROLE_IDS.CO_LEADER]: 3,
  [ROLE_IDS.LEADER]: 3,
  [ROLE_IDS.CHIEF_OF_WAR]: 2,
  [ROLE_IDS.CHIEF_OF_COMMUNITY]: 2,
  [ROLE_IDS.CHIEF_OF_RECRUITMENT]: 2,
  [ROLE_IDS.HIGH_STAFF]: 2
};

// Base requirements by role
const ROLE_BASE_REQUIREMENTS = {
  [ROLE_IDS.HELPER]: 4,
  [ROLE_IDS.HELPER_PLUS]: 4,
  [ROLE_IDS.MOD]: 5,
  [ROLE_IDS.CHIEF]: 5,
  [ROLE_IDS.CO_LEADER]: 6,
  [ROLE_IDS.LEADER]: 6,
  [ROLE_IDS.CHIEF_OF_WAR]: 5,
  [ROLE_IDS.CHIEF_OF_COMMUNITY]: 5,
  [ROLE_IDS.CHIEF_OF_RECRUITMENT]: 5,
  [ROLE_IDS.HIGH_STAFF]: 5
};

// Constants
const TARGET_RECRUITS_PER_WEEK = 8;
const ACTIVITY_MAX_STEP = 1.5;
const RETENTION_MAX_STEP = 0.5;
const MIN_MIN_REQ = 2;
const MAX_MIN_REQ = 8;

const BASE_MAX_DELTA_UP = 2;
const BASE_MAX_DELTA_DOWN = 1;
const NEW_RECRUITER_GRACE_DAYS = 14;

/**
 * Get role hierarchy level for a user
 * @param {GuildMember} member - Discord guild member
 * @returns {number} - Role hierarchy level
 */
function getRoleLevel(member) {
  if (!member || !member.roles) return 0;

  let maxLevel = 0;
  for (const [roleId, level] of Object.entries(ROLE_HIERARCHY)) {
    if (member.roles.cache.has(roleId)) {
      maxLevel = Math.max(maxLevel, level);
    }
  }
  return maxLevel;
}

/**
 * Get base requirement for a user based on their highest role
 * @param {GuildMember} member - Discord guild member
 * @returns {number} - Base minimum recruits requirement
 */
function getBaseRequirement(member) {
  if (!member || !member.roles) return 4;

  let maxBase = 4;
  for (const [roleId, base] of Object.entries(ROLE_BASE_REQUIREMENTS)) {
    if (member.roles.cache.has(roleId)) {
      maxBase = Math.max(maxBase, base);
    }
  }
  return maxBase;
}

/**
 * Check if user has MOD+ level permissions
 * @param {GuildMember} member - Discord guild member
 * @returns {boolean} - True if user has MOD+ permissions
 */
function hasModPlusPermissions(member) {
  if (hasAdministrator(member)) return true;
  return getRoleLevel(member) >= 2;
}

async function isNewStaff(db, recruiterId, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const guildId = resolveGuildId(opts.guild || opts.guildId);
  
  // Strategy: Prioritize high-fidelity role-change analytics if available.
  try {
    const recruiterRoleIds = [
      ROLE_IDS.RECRUITER,
      ROLE_IDS.TRIAL_RECRUITER,
      ...(RECRUITER_ROLE_IDS ? Object.values(RECRUITER_ROLE_IDS) : [])
    ].filter(Boolean);

    if (recruiterRoleIds.length) {
      const placeholders = recruiterRoleIds.map(() => '?').join(', ');
      const row = await db.get(
        `SELECT MAX(created_at) as last_added
         FROM analytics_role_changes
         WHERE guild_id = ? AND user_id = ? AND action = 'added' AND role_id IN (${placeholders})`,
        guildId,
        recruiterId,
        ...recruiterRoleIds
      );
      if (row && row.last_added) {
        const ageMs = now - Number(row.last_added);
        const graceMs = NEW_RECRUITER_GRACE_DAYS * 24 * 60 * 60 * 1000;
        if (ageMs >= 0 && ageMs <= graceMs) return true;
        
        // If we found a record and it exceeds the grace period, they are NOT new staff.
        return false;
      }
    }
  } catch (error) {
    const msg = (error && error.message) ? String(error.message) : '';
    if (!msg.toLowerCase().includes('no such table: analytics_role_changes')) {
      void logUnexpectedError('recruiting.isNewStaff.analytics', error, { recruiterId });
    }
  }

  // Fallback: Check calculation history. A veteran will have multiple weekly historical records.
  try {
    const calculationCount = await db.get(
      'SELECT COUNT(*) as c FROM weekly_calculations WHERE guild_id = ? AND recruiter_id = ?',
      guildId,
      recruiterId
    );
    return calculationCount ? calculationCount.c < 2 : true;
  } catch (error) {
    const msg = (error && error.message) ? String(error.message) : '';
    if (msg.toLowerCase().includes('no such table: weekly_calculations')) {
      return true;
    }
    void logUnexpectedError('recruiting.isNewStaff.fallback', error, { recruiterId });
    return false;
  }
}

/**
 * Calculate minimum recruits requirement using the new 7-day system
 * @param {Object} params - Calculation parameters
 * @returns {number} - Minimum recruits required
 */
function calculateMinRecruitsFixed({
  roleBase,
  member,
  recruits7d,
  activityRate: _activityRate,
  retention,
  warnings,
  previousMinReq,
  absent,
  isNewStaff = false
} = {}) {
  const roleLevel = member ? getRoleLevel(member) : 0;

  if (absent) {
    return 0;
  }

  if (isNewStaff) {
    const floor = roleLevel >= 2 ? 3 : 2;
    return Math.max(MIN_MIN_REQ, Math.min(MAX_MIN_REQ, floor));
  }

  const safeRecruits = Number.isFinite(recruits7d) ? recruits7d : 0;
  const activityRate = Number.isFinite(_activityRate) ? _activityRate : safeRecruits;

  if (safeRecruits <= 1) {
    const floor = roleLevel >= 2 ? 3 : 2;
    return Math.max(MIN_MIN_REQ, Math.min(MAX_MIN_REQ, floor));
  }

  const target = TARGET_RECRUITS_PER_WEEK;
  const pressure = (target - activityRate) / target;
  const activityAdj = pressure * ACTIVITY_MAX_STEP;

  let retentionAdj = 0;
  if (safeRecruits >= 3) {
    retentionAdj = pressure * RETENTION_MAX_STEP * (retention || 0);
  }

  const base = Number.isFinite(roleBase) ? roleBase : MIN_MIN_REQ;
  const rawMin = base + activityAdj + retentionAdj;

  let smoothed = rawMin;
  if (previousMinReq != null) {
    // If a user has active warnings, prevent their requirement from decreasing (no maxDeltaDown).
    const hasWarnings = (warnings || 0) > 0;
    const maxDeltaUp = BASE_MAX_DELTA_UP;
    const maxDeltaDown = hasWarnings ? 0 : BASE_MAX_DELTA_DOWN;

    let delta = rawMin - previousMinReq;
    delta = Math.max(-maxDeltaDown, Math.min(maxDeltaUp, delta));
    smoothed = previousMinReq + delta;
  }

  const finalMin = Math.max(MIN_MIN_REQ, Math.min(MAX_MIN_REQ, Math.ceil(smoothed)));
  return Number.isFinite(finalMin) ? finalMin : MIN_MIN_REQ;
}

function getRecruiterStatus({ recruits7d = 0, minReq = 0, activeWarnings = 0, absent = false, attention = false } = {}) {
  // Audit Fix: Use robust Unicode escapes to prevent mangling across environments.
  if (absent || minReq === 0) {
    return { bucket: 'ABSENT', label: '\uD83D\uDCD3 Absent', color: 0x808080 };
  }

  if (activeWarnings >= 2) {
    return { bucket: 'DEMOTION', label: '\u26A0\uFE0F Demotion Watch (2+ warnings)', color: 0x992D22 };
  }

  // Per requested rules: failing if you got none.
  if ((recruits7d || 0) === 0) {
    return { bucket: 'FAILING', label: `\u274C Failing (0/${minReq})`, color: 0xFF4444 };
  }

  // Attention if you meet the auto-warning criteria (computed by caller).
  if (attention && (recruits7d || 0) < (minReq || 0)) {
    return { bucket: 'ATTENTION', label: `\uD83D\uDD35 Attention (${recruits7d}/${minReq})`, color: 0x00AAFF };
  }

  if ((recruits7d || 0) < (minReq || 0)) {
    return { bucket: 'FAILING', label: `\u26A0\uFE0F Below Minimum (${recruits7d}/${minReq})`, color: 0xFFAA00 };
  }

  return { bucket: 'PASSING', label: `\u2705 Passing (${recruits7d}/${minReq})`, color: 0x00CC66 };
}

/**
 * Calculate 7-day activity and retention for a recruiter
 * @param {Database} db - Database instance
 * @param {string} recruiterId - Recruiter Discord ID
 * @returns {Object} - Activity and retention data
 */
async function calculate7DayStats(db, recruiterId, guild = null, opts = {}) {
  const guildId = resolveGuildId(guild || opts.guildId);
  const windowEnd = Number.isFinite(opts.untilTs) ? opts.untilTs : Date.now();
  const windowStart = Number.isFinite(opts.sinceTs)
    ? opts.sinceTs
    : (windowEnd - (7 * 24 * 60 * 60 * 1000));
  const overrideWeekStart = Number.isFinite(opts.overrideWeekStart)
    ? opts.overrideWeekStart
    : (Number.isFinite(opts.weekStart) ? opts.weekStart : windowStart);
  const retentionEnd = Number.isFinite(opts.retentionEndTs) ? opts.retentionEndTs : windowStart;
  const retentionStart = Number.isFinite(opts.retentionStartTs)
    ? opts.retentionStartTs
    : (retentionEnd - (7 * 24 * 60 * 60 * 1000));

  try {
    // Count recruits from last 7 days without loading full rows
    const recruitsRow = await db.get(
      'SELECT COUNT(*) as c FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND created_at >= ? AND created_at < ? AND valid = 1',
      guildId,
      recruiterId,
      windowStart,
      windowEnd
    );

    let recruits7d = recruitsRow ? Number(recruitsRow.c || 0) : 0;
    if (Number.isFinite(overrideWeekStart)) {
      const overrideRow = await db.get(
        'SELECT total FROM weekly_recruit_overrides WHERE guild_id = ? AND recruiter_id = ? AND week_start = ?',
        guildId,
        recruiterId,
        overrideWeekStart
      ).catch(() => null);
      if (overrideRow && Number.isFinite(Number(overrideRow.total))) {
        recruits7d = Math.max(recruits7d, Math.max(0, Number(overrideRow.total)));
      }
    }
    const activityRate = recruits7d; // 7-day activity rate

    let verifyRate = 0;
    try {
      const verifiedRow = await db.get(
        `SELECT COUNT(*) as c
         FROM recruits r
         INNER JOIN verifications v ON v.guild_id = r.guild_id AND v.recruited_id = r.recruited_id
         WHERE r.guild_id = ? AND r.recruiter_id = ? AND r.created_at >= ? AND r.created_at < ? AND r.valid = 1`,
        guildId,
        recruiterId,
        windowStart,
        windowEnd
      );
      const verified7d = verifiedRow ? Number(verifiedRow.c || 0) : 0;
      verifyRate = recruits7d > 0 ? (verified7d / recruits7d) : 0;
    } catch (e) {
      verifyRate = 0;
    }

    // Calculate retention for cohort (with Sampling Strategy to prevent rate-limits)
    let retention = 0;
    if (guild) {
      // P-03: Sampling Strategy — Cap retention checks at 50 most recent recruits.
      // This is statistically sufficient and protects the Discord API during raids/mass-recruit events.
      const retentionCohort = await db.all(
        'SELECT recruited_id FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND created_at >= ? AND created_at < ? AND valid = 1 ORDER BY created_at DESC LIMIT 50',
        guildId,
        recruiterId,
        retentionStart,
        retentionEnd
      );

      const cohortSize = retentionCohort.length;
      if (cohortSize > 0) {
        const recruitedIds = retentionCohort.map(r => r.recruited_id);
        const members = await fetchMembersByIds(guild, recruitedIds).catch(() => new Map());
        retention = members.size / cohortSize;
      }
    }

    return {
      recruits7d,
      activityRate,
      verifyRate: Math.max(0, Math.min(1, verifyRate)),
      retention: Math.max(0, Math.min(1, retention)) // Clamp between 0-1
    };
  } catch (error) {
    void logUnexpectedError('recruiting.calculate7DayStats', error, { recruiterId });
    return {
      recruits7d: 0,
      activityRate: 0,
      verifyRate: 0,
      retention: 0
    };
  }
}

/**
 * Store weekly calculation history
 * @param {Database} db - Database instance
 * @param {Object} data - Calculation data
 */
async function storeWeeklyCalculation(db, data) {
  try {
    const guildId = resolveGuildId(data.guild || data.guildId);
    await ensureRecruiter(db, guildId, data.recruiterId);
    let weekStart = data.weekStart ?? null;
    
    // Audit Fix: Snapshot Isolation Strategy.
    // If this is a promotion snapshot, offset the key by -1ms to prevent current-week overwrites.
    if (data.isSnapshot && Number.isFinite(weekStart)) {
      weekStart = weekStart - 1;
    }

    const absent = data.absent ? 1 : 0;
    const nowTs = Date.now();
    const values = [
      guildId,
      data.recruiterId,
      nowTs,
      weekStart,
      data.recruits7d || 0,
      data.activityRate || 0,
      data.verifyRate != null ? data.verifyRate : 0,
      data.retention || 0,
      data.warnings || 0,
      absent || 0,
      data.previousMinReq ?? null,
      Math.floor(Number.isFinite(data.calculatedMinReq) ? data.calculatedMinReq : 2),
      data.roleBase ?? 2
    ];

    await db.run(
      `INSERT INTO weekly_calculations
       (guild_id, recruiter_id, timestamp, week_start, recruits7d, activity_rate, verify_rate, retention, warnings, absent, previous_min_req, calculated_min_req, role_base)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 2), COALESCE(?, 2))
       ON CONFLICT(guild_id, recruiter_id, week_start) DO UPDATE SET
         timestamp = excluded.timestamp,
         recruits7d = excluded.recruits7d,
         activity_rate = excluded.activity_rate,
         verify_rate = excluded.verify_rate,
         retention = excluded.retention,
         warnings = excluded.warnings,
         absent = excluded.absent,
         previous_min_req = excluded.previous_min_req,
         calculated_min_req = COALESCE(excluded.calculated_min_req, 2),
         role_base = COALESCE(excluded.role_base, 2)`,
      ...values
    );
  } catch (error) {
    void logUnexpectedError('recruiting.storeWeeklyCalculation', error, { recruiterId: data.recruiterId });
  }
}

/**
 * Get previous minimum requirement for a recruiter
 * @param {Database} db - Database instance
 * @param {string} recruiterId - Recruiter Discord ID
 * @returns {number|null} - Previous minimum requirement or null
 */
async function getPreviousMinReq(db, recruiterId, opts = {}) {
  try {
    const guildId = resolveGuildId(opts.guild || opts.guildId);
    const row = await db.get(
      'SELECT calculated_min_req FROM weekly_calculations WHERE guild_id = ? AND recruiter_id = ? ORDER BY COALESCE(week_start, timestamp) DESC LIMIT 1',
      guildId,
      recruiterId
    );
    return row ? row.calculated_min_req : null;
  } catch (error) {
    const msg = (error && error.message) ? String(error.message) : '';
    if (msg.toLowerCase().includes('no such table: weekly_calculations')) {
      return null;
    }
    console.error('Error getting previous min req:', error);
    return null;
  }
}

module.exports = {
  calculateMinRecruitsFixed,
  calculate7DayStats,
  storeWeeklyCalculation,
  getPreviousMinReq,
  isNewStaff,
  getRoleLevel,
  getBaseRequirement,
  hasModPlusPermissions,
  getRecruiterStatus,
  ROLE_HIERARCHY,
  ROLE_BASE_REQUIREMENTS,
  TARGET_RECRUITS_PER_WEEK,
  ACTIVITY_MAX_STEP,
  RETENTION_MAX_STEP,
  BASE_MAX_DELTA_UP,
  BASE_MAX_DELTA_DOWN
};

