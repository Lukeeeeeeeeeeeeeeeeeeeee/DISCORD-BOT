async function getCalculatedMinReq(db, guildId, recruiterId, weekStart) {
  return db.get(
    'SELECT calculated_min_req FROM weekly_calculations WHERE guild_id = ? AND recruiter_id = ? AND week_start = ? LIMIT 1',
    guildId,
    recruiterId,
    weekStart
  );
}

module.exports = { getCalculatedMinReq };
