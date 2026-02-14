function normalizeLimit(limit, fallback) {
  const value = Number(limit);
  if (!Number.isFinite(value)) return fallback;
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, 500);
}

async function getRecentByRecruiter(db, guildId, recruiterId, limit = 5) {
  const lim = normalizeLimit(limit, 5);
  return db.all(
    'SELECT * FROM recruits WHERE guild_id = ? AND recruiter_id = ? ORDER BY created_at DESC LIMIT ?',
    guildId,
    recruiterId,
    lim
  );
}

async function getByRecruitedId(db, guildId, recruitedId) {
  return db.all(
    'SELECT * FROM recruits WHERE guild_id = ? AND recruited_id = ? ORDER BY created_at DESC',
    guildId,
    recruitedId
  );
}

async function getLatestByRecruitedId(db, guildId, recruitedId) {
  return db.get(
    'SELECT * FROM recruits WHERE guild_id = ? AND recruited_id = ? ORDER BY created_at DESC LIMIT 1',
    guildId,
    recruitedId
  );
}

async function getActiveByRecruitedId(db, guildId, recruitedId) {
  return db.get(
    'SELECT * FROM recruits WHERE guild_id = ? AND recruited_id = ? AND valid = 1 ORDER BY created_at DESC LIMIT 1',
    guildId,
    recruitedId
  );
}

async function deleteInvalidByRecruitedId(db, guildId, recruitedId) {
  return db.run(
    'DELETE FROM recruits WHERE guild_id = ? AND recruited_id = ? AND valid = 0',
    guildId,
    recruitedId
  );
}

async function insertRecruit(db, guildId, data) {
  const valid = data && data.valid === 0 ? 0 : 1;
  return db.run(
    'INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, ign, created_at, valid, points) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    guildId,
    data.recruiterId,
    data.recruitedId,
    data.region,
    data.ign,
    data.createdAt,
    valid,
    data.points
  );
}

async function markInvalidById(db, guildId, id) {
  return db.run(
    'UPDATE recruits SET valid = 0 WHERE guild_id = ? AND id = ?',
    guildId,
    id
  );
}

async function markValidById(db, guildId, id) {
  return db.run(
    'UPDATE recruits SET valid = 1 WHERE guild_id = ? AND id = ?',
    guildId,
    id
  );
}

async function countValidByRecruiter(db, guildId, recruiterId) {
  const row = await db.get(
    'SELECT COUNT(*) as c FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1',
    guildId,
    recruiterId
  );
  return row ? row.c : 0;
}

async function countAll(db, guildId) {
  const row = await db.get(
    'SELECT COUNT(*) as c FROM recruits WHERE guild_id = ?',
    guildId
  );
  return row ? row.c : 0;
}

async function getLastRecruitAt(db, guildId, recruiterId) {
  const row = await db.get(
    'SELECT created_at FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1 ORDER BY created_at DESC LIMIT 1',
    guildId,
    recruiterId
  );
  return row ? row.created_at : null;
}

async function getEligibleOlderThan(db, guildId, recruiterId, olderThanMs) {
  return db.all(
    'SELECT recruited_id, created_at FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1 AND created_at <= ? ORDER BY created_at DESC',
    guildId,
    recruiterId,
    olderThanMs
  );
}

async function getOldestCandidates(db, guildId, recruiterId, limit = 30) {
  const lim = normalizeLimit(limit, 30);
  return db.all(
    'SELECT recruited_id, created_at FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1 ORDER BY created_at ASC LIMIT ?',
    guildId,
    recruiterId,
    lim
  );
}

async function getBetween(db, guildId, recruiterId, startMs, endMs) {
  return db.all(
    'SELECT recruited_id, created_at FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1 AND created_at >= ? AND created_at < ? ORDER BY created_at DESC',
    guildId,
    recruiterId,
    startMs,
    endMs
  );
}

module.exports = {
  getRecentByRecruiter,
  getByRecruitedId,
  getLatestByRecruitedId,
  getActiveByRecruitedId,
  deleteInvalidByRecruitedId,
  insertRecruit,
  markInvalidById,
  markValidById,
  countValidByRecruiter,
  countAll,
  getLastRecruitAt,
  getEligibleOlderThan,
  getOldestCandidates,
  getBetween
};
