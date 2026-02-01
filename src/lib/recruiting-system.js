const { ROLE_IDS } = require('../constants');
const { hasAdministrator } = require('./permissions');

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
const PIVOT_RECRUITS_PER_WEEK = TARGET_RECRUITS_PER_WEEK / 2;
const ACTIVITY_MAX_STEP = 1.5;
const VERIFY_MAX_STEP = 1.0;
const RETENTION_MAX_STEP = 0.5;
const MIN_MIN_REQ = 2;
const MAX_MIN_REQ = 8;

const PROGRESSION_TARGET = 4;
const PROGRESSION_RATE = 0.5;
const PROGRESSION_MAX = 1.5;
const BASE_MAX_DELTA_UP = 2;
const BASE_MAX_DELTA_DOWN = 1;

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

async function isNewStaff(db, recruiterId) {
  try {
    const calculationCount = await db.get(
      'SELECT COUNT(*) as c FROM weekly_calculations WHERE recruiter_id = ?',
      recruiterId
    );
    return calculationCount ? calculationCount.c < 2 : true;
  } catch (error) {
    const msg = (error && error.message) ? String(error.message) : '';
    if (msg.toLowerCase().includes('no such table: weekly_calculations')) {
      return true;
    }
    console.error('Error checking if new staff:', error);
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
  verifyRate,
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
    const maxDeltaUp = Math.max(0, BASE_MAX_DELTA_UP - (warnings || 0));
    const maxDeltaDown = Math.max(0, BASE_MAX_DELTA_DOWN - (warnings || 0));
    let delta = rawMin - previousMinReq;
    delta = Math.max(-maxDeltaDown, Math.min(maxDeltaUp, delta));
    smoothed = previousMinReq + delta;
  }

  return Math.max(MIN_MIN_REQ, Math.min(MAX_MIN_REQ, Math.ceil(smoothed)));
}

function getRecruiterStatus({ recruits7d = 0, minReq = 0, activeWarnings = 0, absent = false, attention = false } = {}) {
  if (absent || minReq === 0) {
    return { bucket: 'ABSENT', label: '📅 Absent', color: 0xFFAA00 };
  }

  if (activeWarnings >= 2) {
    return { bucket: 'DEMOTION', label: '🚨 Demotion watch (2+ warnings)', color: 0x992D22 };
  }

  // Per requested rules: failing if you got none.
  if ((recruits7d || 0) === 0) {
    return { bucket: 'FAILING', label: `⚠️ Failing (0/${minReq})`, color: 0xFF4444 };
  }

  // Attention if you meet the auto-warning criteria (computed by caller).
  if (attention && (recruits7d || 0) < (minReq || 0)) {
    return { bucket: 'ATTENTION', label: `⚠️ Attention (${recruits7d}/${minReq})`, color: 0x00AAFF };
  }

  if ((recruits7d || 0) < (minReq || 0)) {
    return { bucket: 'PASSING', label: `✅ Passing (${recruits7d}/${minReq})`, color: 0x51CF66 };
  }

  return { bucket: 'GOOD', label: `🔥 Good (${recruits7d}/${minReq})`, color: 0x00CC66 };
}

/**
 * Calculate 7-day activity and retention for a recruiter
 * @param {Database} db - Database instance
 * @param {string} recruiterId - Recruiter Discord ID
 * @returns {Object} - Activity and retention data
 */
async function calculate7DayStats(db, recruiterId, guild = null) {
  const now = Date.now();
  const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = now - (14 * 24 * 60 * 60 * 1000);

  try {
    // Get recruits from last 7 days
    const recentRecruits = await db.all(
      'SELECT * FROM recruits WHERE recruiter_id = ? AND created_at >= ? AND valid = 1 ORDER BY created_at DESC',
      recruiterId, sevenDaysAgo
    );

    const recruits7d = recentRecruits.length;
    const activityRate = recruits7d; // 7-day activity rate

    let verifyRate = 0;
    try {
      const verifiedRow = await db.get(
        'SELECT COUNT(*) as c FROM recruits r INNER JOIN verifications v ON v.recruited_id = r.recruited_id WHERE r.recruiter_id = ? AND r.created_at >= ? AND r.valid = 1',
        recruiterId,
        sevenDaysAgo
      );
      const verified7d = verifiedRow ? Number(verifiedRow.c || 0) : 0;
      verifyRate = recruits7d > 0 ? (verified7d / recruits7d) : 0;
    } catch (e) {
      verifyRate = 0;
    }

    // Calculate retention for 7-day window
    let retention = 0;
    if (guild) {
      const retentionCohort = await db.all(
        'SELECT recruited_id FROM recruits WHERE recruiter_id = ? AND created_at >= ? AND created_at < ? AND valid = 1 ORDER BY created_at DESC',
        recruiterId, fourteenDaysAgo, sevenDaysAgo
      );

      const cohortSize = retentionCohort.length;
      if (cohortSize > 0) {
        let retainedCount = 0;
        try {
          const recruitedIds = retentionCohort.map(r => r.recruited_id);
          // Fetch members in bulk to avoid repetitive individual fetch calls
          const members = (await guild.members.fetch({ user: recruitedIds }).catch(() => new Map())) || new Map();
          retainedCount = members.size;
        } catch (e) {
          // Fallback to loop if bulk fetch fails for some reason
          for (const r of retentionCohort) {
            const member = await guild.members.fetch(r.recruited_id).catch(() => null);
            if (member) retainedCount++;
          }
        }
        retention = retainedCount / cohortSize;
      }
    }

    return {
      recruits7d,
      activityRate,
      verifyRate: Math.max(0, Math.min(1, verifyRate)),
      retention: Math.max(0, Math.min(1, retention)) // Clamp between 0-1
    };
  } catch (error) {
    console.error('Error calculating 7-day stats:', error);
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
    const weekStart = data.weekStart ?? null;
    const absent = data.absent ? 1 : 0;
    await db.run(`
      INSERT OR REPLACE INTO weekly_calculations 
      (recruiter_id, timestamp, week_start, recruits7d, activity_rate, verify_rate, retention, warnings, absent, previous_min_req, calculated_min_req, role_base)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      data.recruiterId,
      Date.now(),
      weekStart,
      data.recruits7d,
      data.activityRate,
      data.verifyRate != null ? data.verifyRate : 0,
      data.retention,
      data.warnings,
      absent,
      data.previousMinReq,
      data.calculatedMinReq,
      data.roleBase
    ]);
  } catch (error) {
    console.error('Error storing weekly calculation:', error);
  }
}

/**
 * Get previous minimum requirement for a recruiter
 * @param {Database} db - Database instance
 * @param {string} recruiterId - Recruiter Discord ID
 * @returns {number|null} - Previous minimum requirement or null
 */
async function getPreviousMinReq(db, recruiterId) {
  try {
    const row = await db.get(
      'SELECT calculated_min_req FROM weekly_calculations WHERE recruiter_id = ? ORDER BY COALESCE(week_start, timestamp) DESC LIMIT 1',
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
