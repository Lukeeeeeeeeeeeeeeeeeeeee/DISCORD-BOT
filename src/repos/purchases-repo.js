function normalizeLimit(limit, fallback) {
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : fallback;
}

async function getRecent(db, guildId, recruiterId, limit = 5) {
  const lim = normalizeLimit(limit, 5);
  return db.all(
    'SELECT * FROM purchases WHERE guild_id = ? AND recruiter_id = ? ORDER BY created_at DESC LIMIT ?',
    guildId,
    recruiterId,
    lim
  );
}

module.exports = { getRecent };
