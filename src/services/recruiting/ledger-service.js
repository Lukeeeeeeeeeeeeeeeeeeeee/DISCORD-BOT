const ensuredDbs = new WeakSet();
const MAX_SAFE_DELTA = 25;
const logRuntimeEvent = require('../../lib/logger').logRuntimeEvent;

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
  const ceiling = Number.isFinite(maxPoints) ? maxPoints : null;

  if (Math.abs(safeDelta) > MAX_SAFE_DELTA) {
    void logRuntimeEvent('warn', 'ledger.high_delta', 'High-value point transaction detected', {
      guildId, recruiterId, delta: safeDelta, reason: safeReason
    });
  }

  await ensureLedgerTable(tx);

  // Atomic Update using UPSERT (SQLite 3.24+)
  if (Number.isFinite(ceiling)) {
    await tx.run(`
      INSERT INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
      VALUES (?, ?, ?, 0, 0, 4)
      ON CONFLICT(guild_id, id) DO UPDATE SET
        points = MIN(?, MAX(?, COALESCE(points, 0) + ?))
    `, guildId, recruiterId, Math.max(floor, Math.min(ceiling, safeDelta)), ceiling, floor, safeDelta);
  } else {
    await tx.run(`
      INSERT INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
      VALUES (?, ?, ?, 0, 0, 4)
      ON CONFLICT(guild_id, id) DO UPDATE SET
        points = MAX(?, COALESCE(points, 0) + ?)
    `, guildId, recruiterId, Math.max(floor, safeDelta), floor, safeDelta);
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
