async function getLatestByRecruitedId(db, guildId, recruitedId) {
  return db.get(
    'SELECT * FROM verifications WHERE guild_id = ? AND recruited_id = ? ORDER BY verified_at DESC LIMIT 1',
    guildId,
    recruitedId
  );
}

module.exports = { getLatestByRecruitedId };
