const scheduler = require('../scheduler');
const { resolveGuildId } = require('./guild');

async function handleMemberLeave(db, guild, member) {
  const guildId = resolveGuildId(guild || (member && member.guild));
  // find valid recruits for this member
  const recruits = await db.all(
    'SELECT * FROM recruits WHERE guild_id = ? AND recruited_id = ? AND valid = 1',
    guildId,
    member.id
  );
  if (!recruits || recruits.length === 0) return;

  await db.run('BEGIN TRANSACTION');
  try {
    for (const r of recruits) {
      await db.run('UPDATE recruits SET valid = 0 WHERE id = ?', r.id);
      const recRow = await db.get(
        'SELECT points FROM recruiters WHERE guild_id = ? AND id = ?',
        guildId,
        r.recruiter_id
      );
      const currentPoints = recRow ? recRow.points || 0 : 0;
      const deduct = r.points || 0;
      const newPoints = Math.max(0, currentPoints - deduct);
      await db.run(
        'UPDATE recruiters SET points = ? WHERE guild_id = ? AND id = ?',
        newPoints,
        guildId,
        r.recruiter_id
      );
    }
    await db.run('COMMIT');
  } catch (e) {
    await db.run('ROLLBACK');
    throw e;
  }

  // recompute leaderboards
  try {
    if (guild) {
      await scheduler.recomputeLeaderboards(db, guild);
      if (typeof scheduler.recomputeWarningsLeaderboard === 'function') {
        await scheduler.recomputeWarningsLeaderboard(db, guild);
      }
    }
  } catch (e) {
    console.error('Error running scheduler after member leave', e);
  }
}

module.exports = { handleMemberLeave };
