function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

async function getById(db, guildId, recruiterId) {
  return db.get('SELECT * FROM recruiters WHERE guild_id = ? AND id = ?', guildId, recruiterId);
}

async function countAll(db, guildId) {
  const row = await db.get('SELECT COUNT(*) as c FROM recruiters WHERE guild_id = ?', guildId);
  return row ? row.c : 0;
}

async function ensureRecruiter(db, guildId, recruiterId) {
  return db.run(
    'INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, 0, 0, 0, 4)',
    guildId,
    recruiterId
  );
}

async function getPoints(db, guildId, recruiterId) {
  const row = await db.get('SELECT points FROM recruiters WHERE guild_id = ? AND id = ?', guildId, recruiterId);
  return row ? toFiniteNumber(row.points, 0) : 0;
}

async function setPoints(db, guildId, recruiterId, points) {
  const safePoints = toFiniteNumber(points, 0);
  await ensureRecruiter(db, guildId, recruiterId);
  return db.run(
    'UPDATE recruiters SET points = COALESCE(CAST(? AS REAL), 0) WHERE guild_id = ? AND id = ?',
    safePoints,
    guildId,
    recruiterId
  );
}

async function addPoints(db, guildId, recruiterId, delta) {
  const safeDelta = toFiniteNumber(delta, 0);
  await ensureRecruiter(db, guildId, recruiterId);
  return db.run(
    'UPDATE recruiters SET points = COALESCE(CAST(points AS REAL), 0) + ? WHERE guild_id = ? AND id = ?',
    safeDelta,
    guildId,
    recruiterId
  );
}

async function listIds(db, guildId) {
  const rows = await db.all('SELECT id FROM recruiters WHERE guild_id = ?', guildId);
  return (rows || []).map(r => r.id).filter(Boolean);
}

module.exports = { getById, countAll, ensureRecruiter, getPoints, setPoints, addPoints, listIds };
