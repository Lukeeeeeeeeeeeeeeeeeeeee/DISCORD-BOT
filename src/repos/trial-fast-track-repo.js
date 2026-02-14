async function getByRecruiter(db, guildId, recruiterId) {
  return db.get(
    'SELECT * FROM trial_fast_track WHERE guild_id = ? AND recruiter_id = ?',
    guildId,
    recruiterId
  );
}

async function upsert(db, guildId, recruiterId, data) {
  return db.run(
    'INSERT OR REPLACE INTO trial_fast_track (guild_id, recruiter_id, started_at, recruit1_id, recruit2_id, recruit3_id, count, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    guildId,
    recruiterId,
    data.startedAt,
    data.recruit1Id || null,
    data.recruit2Id || null,
    data.recruit3Id || null,
    data.count || 0,
    data.updatedAt
  );
}

async function clear(db, guildId, recruiterId) {
  return db.run(
    'DELETE FROM trial_fast_track WHERE guild_id = ? AND recruiter_id = ?',
    guildId,
    recruiterId
  );
}

module.exports = { getByRecruiter, upsert, clear };
