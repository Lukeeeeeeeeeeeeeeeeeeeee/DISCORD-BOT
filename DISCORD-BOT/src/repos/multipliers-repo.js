function normalizeLimit(limit, fallback) {
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : fallback;
}

async function getByRecruiter(db, guildId, recruiterId, limit = null) {
  if (limit && Number.isFinite(limit)) {
    const lim = normalizeLimit(limit, 5);
    return db.all(
      'SELECT * FROM multipliers WHERE guild_id = ? AND recruiter_id = ? ORDER BY expires_at DESC LIMIT ?',
      guildId,
      recruiterId,
      lim
    );
  }
  return db.all(
    'SELECT * FROM multipliers WHERE guild_id = ? AND recruiter_id = ? ORDER BY expires_at DESC',
    guildId,
    recruiterId
  );
}

module.exports = { getByRecruiter };
