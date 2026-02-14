function normalizeLimit(limit, fallback) {
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : fallback;
}

async function countActive(db, guildId, recruiterId, nowMs) {
  const row = await db.get(
    'SELECT COUNT(*) as c FROM warnings WHERE guild_id = ? AND recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)',
    guildId,
    recruiterId,
    nowMs
  );
  return row ? row.c : 0;
}

async function countAll(db, guildId, recruiterId) {
  const row = await db.get(
    'SELECT COUNT(*) as c FROM warnings WHERE guild_id = ? AND recruiter_id = ? AND revoked = 0',
    guildId,
    recruiterId
  );
  return row ? row.c : 0;
}

async function getRecent(db, guildId, recruiterId, limit = 5) {
  const lim = normalizeLimit(limit, 5);
  return db.all(
    'SELECT * FROM warnings WHERE guild_id = ? AND recruiter_id = ? ORDER BY created_at DESC LIMIT ?',
    guildId,
    recruiterId,
    lim
  );
}

module.exports = { countActive, countAll, getRecent };
