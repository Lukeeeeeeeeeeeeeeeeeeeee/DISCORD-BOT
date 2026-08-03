const { ROLE_IDS } = require('../../constants');
const { formatPointsValue, getActiveMultiplier } = require('../../lib/economy');
const { fetchMembersByIds } = require('../../lib/member-fetch');
const {
  calculate7DayStats,
  getPreviousMinReq,
  calculateMinRecruitsFixed,
  getBaseRequirement,
  isNewStaff,
  getRecruiterStatus
} = require('../../lib/recruiting-system');
const { getWeekStartUtcTs } = require('../../lib/week');
const {
  toUnixSeconds,
  hasRecruiterRole,
  getAverageWeeklyRecruits,
  computeRetentionCounts
} = require('../../lib/recruiter-helpers');

const recruitsRepo = require('../../repos/recruits-repo');
const recruitersRepo = require('../../repos/recruiters-repo');
const warningsRepo = require('../../repos/warnings-repo');
const flagsRepo = require('../../repos/flags-repo');
const purchasesRepo = require('../../repos/purchases-repo');
const multipliersRepo = require('../../repos/multipliers-repo');
const absencesRepo = require('../../repos/absences-repo');
const weeklyCalcsRepo = require('../../repos/weekly-calculations-repo');

async function getRecruiterInfoData({ db, guild, guildId, memberId }) {
  const rec = await recruitersRepo.getById(db, guildId, memberId);
  const recruits = await recruitsRepo.getRecentByRecruiter(db, guildId, memberId, 5);
  const totalAll = await recruitsRepo.countValidByRecruiter(db, guildId, memberId);
  const lastTs = await recruitsRepo.getLastRecruitAt(db, guildId, memberId);
  const now = Date.now();
  const activeWarnings = await warningsRepo.countActive(db, guildId, memberId, now);
  const totalWarnings = await warningsRepo.countAll(db, guildId, memberId);

  const mul = await getActiveMultiplier(db, memberId, { guildId });
  const multipliers = await multipliersRepo.getByRecruiter(db, guildId, memberId);

  const purchases = await purchasesRepo.getRecent(db, guildId, memberId, 5);
  const recentFlags = await flagsRepo.getRecent(db, guildId, memberId, 5);
  const recentWarnings = await warningsRepo.getRecent(db, guildId, memberId, 5);

  const weekStart = getWeekStartUtcTs();
  const statsWindow = { sinceTs: weekStart, untilTs: now };
  const stats7d = await calculate7DayStats(db, memberId, guild, { ...statsWindow, guildId });
  const avgRecruitsWeek = await getAverageWeeklyRecruits(db, memberId, guildId);
  const avgRecruitsDisplay = Number.isFinite(avgRecruitsWeek)
    ? String(avgRecruitsWeek).replace(/\.0$/, '')
    : '0';

  const absence = await absencesRepo.getActive(db, guildId, memberId);

  const targetMember = await guild.members.fetch(memberId).catch(() => null);
  const hasRecruiterRoleFlag = hasRecruiterRole(targetMember);
  const roleBase = getBaseRequirement(targetMember);

  let newStaffCheck = false;
  try {
    newStaffCheck = await isNewStaff(db, memberId, { guildId });
  } catch (e) {
    newStaffCheck = false;
  }
  const isTrialRecruiter = !!targetMember && targetMember.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER) && !targetMember.roles.cache.has(ROLE_IDS.AUTO_PROMOTE_ROLE);

  const weekCalc = await weeklyCalcsRepo.getCalculatedMinReq(db, guildId, memberId, weekStart).catch(() => null);
  let minReq = weekCalc && weekCalc.calculated_min_req != null ? Number(weekCalc.calculated_min_req) : null;
  let previousMinReq = null;
  if (minReq == null) {
    previousMinReq = await getPreviousMinReq(db, memberId, { guildId });
    minReq = previousMinReq;
  }
  if (minReq == null) {
    minReq = calculateMinRecruitsFixed({
      roleBase,
      member: targetMember,
      recruits7d: stats7d.recruits7d,
      activityRate: stats7d.activityRate,
      verifyRate: stats7d.verifyRate,
      retention: stats7d.retention,
      warnings: activeWarnings,
      previousMinReq,
      absent: !!absence,
      isNewStaff: newStaffCheck
    });
  }

  if (isTrialRecruiter) minReq = 3;
  if (absence) minReq = 0;
  if (!Number.isFinite(minReq)) minReq = 2;

  const pointsValue = formatPointsValue(rec ? rec.points : 0);

  const statusBase = getRecruiterStatus({
    recruits7d: stats7d.recruits7d,
    minReq,
    activeWarnings,
    absent: !!absence
  });
  let statusLabel = statusBase.label;
  let statusColor = statusBase.color;
  if (targetMember && !hasRecruiterRoleFlag) {
    statusLabel = 'Not a recruiter';
    statusColor = 0x808080;
  } else if (hasRecruiterRoleFlag && newStaffCheck && !absence) {
    statusLabel = 'New Recruiter';
    statusColor = 0x00AAFF;
  }

  const cohort7d = await computeRetentionCounts({
    db,
    guild,
    recruiterId: memberId,
    cohortStartMs: now - (14 * 24 * 60 * 60 * 1000),
    cohortEndMs: now - (7 * 24 * 60 * 60 * 1000),
    cap: 25
  });
  const retention7dPct = cohort7d.cohortSize > 0 ? Math.round((cohort7d.retained / cohort7d.cohortSize) * 100) : 0;

  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const allTimeEligible = await recruitsRepo.getEligibleOlderThan(db, guildId, memberId, now - sevenDaysMs);
  const allTimeCohortSize = allTimeEligible ? allTimeEligible.length : 0;
  const allTimeSlice = allTimeEligible && allTimeEligible.length > 30 ? allTimeEligible.slice(0, 30) : (allTimeEligible || []);
  const allTimeSampled = !!allTimeEligible && allTimeEligible.length > 30;
  const allTimeIds = allTimeSlice.map(r => r.recruited_id);
  const allTimeMembers = await fetchMembersByIds(guild, allTimeIds).catch(() => new Map());
  const allTimeRetained = allTimeMembers.size;
  const retentionAllPct = allTimeCohortSize > 0 ? Math.round((allTimeRetained / allTimeCohortSize) * 100) : 0;

  const oldestCandidates = await recruitsRepo.getOldestCandidates(db, guildId, memberId, 30);
  const retainedDurations = [];
  const oldestIds = (oldestCandidates || []).map(r => r.recruited_id);
  const oldestMembers = await fetchMembersByIds(guild, oldestIds).catch(() => new Map());
  for (const r of (oldestCandidates || [])) {
    if (!oldestMembers.has(r.recruited_id)) continue;
    const days = Math.floor((now - r.created_at) / (24 * 60 * 60 * 1000));
    retainedDurations.push({ recruitedId: r.recruited_id, createdAt: r.created_at, days });
  }
  retainedDurations.sort((a, b) => b.days - a.days);

  return {
    rec,
    recruits,
    totalAll,
    lastTs,
    activeWarnings,
    totalWarnings,
    mul,
    multipliers,
    purchases,
    recentFlags,
    recentWarnings,
    stats7d,
    avgRecruitsWeek,
    avgRecruitsDisplay,
    absence,
    targetMember,
    hasRecruiterRoleFlag,
    roleBase,
    newStaffCheck,
    isTrialRecruiter,
    minReq,
    statusLabel,
    statusColor,
    pointsValue,
    cohort7d,
    retention7dPct,
    allTimeCohortSize,
    allTimeRetained,
    retentionAllPct,
    allTimeSampled,
    retainedDurations,
    toUnixSeconds
  };
}

module.exports = { getRecruiterInfoData };
