const scheduler = require('../scheduler');

async function handleMemberLeave(db, guild, member) {
  // find valid recruits for this member
  const recruits = await db.all('SELECT * FROM recruits WHERE recruited_id = ? AND valid = 1', member.id);
  if (!recruits || recruits.length === 0) return;

  await db.run('BEGIN TRANSACTION');
  try {
    for (const r of recruits) {
      await db.run('UPDATE recruits SET valid = 0 WHERE id = ?', r.id);
      const recRow = await db.get('SELECT points FROM recruiters WHERE id = ?', r.recruiter_id);
      const currentPoints = recRow ? recRow.points || 0 : 0;
      const deduct = r.points || 0;
      const newPoints = Math.max(0, currentPoints - deduct);
      await db.run('UPDATE recruiters SET points = ? WHERE id = ?', newPoints, r.recruiter_id);
    }
    await db.run('COMMIT');
  } catch (e) {
    await db.run('ROLLBACK');
    throw e;
  }

  // recompute flags and leaderboards
  try {
    if (guild) {
      await scheduler.applyFlags(db, guild);
      await scheduler.recomputeLeaderboards(db, guild);
    }
  } catch (e) {
    console.error('Error running scheduler after member leave', e);
  }
}

module.exports = { handleMemberLeave };