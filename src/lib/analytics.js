const db = require('../db_async');

function toDayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

async function recordRoleChange({ guildId, userId, roleId, roleName, action, timestamp = Date.now() }) {
  if (!guildId || !userId || !roleId || !action) return;
  await db.run(
    'INSERT INTO analytics_role_changes (guild_id, user_id, role_id, role_name, action, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    guildId,
    userId,
    roleId,
    roleName || null,
    action,
    timestamp
  );
}

async function recordMessage({ guildId, channelId, userId, timestamp = Date.now() }) {
  if (!guildId || !channelId || !userId) return;
  const day = toDayKey(timestamp);

  await db.run(
    'INSERT OR IGNORE INTO analytics_daily_channels (day, guild_id, channel_id, message_count, unique_speakers, last_message_at) VALUES (?, ?, ?, 0, 0, ?)',
    day,
    guildId,
    channelId,
    timestamp
  );
  await db.run(
    'UPDATE analytics_daily_channels SET message_count = message_count + 1, last_message_at = ? WHERE day = ? AND guild_id = ? AND channel_id = ?',
    timestamp,
    day,
    guildId,
    channelId
  );

  const speakerInsert = await db.run(
    'INSERT OR IGNORE INTO analytics_daily_channel_speakers (day, guild_id, channel_id, user_id) VALUES (?, ?, ?, ?)',
    day,
    guildId,
    channelId,
    userId
  );
  if (speakerInsert && speakerInsert.changes) {
    await db.run(
      'UPDATE analytics_daily_channels SET unique_speakers = unique_speakers + 1 WHERE day = ? AND guild_id = ? AND channel_id = ?',
      day,
      guildId,
      channelId
    );
  }

  await db.run(
    'INSERT OR IGNORE INTO analytics_daily_guild (day, guild_id, message_count, unique_speakers, joins, leaves, invites_created, invites_used) VALUES (?, ?, 0, 0, 0, 0, 0, 0)',
    day,
    guildId
  );
  await db.run(
    'UPDATE analytics_daily_guild SET message_count = message_count + 1 WHERE day = ? AND guild_id = ?',
    day,
    guildId
  );

  const guildSpeakerInsert = await db.run(
    'INSERT OR IGNORE INTO analytics_daily_guild_speakers (day, guild_id, user_id) VALUES (?, ?, ?)',
    day,
    guildId,
    userId
  );
  if (guildSpeakerInsert && guildSpeakerInsert.changes) {
    await db.run(
      'UPDATE analytics_daily_guild SET unique_speakers = unique_speakers + 1 WHERE day = ? AND guild_id = ?',
      day,
      guildId
    );
  }

  await db.run(
    'INSERT OR IGNORE INTO analytics_user_activity (user_id, last_message_at, last_voice_at, last_active_at) VALUES (?, ?, NULL, ?)',
    userId,
    timestamp,
    timestamp
  );
  await db.run(
    'UPDATE analytics_user_activity SET last_message_at = ?, last_active_at = ? WHERE user_id = ?',
    timestamp,
    timestamp,
    userId
  );
}

async function recordCommand({ guildId, commandName, timestamp = Date.now() }) {
  if (!guildId || !commandName) return;
  const day = toDayKey(timestamp);
  await db.run(
    'INSERT OR IGNORE INTO analytics_command_usage (day, guild_id, command_name, count) VALUES (?, ?, ?, 0)',
    day,
    guildId,
    commandName
  );
  await db.run(
    'UPDATE analytics_command_usage SET count = count + 1 WHERE day = ? AND guild_id = ? AND command_name = ?',
    day,
    guildId,
    commandName
  );
}

async function recordJoin({ guildId, userId, joinedAt }) {
  if (!guildId || !userId) return;
  const ts = joinedAt || Date.now();
  const day = toDayKey(ts);

  await db.run(
    'INSERT OR IGNORE INTO analytics_daily_guild (day, guild_id, message_count, unique_speakers, joins, leaves, invites_created, invites_used) VALUES (?, ?, 0, 0, 0, 0, 0, 0)',
    day,
    guildId
  );
  await db.run(
    'UPDATE analytics_daily_guild SET joins = joins + 1 WHERE day = ? AND guild_id = ?',
    day,
    guildId
  );
  await db.run(
    'INSERT OR REPLACE INTO analytics_members (guild_id, user_id, joined_at, left_at) VALUES (?, ?, ?, NULL)',
    guildId,
    userId,
    ts
  );
}

async function recordLeave({ guildId, userId, leftAt }) {
  if (!guildId || !userId) return;
  const ts = leftAt || Date.now();
  const day = toDayKey(ts);

  await db.run(
    'INSERT OR IGNORE INTO analytics_daily_guild (day, guild_id, message_count, unique_speakers, joins, leaves, invites_created, invites_used) VALUES (?, ?, 0, 0, 0, 0, 0, 0)',
    day,
    guildId
  );
  await db.run(
    'UPDATE analytics_daily_guild SET leaves = leaves + 1 WHERE day = ? AND guild_id = ?',
    day,
    guildId
  );
  await db.run(
    'INSERT OR REPLACE INTO analytics_members (guild_id, user_id, joined_at, left_at) VALUES (?, ?, COALESCE((SELECT joined_at FROM analytics_members WHERE guild_id = ? AND user_id = ?), NULL), ?)',
    guildId,
    userId,
    guildId,
    userId,
    ts
  );
}

async function recordInviteCreated({ guildId, timestamp = Date.now() }) {
  if (!guildId) return;
  const day = toDayKey(timestamp);
  await db.run(
    'INSERT OR IGNORE INTO analytics_daily_guild (day, guild_id, message_count, unique_speakers, joins, leaves, invites_created, invites_used) VALUES (?, ?, 0, 0, 0, 0, 0, 0)',
    day,
    guildId
  );
  await db.run(
    'UPDATE analytics_daily_guild SET invites_created = invites_created + 1 WHERE day = ? AND guild_id = ?',
    day,
    guildId
  );
}

async function recordInviteUsed({ guildId, timestamp = Date.now() }) {
  if (!guildId) return;
  const day = toDayKey(timestamp);
  await db.run(
    'INSERT OR IGNORE INTO analytics_daily_guild (day, guild_id, message_count, unique_speakers, joins, leaves, invites_created, invites_used) VALUES (?, ?, 0, 0, 0, 0, 0, 0)',
    day,
    guildId
  );
  await db.run(
    'UPDATE analytics_daily_guild SET invites_used = invites_used + 1 WHERE day = ? AND guild_id = ?',
    day,
    guildId
  );
}

async function recordVoiceMinutes({ guildId, userId, minutes, timestamp = Date.now() }) {
  if (!guildId || !userId || !minutes) return;
  const day = toDayKey(timestamp);
  await db.run(
    'INSERT OR IGNORE INTO analytics_voice_daily (day, guild_id, user_id, minutes) VALUES (?, ?, ?, 0)',
    day,
    guildId,
    userId
  );
  await db.run(
    'UPDATE analytics_voice_daily SET minutes = minutes + ? WHERE day = ? AND guild_id = ? AND user_id = ?',
    minutes,
    day,
    guildId,
    userId
  );
  await db.run(
    'INSERT OR IGNORE INTO analytics_user_activity (user_id, last_message_at, last_voice_at, last_active_at) VALUES (?, NULL, ?, ?)',
    userId,
    timestamp,
    timestamp
  );
  await db.run(
    'UPDATE analytics_user_activity SET last_voice_at = ?, last_active_at = ? WHERE user_id = ?',
    timestamp,
    timestamp,
    userId
  );
}

module.exports = {
  toDayKey,
  recordMessage,
  recordCommand,
  recordJoin,
  recordLeave,
  recordInviteCreated,
  recordInviteUsed,
  recordVoiceMinutes,
  recordRoleChange
};
