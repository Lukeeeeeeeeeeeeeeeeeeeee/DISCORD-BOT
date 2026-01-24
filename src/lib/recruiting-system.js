const { ROLE_IDS } = require('../constants');

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
  [ROLE_IDS.HIGH_STAFF]: 2,
  [ROLE_IDS.STAFF]: 1
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
  [ROLE_IDS.HIGH_STAFF]: 5,
  [ROLE_IDS.STAFF]: 4
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
  return getRoleLevel(member) >= 2;
}

/**
 * Calculate minimum recruits requirement using the new 7-day system
 * @param {Object} params - Calculation parameters
 * @returns {number} - Minimum recruits required
 */
function calculateMinRecruitsFixed({
  roleBase,
  role,
  recruits7d,
  activityRate,
  retention,
  warnings,
  previousMinReq,
  absent,
  isNewStaff = false
} = {}) {
  // Handle absence (MOD+ only)
  if (absent && hasModPlusPermissions({ roles: { cache: new Map([[role, true]]) } })) {
    return 0;
  }

  // Low-activity floor (CRITICAL FIX)
  if (recruits7d <= 1) {
    return hasModPlusPermissions({ roles: { cache: new Map([[role, true]]) } }) ? 3 : 2;
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
    let base_max_delta_up = BASE_MAX_DELTA_UP;
    let base_max_delta_down = BASE_MAX_DELTA_DOWN;
    
    // New staff edge case: first 2 recalcs get reduced delta
    if (isNewStaff) {
      base_max_delta_up = 1; // Reduced from 2 to 1
      base_max_delta_down = 0; // Reduced from 1 to 0
    }
    
    const max_delta_up = Math.max(0, base_max_delta_up - warnings);
    const max_delta_down = Math.max(0, base_max_delta_down - warnings);

    let delta = rawMin - previousMinReq;
    delta = Math.max(-max_delta_down, Math.min(max_delta_up, delta));
    smoothed = previousMinReq + delta;
  }

  // Final clamp and rounding
  return Math.max(2, Math.min(8, Math.ceil(smoothed)));
}

/**
 * Calculate 7-day activity and retention for a recruiter
 * @param {Database} db - Database instance
 * @param {string} recruiterId - Recruiter Discord ID
 * @returns {Object} - Activity and retention data
 */
async function calculate7DayStats(db, recruiterId) {
  const now = Date.now();
  const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);

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
    if (recruits7d > 0) {
      const retentionCutoff = now - (7 * 24 * 60 * 60 * 1000);
      const retainedCount = recentRecruits.filter(recruit => {
        // Check if recruit stayed at least 7 days (for older recruits)
        // For recent recruits, we can't determine retention yet
        return (now - recruit.created_at) >= (7 * 24 * 60 * 60 * 1000);
      }).length;
      
      // For retention calculation, only count recruits old enough to measure
      const measurableRecruits = recentRecruits.filter(recruit => 
        (now - recruit.created_at) >= (7 * 24 * 60 * 60 * 1000)
      ).length;
      
      retention = measurableRecruits > 0 ? retainedCount / measurableRecruits : 0;
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
    await db.run(`
      INSERT OR REPLACE INTO weekly_calculations 
      (recruiter_id, timestamp, recruits7d, activity_rate, retention, warnings, previous_min_req, calculated_min_req, role_base)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      data.recruiterId,
      Date.now(),
      data.recruits7d,
      data.activityRate,
      data.retention,
      data.warnings,
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
      'SELECT calculated_min_req FROM weekly_calculations WHERE recruiter_id = ? ORDER BY timestamp DESC LIMIT 1',
      recruiterId
    );
    return row ? row.calculated_min_req : null;
  } catch (error) {
    console.error('Error getting previous min req:', error);
    return null;
  }
}

module.exports = {
  calculateMinRecruitsFixed,
  calculate7DayStats,
  storeWeeklyCalculation,
  getPreviousMinReq,
  getRoleLevel,
  getBaseRequirement,
  hasModPlusPermissions,
  ROLE_HIERARCHY,
  ROLE_BASE_REQUIREMENTS,
  TARGET_RECRUITS_PER_WEEK,
  ACTIVITY_MAX_STEP,
  RETENTION_MAX_STEP,
  BASE_MAX_DELTA_UP,
  BASE_MAX_DELTA_DOWN
};
