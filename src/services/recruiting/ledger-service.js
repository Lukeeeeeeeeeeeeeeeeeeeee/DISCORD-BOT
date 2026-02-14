const ensuredDbs = new WeakSet();

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

async function ensureLedgerTable(db) {
  if (!db || typeof db.exec !== 'function') return;
  if (ensuredDbs.has(db)) return;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS recruiter_points_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      recruiter_id TEXT NOT NULL,
      delta REAL NOT NULL,
      reason TEXT NOT NULL,
      ref_type TEXT,
      ref_id TEXT,
      resulting_points REAL NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recruiter_points_ledger_guild_user_time
      ON recruiter_points_ledger(guild_id, recruiter_id, created_at DESC);
  `);
  ensuredDbs.add(db);
}

async function changeRecruiterPoints(tx, {
  guildId,
  recruiterId,
  delta,
  reason,
  refType = null,
  refId = null,
  minPoints = 0,
  maxPoints = null
}) {
  if (!tx) throw new Error('Transaction handle is required');
  if (!guildId || !recruiterId) throw new Error('guildId and recruiterId are required');
  if (!Number.isFinite(delta)) throw new Error('delta must be a finite number');
  const safeDelta = toFiniteNumber(delta, 0);
  const safeReason = reason ? String(reason) : 'unspecified';
  const now = Date.now();
  const floor = toFiniteNumber(minPoints, 0);
  const ceiling = Number.isFinite(maxPoints) ? toFiniteNumber(maxPoints, null) : null;

  await ensureLedgerTable(tx);
  await tx.run(
    'INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, 0, 0, 0, 4)',
    guildId,
    recruiterId
  );
  await tx.run(
    'UPDATE recruiters SET points = COALESCE(CAST(points AS REAL), 0) WHERE guild_id = ? AND id = ?',
    guildId,
    recruiterId
  );

  if (Number.isFinite(ceiling)) {
    await tx.run(
      'UPDATE recruiters SET points = MIN(?, MAX(?, COALESCE(CAST(points AS REAL), 0) + ?)) WHERE guild_id = ? AND id = ?',
      ceiling,
      floor,
      safeDelta,
      guildId,
      recruiterId
    );
  } else {
    await tx.run(
      'UPDATE recruiters SET points = MAX(?, COALESCE(CAST(points AS REAL), 0) + ?) WHERE guild_id = ? AND id = ?',
      floor,
      safeDelta,
      guildId,
      recruiterId
    );
  }

  const row = await tx.get(
    'SELECT COALESCE(CAST(points AS REAL), 0) AS points FROM recruiters WHERE guild_id = ? AND id = ?',
    guildId,
    recruiterId
  );
  const resultingPoints = row ? toFiniteNumber(row.points, 0) : 0;

  await tx.run(
    `INSERT INTO recruiter_points_ledger
     (guild_id, recruiter_id, delta, reason, ref_type, ref_id, resulting_points, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    guildId,
    recruiterId,
    safeDelta,
    safeReason,
    refType,
    refId ? String(refId) : null,
    resultingPoints,
    now
  );

  return resultingPoints;
}

module.exports = {
  changeRecruiterPoints,
  ensureLedgerTable
};
