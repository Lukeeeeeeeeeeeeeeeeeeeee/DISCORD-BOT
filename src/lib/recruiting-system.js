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
  console.log(`\n=== MINREQ CALCULATION DEBUG ===`);
  console.log(`Inputs: roleBase=${roleBase}, recruits7d=${recruits7d}, activityRate=${activityRate}, retention=${retention}, warnings=${warnings}, previousMinReq=${previousMinReq}, absent=${absent}, isNewStaff=${isNewStaff}`);
  
  // Check timing: only allow changes before Thursday, lock after until Monday
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, ..., 4 = Thursday, ..., 6 = Saturday
  const hourOfDay = now.getHours();
  const isBeforeThursday = dayOfWeek < 4; // Before Thursday
  const isThursdayOrLater = dayOfWeek >= 4; // Thursday or later
  const isMondayReset = dayOfWeek === 1 && hourOfDay < 1; // Monday before 1 AM
  
  console.log(`-> Timing check: day=${dayOfWeek}, hour=${hourOfDay}, beforeThursday=${isBeforeThursday}, thursdayOrLater=${isThursdayOrLater}, mondayReset=${isMondayReset}`);
  
  // Handle absence (MOD+ only)
  if (absent && hasModPlusPermissions({ roles: { cache: new Map([[role, true]]) } })) {
    console.log(`-> Absent with MOD+ permissions, minReq = 0`);
    return 0;
  }

  // Low-activity floor (CRITICAL FIX)
  if (recruits7d <= 1) {
    const floor = hasModPlusPermissions({ roles: { cache: new Map([[role, true]]) } }) ? 3 : 2;
    console.log(`-> Low activity floor (recruits7d=${recruits7d}), minReq = ${floor}`);
    return floor;
  }

  const target = TARGET_RECRUITS_PER_WEEK;
  const pressure = (target - activityRate) / target;
  console.log(`-> target=${target}, activityRate=${activityRate}, pressure=${pressure.toFixed(3)}`);

  // Activity adjustment (dominant)
  const activityAdj = pressure * ACTIVITY_MAX_STEP;
  console.log(`-> activityAdj = ${pressure.toFixed(3)} * ${ACTIVITY_MAX_STEP} = ${activityAdj.toFixed(3)}`);

  // Retention adjustment (secondary, only if volume ≥ 3)
  let retentionAdj = 0;
  if (recruits7d >= 3) {
    retentionAdj = pressure * retention * RETENTION_MAX_STEP;
    console.log(`-> retentionAdj = ${pressure.toFixed(3)} * ${retention.toFixed(3)} * ${RETENTION_MAX_STEP} = ${retentionAdj.toFixed(3)}`);
  } else {
    console.log(`-> retentionAdj = 0 (recruits7d < 3)`);
  }

  const rawMin = roleBase + activityAdj + retentionAdj;
  console.log(`-> rawMin = ${roleBase} + ${activityAdj.toFixed(3)} + ${retentionAdj.toFixed(3)} = ${rawMin.toFixed(3)}`);

  // Apply smoothing with warning-based delta limits
  let smoothed = rawMin;

  if (previousMinReq != null) {
    let base_max_delta_up = BASE_MAX_DELTA_UP;
    let base_max_delta_down = BASE_MAX_DELTA_DOWN;
    
    console.log(`-> Previous minReq: ${previousMinReq}`);
    
    // New staff edge case: first 2 recalcs get reduced delta
    if (isNewStaff) {
      base_max_delta_up = 1; // Reduced from 2 to 1
      base_max_delta_down = 0; // Reduced from 1 to 0
      console.log(`-> New staff: delta limits reduced to up=${base_max_delta_up}, down=${base_max_delta_down}`);
    }
    
    // TIMING LOCK: If Thursday or later and not Monday reset, lock to previous value
    if (isThursdayOrLater && !isMondayReset) {
      console.log(`-> TIMING LOCK: Thursday or later, locking minReq to previous value: ${previousMinReq}`);
      console.log(`=== END DEBUG ===\n`);
      return previousMinReq;
    }
    
    const max_delta_up = Math.max(0, base_max_delta_up - warnings);
    const max_delta_down = Math.max(0, base_max_delta_down - warnings);
    console.log(`-> Warning-adjusted delta limits: up=${max_delta_up}, down=${max_delta_down}`);

    let delta = rawMin - previousMinReq;
    console.log(`-> Raw delta: ${delta.toFixed(3)} (${rawMin.toFixed(3)} - ${previousMinReq})`);
    
    delta = Math.max(-max_delta_down, Math.min(max_delta_up, delta));
    console.log(`-> Clamped delta: ${delta.toFixed(3)}`);
    
    smoothed = previousMinReq + delta;
    console.log(`-> Smoothed: ${previousMinReq} + ${delta.toFixed(3)} = ${smoothed.toFixed(3)}`);
  }

  // Final clamp and rounding
  const final = Math.max(2, Math.min(8, Math.ceil(smoothed)));
  console.log(`-> Final: clamp(${Math.ceil(smoothed)}, 2, 8) = ${final}`);
  console.log(`=== END DEBUG ===\n`);
  
  return final;
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
      // For new recruits, assume 100% retention until they leave
      // For older recruits, check if they're still in the server
      const retentionCutoff = now - (7 * 24 * 60 * 60 * 1000);
      const retainedCount = recentRecruits.filter(recruit => {
        // For recruits less than 7 days old, count as retained (they haven't had time to leave)
        if ((now - recruit.created_at) < (7 * 24 * 60 * 60 * 1000)) {
          return true;
        }
        // For older recruits, we'd need to check if they're still in server
        // For now, assume they're retained unless we have data they left
        return true;
      }).length;
      
      retention = retainedCount / recruits7d;
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
