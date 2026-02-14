async function getCooldown(db, guildId, recruiterId) {
  return db.get(
    'SELECT cooldown_until FROM invite_cooldowns WHERE guild_id = ? AND recruiter_id = ?',
    guildId,
    recruiterId
  );
}

async function upsertCooldown(db, guildId, recruiterId, cooldownUntil) {
  return db.run(
    'INSERT OR REPLACE INTO invite_cooldowns (guild_id, recruiter_id, cooldown_until) VALUES (?, ?, ?)',
    guildId,
    recruiterId,
    cooldownUntil
  );
}

async function deleteCooldown(db, guildId, recruiterId) {
  return db.run(
    'DELETE FROM invite_cooldowns WHERE guild_id = ? AND recruiter_id = ?',
    guildId,
    recruiterId
  );
}

async function cleanupExpired(db, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  if (opts.guildId) {
    return db.run(
      'DELETE FROM invite_cooldowns WHERE guild_id = ? AND cooldown_until <= ?',
      opts.guildId,
      now
    );
  }
  if (!opts.allowGlobal) {
    return { changes: 0 };
  }
  return db.run('DELETE FROM invite_cooldowns WHERE cooldown_until <= ?', now);
}

module.exports = {
  getCooldown,
  upsertCooldown,
  deleteCooldown,
  cleanupExpired
};
