async function getActiveInvites(db, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const guildId = opts.guildId || null;
  const allowGlobal = !!opts.allowGlobal;
  if (guildId) {
    return db.all(
      'SELECT * FROM recruiter_invites WHERE guild_id = ? AND used = 0 AND expires_at > ? ORDER BY created_at DESC',
      guildId,
      now
    );
  }
  if (!allowGlobal) return [];
  return db.all(
    'SELECT * FROM recruiter_invites WHERE used = 0 AND expires_at > ? ORDER BY created_at DESC',
    now
  );
}

async function insertInvite(db, guildId, data) {
  return db.run(
    'INSERT INTO recruiter_invites (guild_id, recruiter_id, invite_code, invite_url, created_at, expires_at, used) VALUES (?, ?, ?, ?, ?, ?, 0)',
    guildId,
    data.recruiterId,
    data.inviteCode,
    data.inviteUrl,
    data.createdAt,
    data.expiresAt
  );
}

async function markUsed(db, guildId, inviteCode, usedBy, usedAt = Date.now()) {
  if (guildId) {
    return db.run(
      'UPDATE recruiter_invites SET used = 1, used_at = ?, used_by = ? WHERE guild_id = ? AND invite_code = ?',
      usedAt,
      usedBy,
      guildId,
      inviteCode
    );
  }
  return { changes: 0 };
}

async function markExpired(db, guildId, inviteCode, usedAt = Date.now()) {
  if (guildId) {
    return db.run(
      'UPDATE recruiter_invites SET used = 1, used_at = ? WHERE guild_id = ? AND invite_code = ?',
      usedAt,
      guildId,
      inviteCode
    );
  }
  return { changes: 0 };
}

async function cleanupExpired(db, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const guildId = opts.guildId || null;
  const allowGlobal = !!opts.allowGlobal;
  if (guildId) {
    return db.run(
      'DELETE FROM recruiter_invites WHERE guild_id = ? AND (expires_at < ? OR (used = 1 AND used_at < ?))',
      guildId,
      now,
      now - (7 * 24 * 60 * 60 * 1000)
    );
  }
  if (!allowGlobal) return { changes: 0 };
  return db.run(
    'DELETE FROM recruiter_invites WHERE expires_at < ? OR (used = 1 AND used_at < ?)',
    now,
    now - (7 * 24 * 60 * 60 * 1000)
  );
}

async function getStats(db, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const sinceMs = Number.isFinite(opts.sinceMs) ? opts.sinceMs : (now - (7 * 24 * 60 * 60 * 1000));
  const guildId = opts.guildId || null;
  const allowGlobal = !!opts.allowGlobal;
  if (guildId) {
    return db.get(
      `SELECT
         COUNT(*) as total_invites,
         COUNT(CASE WHEN used = 1 THEN 1 END) as used_invites,
         COUNT(CASE WHEN used = 0 AND expires_at > ? THEN 1 END) as active_invites
       FROM recruiter_invites
       WHERE guild_id = ? AND created_at > ?`,
      now,
      guildId,
      sinceMs
    );
  }
  if (!allowGlobal) return { total_invites: 0, used_invites: 0, active_invites: 0 };
  return db.get(
    `SELECT
       COUNT(*) as total_invites,
       COUNT(CASE WHEN used = 1 THEN 1 END) as used_invites,
       COUNT(CASE WHEN used = 0 AND expires_at > ? THEN 1 END) as active_invites
     FROM recruiter_invites
     WHERE created_at > ?`,
    now,
    sinceMs
  );
}

async function getActiveCodes(db, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit)) : 10;
  const guildId = opts.guildId || null;
  const allowGlobal = !!opts.allowGlobal;
  if (guildId) {
    const rows = await db.all(
      'SELECT invite_code FROM recruiter_invites WHERE guild_id = ? AND used = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT ?',
      guildId,
      now,
      limit
    );
    return (rows || []).map(r => r.invite_code).filter(Boolean);
  }
  if (!allowGlobal) return [];
  const rows = await db.all(
    'SELECT invite_code FROM recruiter_invites WHERE used = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT ?',
    now,
    limit
  );
  return (rows || []).map(r => r.invite_code).filter(Boolean);
}

module.exports = {
  getActiveInvites,
  insertInvite,
  markUsed,
  markExpired,
  cleanupExpired,
  getStats,
  getActiveCodes
};
