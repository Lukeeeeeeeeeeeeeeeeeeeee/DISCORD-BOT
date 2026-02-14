async function acquireJobLock(db, { guildId, key, ttlMs, failOpen = false } = {}) {
  if (!db || !guildId || !key || !Number.isFinite(ttlMs)) return !!failOpen;
  const now = Date.now();
  const expiryCutoff = now - ttlMs;

  try {
    const res = await db.run(
      `INSERT INTO system_events (guild_id, key, timestamp)
       VALUES (?, ?, ?)
       ON CONFLICT(guild_id, key) DO UPDATE SET timestamp = excluded.timestamp
       WHERE system_events.timestamp < ?`,
      guildId,
      key,
      now,
      expiryCutoff
    );
    const changes = res && typeof res.changes === 'number' ? res.changes : 0;
    return changes > 0;
  } catch (err) {
    const msg = (err && err.message) ? String(err.message).toLowerCase() : '';
    const fallbackNeeded = msg.includes('syntax error') || msg.includes('on conflict');
    if (!fallbackNeeded) {
      console.error('Job lock acquisition failed', { key, error: err });
      return !!failOpen;
    }
  }

  try {
    await db.run('BEGIN IMMEDIATE');
    const existing = await db.get(
      'SELECT timestamp FROM system_events WHERE guild_id = ? AND key = ?',
      guildId,
      key
    );
    if (existing && Number.isFinite(existing.timestamp) && now - existing.timestamp < ttlMs) {
      await db.run('ROLLBACK');
      return false;
    }
    await db.run(
      'INSERT OR REPLACE INTO system_events (guild_id, key, timestamp) VALUES (?, ?, ?)',
      guildId,
      key,
      now
    );
    await db.run('COMMIT');
    return true;
  } catch (err) {
    try { await db.run('ROLLBACK'); } catch (e) { void e; }
    console.error('Job lock acquisition failed (fallback)', { key, error: err });
    return !!failOpen;
  }
}

module.exports = { acquireJobLock };
