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
const ACTIVITY_MAX_STEP = 1.5;
const RETENTION_MAX_STEP = 0.5;
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
  activityRate,
  retention,
  warnings,
  previousMinReq,
  absent,
  isNewStaff = false
} = {}) {
  if (absent) {
    return 0;
  }

  const roleLevel = member ? getRoleLevel(member) : 0;

  // Low-activity floor (CRITICAL FIX)
  if (recruits7d <= 1) {
    // Do not immediately drop brand-new recruiters/staff to 2.
    // Only apply the low-activity floor after the recruiter has weekly history.
    if (isNewStaff || previousMinReq == null) {
      const base = (roleBase != null ? roleBase : 4);
      return Math.max(2, Math.min(8, Math.ceil(base)));
    }

    const floor = roleLevel >= 2 ? 3 : 2;
    return floor;
  }

  const target = TARGET_RECRUITS_PER_WEEK;
  const pressure = (target - activityRate) / target;

  // Activity adjustment (dominant)
  const activityAdj = pressure * ACTIVITY_MAX_STEP;

  // Retention adjustment (secondary, only if volume ≥ 3)
  let retentionAdj = 0;
  if (recruits7d >= 3) {
    retentionAdj = pressure * retention * RETENTION_MAX_STEP;
  }

  const rawMin = roleBase + activityAdj + retentionAdj;

  // Apply smoothing with warning-based delta limits
  let smoothed = rawMin;

  if (previousMinReq != null) {
    const baseMaxDeltaUp = isNewStaff ? 1 : BASE_MAX_DELTA_UP;
    const baseMaxDeltaDown = isNewStaff ? 0 : BASE_MAX_DELTA_DOWN;
    const maxDeltaUp = Math.max(0, baseMaxDeltaUp - warnings);
    const maxDeltaDown = Math.max(0, baseMaxDeltaDown - warnings);

    let delta = rawMin - previousMinReq;
    delta = Math.max(-maxDeltaDown, Math.min(maxDeltaUp, delta));
    smoothed = previousMinReq + delta;
  }

  // Final clamp and rounding
  return Math.max(2, Math.min(8, Math.ceil(smoothed)));
}

function getRecruiterStatus({ recruits7d = 0, minReq = 0, activeWarnings = 0, absent = false } = {}) {
  if (absent || minReq === 0) {
    return { bucket: 'ABSENT', label: '📅 Absent', color: 0xFFAA00 };
  }

  if (activeWarnings >= 2) {
    return { bucket: 'DEMOTION', label: '🚨 Demotion (2 warnings)', color: 0x992D22 };
  }
  if (activeWarnings === 1) {
    // Not necessarily failing, but should be watched.
    // Bucket classification for reports can still override based on performance.
  }

  const diff = recruits7d - minReq;
  if (diff >= 2) return { bucket: 'EXCEEDING', label: `🔥 Exceeding (${recruits7d}/${minReq})`, color: 0x00CC66 };
  if (diff >= 0) return { bucket: 'PASSING', label: `✅ Passing (${recruits7d}/${minReq})`, color: 0x51CF66 };
  if (diff === -1) return { bucket: 'WATCH', label: `🟦 Watch closely (${recruits7d}/${minReq})`, color: 0x00AAFF };
  return { bucket: 'FAILING', label: `⚠️ Failing (${recruits7d}/${minReq})`, color: 0xFF4444 };
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
        for (const r of retentionCohort) {
          const member = await guild.members.fetch(r.recruited_id).catch(() => null);
          if (member) retainedCount++;
        }
        retention = retainedCount / cohortSize;
      }
    }

    return {
      recruits7d,
      activityRate,
      retention: Math.max(0, Math.min(1, retention)) // Clamp between 0-1
    };
  } catch (error) {
    console.error('Error calculating 7-day stats:', error);
    return {
      recruits7d: 0,
      activityRate: 0,
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
      (recruiter_id, timestamp, week_start, recruits7d, activity_rate, retention, warnings, absent, previous_min_req, calculated_min_req, role_base)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      data.recruiterId,
      Date.now(),
      weekStart,
      data.recruits7d,
      data.activityRate,
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
