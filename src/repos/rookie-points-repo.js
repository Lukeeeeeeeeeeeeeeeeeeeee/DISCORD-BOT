async function getByMember(db, guildId, memberId) {
  return db.get(
    'SELECT points, updated_at FROM rookie_points WHERE guild_id = ? AND member_id = ?',
    guildId,
    memberId
  );
}

async function initMember(db, guildId, memberId, opts = {}) {
  const points = Number.isFinite(opts.points) ? opts.points : 0;
  const updatedAt = Number.isFinite(opts.updatedAt) ? opts.updatedAt : Date.now();
  return db.run(
    'INSERT OR REPLACE INTO rookie_points (guild_id, member_id, points, updated_at) VALUES (?, ?, ?, ?)',
    guildId,
    memberId,
    points,
    updatedAt
  );
}

module.exports = { getByMember, initMember };
