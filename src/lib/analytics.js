const db = require('../db_async');

const FLUSH_INTERVAL_MS = Number.parseInt(process.env.ANALYTICS_FLUSH_MS || '10000', 10);
const MAX_BUFFER_SIZE = Number.parseInt(process.env.ANALYTICS_BUFFER_MAX || '5000', 10);

function toDayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

function toDayTs(ts = Date.now()) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function dayKeyToTs(dayKey) {
  const parsed = Date.parse(`${dayKey}T00:00:00Z`);
  if (Number.isFinite(parsed)) return parsed;
  return toDayTs(Date.now());
}

let channelCounts = new Map();
let channelSpeakers = new Map();
let guildCounts = new Map();
let guildSpeakers = new Map();
let userDailyMessages = new Map();
let userActivity = new Map();
let commandUsage = new Map();
let voiceDaily = new Map();

let pendingWrites = 0;
let flushTimer = null;
let flushInFlight = null;

function scheduleFlush() {
  if (!FLUSH_INTERVAL_MS || FLUSH_INTERVAL_MS <= 0) return;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushAll();
  }, FLUSH_INTERVAL_MS);
}

function bumpPending(count = 1) {
  pendingWrites += count;
  if (pendingWrites >= MAX_BUFFER_SIZE) {
    void flushAll();
  } else {
    scheduleFlush();
  }
}

function drainBuffers() {
  const snapshot = {
    channelCounts,
    channelSpeakers,
    guildCounts,
    guildSpeakers,
    userDailyMessages,
    userActivity,
    commandUsage,
    voiceDaily
  };

  channelCounts = new Map();
  channelSpeakers = new Map();
  guildCounts = new Map();
  guildSpeakers = new Map();
  userDailyMessages = new Map();
  userActivity = new Map();
  commandUsage = new Map();
  voiceDaily = new Map();
  pendingWrites = 0;

  return snapshot;
}

function hasPending(snapshot) {
  return snapshot.channelCounts.size
    || snapshot.channelSpeakers.size
    || snapshot.guildCounts.size
    || snapshot.guildSpeakers.size
    || snapshot.userDailyMessages.size
    || snapshot.userActivity.size
    || snapshot.commandUsage.size
    || snapshot.voiceDaily.size;
}

async function flushAll() {
  if (flushInFlight) return flushInFlight;
  flushInFlight = (async () => {
    const snapshot = drainBuffers();
    if (!hasPending(snapshot)) return;

    try {
      await db.exec('BEGIN');

      for (const entry of snapshot.channelCounts.values()) {
        await db.run(
          `INSERT INTO analytics_daily_channels (day, day_ts, guild_id, channel_id, message_count, unique_speakers, last_message_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(day, guild_id, channel_id) DO UPDATE SET
             message_count = message_count + excluded.message_count,
             last_message_at = MAX(last_message_at, excluded.last_message_at),
             day_ts = excluded.day_ts`,
          entry.day,
          entry.dayTs,
          entry.guildId,
          entry.channelId,
          entry.count,
          entry.lastMessageAt
        );
      }

      for (const [key, speakers] of snapshot.channelSpeakers.entries()) {
        if (!speakers || speakers.size === 0) continue;
        const [day, guildId, channelId] = key.split(':');
        const dayTs = dayKeyToTs(day);
        for (const userId of speakers.values()) {
          await db.run(
            'INSERT OR IGNORE INTO analytics_daily_channel_speakers (day, day_ts, guild_id, channel_id, user_id) VALUES (?, ?, ?, ?, ?)',
            day,
            dayTs,
            guildId,
            channelId,
            userId
          );
        }
      }

      for (const entry of snapshot.guildCounts.values()) {
        await db.run(
          `INSERT INTO analytics_daily_guild (day, day_ts, guild_id, message_count, unique_speakers, joins, leaves, invites_created, invites_used)
           VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0)
           ON CONFLICT(day, guild_id) DO UPDATE SET
             message_count = message_count + excluded.message_count,
             day_ts = excluded.day_ts`,
          entry.day,
          entry.dayTs,
          entry.guildId,
          entry.messageCount
        );
      }

      for (const [key, speakers] of snapshot.guildSpeakers.entries()) {
        if (!speakers || speakers.size === 0) continue;
        const [day, guildId] = key.split(':');
        const dayTs = dayKeyToTs(day);
        for (const userId of speakers.values()) {
          await db.run(
            'INSERT OR IGNORE INTO analytics_daily_guild_speakers (day, day_ts, guild_id, user_id) VALUES (?, ?, ?, ?)',
            day,
            dayTs,
            guildId,
            userId
          );
        }
      }

      for (const entry of snapshot.userDailyMessages.values()) {
        await db.run(
          `INSERT INTO analytics_user_daily_messages (day, day_ts, guild_id, user_id, message_count)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(day, guild_id, user_id) DO UPDATE SET
             message_count = message_count + excluded.message_count,
             day_ts = excluded.day_ts`,
          entry.day,
          entry.dayTs,
          entry.guildId,
          entry.userId,
          entry.count
        );
      }

      for (const entry of snapshot.commandUsage.values()) {
        await db.run(
          `INSERT INTO analytics_command_usage (day, day_ts, guild_id, command_name, count)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(day, guild_id, command_name) DO UPDATE SET
             count = count + excluded.count,
             day_ts = excluded.day_ts`,
          entry.day,
          entry.dayTs,
          entry.guildId,
          entry.commandName,
          entry.count
        );
      }

      for (const entry of snapshot.voiceDaily.values()) {
        await db.run(
          `INSERT INTO analytics_voice_daily (day, day_ts, guild_id, user_id, minutes)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(day, guild_id, user_id) DO UPDATE SET
             minutes = minutes + excluded.minutes,
             day_ts = excluded.day_ts`,
          entry.day,
          entry.dayTs,
          entry.guildId,
          entry.userId,
          entry.minutes
        );
      }

      for (const entry of snapshot.userActivity.values()) {
        await db.run(
          `INSERT INTO analytics_user_activity (user_id, last_message_at, last_voice_at, last_active_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             last_message_at = CASE
               WHEN excluded.last_message_at IS NULL THEN last_message_at
               WHEN last_message_at IS NULL OR excluded.last_message_at > last_message_at THEN excluded.last_message_at
               ELSE last_message_at
             END,
             last_voice_at = CASE
               WHEN excluded.last_voice_at IS NULL THEN last_voice_at
               WHEN last_voice_at IS NULL OR excluded.last_voice_at > last_voice_at THEN excluded.last_voice_at
               ELSE last_voice_at
             END,
             last_active_at = CASE
               WHEN excluded.last_active_at IS NULL THEN last_active_at
               WHEN last_active_at IS NULL OR excluded.last_active_at > last_active_at THEN excluded.last_active_at
               ELSE last_active_at
             END`,
          entry.userId,
          entry.lastMessageAt,
          entry.lastVoiceAt,
          entry.lastActiveAt
        );
      }

      await db.exec('COMMIT');
    } catch (e) {
      await db.exec('ROLLBACK');
      console.error('Analytics flush failed:', e);
    }
  })();

  try {
    return await flushInFlight;
  } finally {
    flushInFlight = null;
    if (pendingWrites > 0) {
      scheduleFlush();
    }
  }
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
  const dayTs = toDayTs(timestamp);

  const channelKey = `${day}:${guildId}:${channelId}`;
  const channelEntry = channelCounts.get(channelKey) || {
    day,
    dayTs,
    guildId,
    channelId,
    count: 0,
    lastMessageAt: 0
  };
  channelEntry.count += 1;
  channelEntry.lastMessageAt = Math.max(channelEntry.lastMessageAt, timestamp);
  channelCounts.set(channelKey, channelEntry);

  const channelSpeakerSet = channelSpeakers.get(channelKey) || new Set();
  channelSpeakerSet.add(userId);
  channelSpeakers.set(channelKey, channelSpeakerSet);

  const guildKey = `${day}:${guildId}`;
  const guildEntry = guildCounts.get(guildKey) || {
    day,
    dayTs,
    guildId,
    messageCount: 0
  };
  guildEntry.messageCount += 1;
  guildCounts.set(guildKey, guildEntry);

  const guildSpeakerSet = guildSpeakers.get(guildKey) || new Set();
  guildSpeakerSet.add(userId);
  guildSpeakers.set(guildKey, guildSpeakerSet);

  const userKey = `${day}:${guildId}:${userId}`;
  const userEntry = userDailyMessages.get(userKey) || {
    day,
    dayTs,
    guildId,
    userId,
    count: 0
  };
  userEntry.count += 1;
  userDailyMessages.set(userKey, userEntry);

  const activityEntry = userActivity.get(userId) || {
    userId,
    lastMessageAt: 0,
    lastVoiceAt: null,
    lastActiveAt: 0
  };
  activityEntry.lastMessageAt = Math.max(activityEntry.lastMessageAt, timestamp);
  activityEntry.lastActiveAt = Math.max(activityEntry.lastActiveAt, timestamp);
  userActivity.set(userId, activityEntry);

  bumpPending();
}

async function recordCommand({ guildId, commandName, timestamp = Date.now() }) {
  if (!guildId || !commandName) return;
  const day = toDayKey(timestamp);
  const dayTs = toDayTs(timestamp);
  const key = `${day}:${guildId}:${commandName}`;
  const entry = commandUsage.get(key) || {
    day,
    dayTs,
    guildId,
    commandName,
    count: 0
  };
  entry.count += 1;
  commandUsage.set(key, entry);
  bumpPending();
}

async function recordJoin({ guildId, userId, joinedAt }) {
  if (!guildId || !userId) return;
  const ts = joinedAt || Date.now();
  const day = toDayKey(ts);

  await db.run(
    'INSERT OR IGNORE INTO analytics_daily_guild (day, day_ts, guild_id, message_count, unique_speakers, joins, leaves, invites_created, invites_used) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0)',
    day,
    toDayTs(ts),
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
    'INSERT OR IGNORE INTO analytics_daily_guild (day, day_ts, guild_id, message_count, unique_speakers, joins, leaves, invites_created, invites_used) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0)',
    day,
    toDayTs(ts),
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
    'INSERT OR IGNORE INTO analytics_daily_guild (day, day_ts, guild_id, message_count, unique_speakers, joins, leaves, invites_created, invites_used) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0)',
    day,
    toDayTs(timestamp),
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
    'INSERT OR IGNORE INTO analytics_daily_guild (day, day_ts, guild_id, message_count, unique_speakers, joins, leaves, invites_created, invites_used) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0)',
    day,
    toDayTs(timestamp),
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
  const dayTs = toDayTs(timestamp);
  const key = `${day}:${guildId}:${userId}`;
  const entry = voiceDaily.get(key) || {
    day,
    dayTs,
    guildId,
    userId,
    minutes: 0
  };
  entry.minutes += minutes;
  voiceDaily.set(key, entry);

  const activityEntry = userActivity.get(userId) || {
    userId,
    lastMessageAt: 0,
    lastVoiceAt: 0,
    lastActiveAt: 0
  };
  activityEntry.lastVoiceAt = Math.max(activityEntry.lastVoiceAt || 0, timestamp);
  activityEntry.lastActiveAt = Math.max(activityEntry.lastActiveAt || 0, timestamp);
  userActivity.set(userId, activityEntry);
  bumpPending();
}

module.exports = {
  toDayKey,
  toDayTs,
  recordMessage,
  recordCommand,
  recordJoin,
  recordLeave,
  recordInviteCreated,
  recordInviteUsed,
  recordVoiceMinutes,
  recordRoleChange,
  flushAll
};
