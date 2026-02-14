const { getLinkedPoints, formatPoints } = require('../../lib/rookie-points');
const { ROLE_IDS } = require('../../constants');
const { clampText } = require('../../lib/text');
const { resolveGuildId } = require('../../lib/guild');
const recruitsRepo = require('../../repos/recruits-repo');
const verificationsRepo = require('../../repos/verifications-repo');
const rookiePointsRepo = require('../../repos/rookie-points-repo');
const absencesRepo = require('../../repos/absences-repo');

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

function getPrimaryMemberRoleLabel(guildMember) {
  if (!guildMember || !guildMember.roles || !guildMember.roles.cache) return 'Member';
  const picks = [
    { id: ROLE_IDS.LEADER, label: 'Leader' },
    { id: ROLE_IDS.CO_LEADER, label: 'Co-Leader' },
    { id: ROLE_IDS.CHIEF, label: 'Chief' },
    { id: ROLE_IDS.MOD, label: 'Mod' },
    { id: ROLE_IDS.HIGH_STAFF, label: 'High Staff' },
    { id: ROLE_IDS.HELPER_PLUS, label: 'Helper+' },
    { id: ROLE_IDS.HELPER, label: 'Helper' },
    { id: ROLE_IDS.RECRUITER, label: 'Recruiter' },
    { id: ROLE_IDS.TRIAL_RECRUITER, label: 'Trial Recruiter' },
    { id: ROLE_IDS.VIP, label: 'VIP' },
    { id: ROLE_IDS.MVP, label: 'MVP' },
    { id: ROLE_IDS.CUSTOM, label: 'Custom' },
    { id: ROLE_IDS.ROOKIE, label: 'Rookie' },
    { id: ROLE_IDS.UNVERIFIED, label: 'Unverified' }
  ].filter(r => r.id);

  for (const p of picks) {
    if (guildMember.roles.cache.has(p.id)) return p.label;
  }
  return 'Member';
}

async function getInfoData({ db, guild, member }) {
  const guildId = resolveGuildId(guild);
  const rows = await recruitsRepo.getByRecruitedId(db, guildId, member.id);
  if (!rows || rows.length === 0) return null;
  const recruit = rows[0];

  const verification = await verificationsRepo.getLatestByRecruitedId(db, guildId, member.id);
  const recruitMember = await guild.members.fetch(member.id).catch(() => null);
  const recruiterMember = await guild.members.fetch(recruit.recruiter_id).catch(() => null);
  const primaryRole = getPrimaryMemberRoleLabel(recruitMember);
  const rookiePointsRow = await rookiePointsRepo.getByMember(db, guildId, member.id);
  let points = null;
  let pointsUpdatedAt = null;

  if (recruitMember) {
    const linked = await getLinkedPoints({ db, member: recruitMember, guild });
    points = Number.isFinite(linked.points) ? linked.points : null;
    pointsUpdatedAt = linked.updatedAt || null;
  } else if (rookiePointsRow && Number.isFinite(Number(rookiePointsRow.points))) {
    points = Number(rookiePointsRow.points);
    pointsUpdatedAt = rookiePointsRow.updated_at || null;
  }

  const absence = await absencesRepo.getActive(db, guildId, recruit.recruiter_id);
  const recentByRecruiter = await recruitsRepo.getRecentByRecruiter(db, guildId, recruit.recruiter_id, 5);

  return {
    guildId,
    rows,
    recruit,
    verification,
    recruitMember,
    recruiterMember,
    primaryRole,
    points,
    pointsUpdatedAt,
    absence,
    recentByRecruiter,
    toUnixSeconds,
    safeDaysLeftFromEndDate,
    formatPoints,
    clampText
  };
}

module.exports = { getInfoData };
