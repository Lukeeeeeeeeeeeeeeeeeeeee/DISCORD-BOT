const scheduler = require('../scheduler');
const { resolveGuildId } = require('./guild');
const { changeRecruiterPoints } = require('../services/recruiting/ledger-service');
const { withTransaction } = require('./transactions');

const pendingLeaderboardRecomputeTimers = new Map();
const LEAVE_RECOMPUTE_DEBOUNCE_MS = Number.parseInt(process.env.LEAVE_RECOMPUTE_DEBOUNCE_MS || '15000', 10);

function scheduleLeaveLeaderboardRecompute(db, guild) {
  if (!db || !guild || !guild.id) return;
  if (pendingLeaderboardRecomputeTimers.has(guild.id)) return;
  const delayMs = Number.isFinite(LEAVE_RECOMPUTE_DEBOUNCE_MS) && LEAVE_RECOMPUTE_DEBOUNCE_MS > 0
    ? LEAVE_RECOMPUTE_DEBOUNCE_MS
    : 15000;
  const timer = setTimeout(async () => {
    pendingLeaderboardRecomputeTimers.delete(guild.id);
    try {
      await scheduler.recomputeLeaderboards(db, guild);
    } catch (e) {
      console.error('Error running scheduler after member leave (debounced)', e);
    }
  }, delayMs);
  pendingLeaderboardRecomputeTimers.set(guild.id, timer);
}

async function handleMemberLeave(db, guild, member) {
  const guildId = resolveGuildId(guild || (member && member.guild));
  if (!guildId || !member || !member.id) return;

  const result = await withTransaction(db, async (tx) => {
    const activeRecruits = await tx.all(
      'SELECT id, recruiter_id, points FROM recruits WHERE guild_id = ? AND recruited_id = ? AND valid = 1',
      guildId,
      member.id
    );
    if (!activeRecruits || activeRecruits.length === 0) {
      return { revokedCount: 0 };
    }

    await tx.run(
      'UPDATE recruits SET valid = 0 WHERE guild_id = ? AND recruited_id = ? AND valid = 1',
      guildId,
      member.id
    );

    const recruiterTotals = new Map();
    for (const recruit of activeRecruits) {
      if (!recruit || !recruit.recruiter_id) continue;
      const points = Number(recruit.points);
      const safePoints = Number.isFinite(points) ? points : 0;
      if (!safePoints) continue;
      recruiterTotals.set(
        recruit.recruiter_id,
        (recruiterTotals.get(recruit.recruiter_id) || 0) + safePoints
      );
    }

    for (const [recruiterId, totalPoints] of recruiterTotals.entries()) {
      await changeRecruiterPoints(tx, {
        guildId,
        recruiterId,
        delta: -totalPoints,
        reason: 'member_leave_revoke',
        refType: 'member',
        refId: String(member.id),
        minPoints: 0
      });
    }

    return { revokedCount: activeRecruits.length };
  });

  if (!result || !result.revokedCount) return;

  // Debounce recompute bursts (e.g., raid cleanup waves).
  if (guild) {
    scheduleLeaveLeaderboardRecompute(db, guild);
  }
}

module.exports = { handleMemberLeave };
