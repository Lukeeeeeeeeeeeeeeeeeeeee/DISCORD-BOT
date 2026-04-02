const { ensureRecruiter } = require('./recruiters-repo');

function toDateKey(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  // Keep YYYY-MM-DD when present; otherwise normalize from parsable Date.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function minDateKey(a, b) {
  const left = toDateKey(a);
  const right = toDateKey(b);
  if (!left) return right;
  if (!right) return left;
  return left <= right ? left : right;
}

function maxDateKey(a, b) {
  const left = toDateKey(a);
  const right = toDateKey(b);
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}

async function getActive(db, guildId, recruiterId) {
  return db.get(
    'SELECT * FROM absences WHERE guild_id = ? AND recruiter_id = ? AND active = 1 AND end_date >= date("now")',
    guildId,
    recruiterId
  );
}

async function upsertActive(db, guildId, recruiterId, { startDate, endDate, createdBy }) {
  const normalizedStart = toDateKey(startDate) || startDate;
  const normalizedEnd = toDateKey(endDate) || endDate;

  await ensureRecruiter(db, guildId, recruiterId);

  const existing = await db.get(
    'SELECT * FROM absences WHERE guild_id = ? AND recruiter_id = ? AND active = 1',
    guildId,
    recruiterId
  );

  if (existing) {
    const effectiveStart = minDateKey(existing.start_date, normalizedStart) || existing.start_date || normalizedStart;
    const effectiveEnd = maxDateKey(existing.end_date, normalizedEnd) || normalizedEnd;
    await db.run(
      'UPDATE absences SET end_date = ?, created_by = ?, start_date = ? WHERE guild_id = ? AND recruiter_id = ? AND active = 1',
      effectiveEnd,
      createdBy,
      effectiveStart,
      guildId,
      recruiterId
    );
    return { ...existing, start_date: effectiveStart, end_date: effectiveEnd, created_by: createdBy };
  }

  const overlap = await db.get(
    `SELECT *
     FROM absences
     WHERE guild_id = ?
       AND recruiter_id = ?
       AND start_date <= ?
       AND end_date >= ?
     ORDER BY active DESC, end_date DESC, created_at DESC
     LIMIT 1`,
    guildId,
    recruiterId,
    normalizedEnd,
    normalizedStart
  );

  if (overlap && overlap.id) {
    const mergedStart = minDateKey(overlap.start_date, normalizedStart) || overlap.start_date || normalizedStart;
    const mergedEnd = maxDateKey(overlap.end_date, normalizedEnd) || normalizedEnd;
    await db.run(
      'UPDATE absences SET start_date = ?, end_date = ?, created_by = ?, active = 1 WHERE guild_id = ? AND recruiter_id = ? AND id = ?',
      mergedStart,
      mergedEnd,
      createdBy,
      guildId,
      recruiterId,
      overlap.id
    );
    await db.run(
      'UPDATE absences SET active = 0 WHERE guild_id = ? AND recruiter_id = ? AND id <> ? AND active = 1',
      guildId,
      recruiterId,
      overlap.id
    );
    return {
      ...overlap,
      start_date: mergedStart,
      end_date: mergedEnd,
      created_by: createdBy,
      active: 1
    };
  }

  await db.run(
    'INSERT INTO absences (guild_id, recruiter_id, start_date, end_date, created_at, created_by, active) VALUES (?, ?, ?, ?, ?, ?, 1)',
    guildId,
    recruiterId,
    normalizedStart,
    normalizedEnd,
    Date.now(),
    createdBy
  );
  return {
    guild_id: guildId,
    recruiter_id: recruiterId,
    start_date: normalizedStart,
    end_date: normalizedEnd,
    created_by: createdBy,
    active: 1
  };
}

module.exports = { getActive, upsertActive };
