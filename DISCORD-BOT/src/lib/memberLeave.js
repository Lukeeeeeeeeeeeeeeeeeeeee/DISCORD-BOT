const scheduler = require('../scheduler');
const { resolveGuildId } = require('./guild');
const { withTransaction } = require('./transactions');

async function handleMemberLeave(db, guild, member) {
  const guildId = resolveGuildId(guild || (member && member.guild));
  // find valid recruits for this member
  const recruits = await db.all(
    'SELECT * FROM recruits WHERE guild_id = ? AND recruited_id = ? AND valid = 1',
    guildId,
    member.id
  );
  if (!recruits || recruits.length === 0) return;

  // Use withTransaction so this respects the shared concurrency queue and
  // cannot conflict with other in-flight transactions on the same DB handle.
  await withTransaction(db, async (tx) => {
    for (const r of recruits) {
      await tx.run('UPDATE recruits SET valid = 0 WHERE id = ?', r.id);
    }
  });

  // recompute leaderboards (non-blocking — don't hold up the event handler)
  if (guild) {
    void scheduler.recomputeLeaderboards(db, guild).catch(e => {
      console.error('Error recomputing leaderboards after member leave', e);
    });
    if (typeof scheduler.recomputeWarningsLeaderboard === 'function') {
      void scheduler.recomputeWarningsLeaderboard(db, guild).catch(e => {
        console.error('Error recomputing warnings leaderboard after member leave', e);
      });
    }
  }
}

module.exports = { handleMemberLeave };
