const db = require('../db_async');
const fs = require('fs').promises;
const path = require('path');

const FLUSH_INTERVAL_MS = Number.parseInt(process.env.ANALYTICS_FLUSH_MS || '10000', 10);
const MAX_BUFFER_SIZE = Number.parseInt(process.env.ANALYTICS_BUFFER_MAX || '5000', 10);
const ANALYTICS_PENDING_FILE = path.join(__dirname, '../data/analytics_pending.json');

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

const DAILY_GUILD_COUNTER_SQL = {
  joins: `INSERT INTO analytics_daily_guild (day, day_ts, guild_id, message_count, unique_speakers, joins, leaves, invites_created, invites_used)
          VALUES (?, ?, ?, 0, 0, 1, 0, 0, 0)
          ON CONFLICT(day, guild_id) DO UPDATE SET joins = joins + 1`,
  leaves: `INSERT INTO analytics_daily_guild (day, day_ts, guild_id, message_count, unique_speakers, joins, leaves, invites_created, invites_used)
           VALUES (?, ?, ?, 0, 0, 0, 1, 0, 0)
           ON CONFLICT(day, guild_id) DO UPDATE SET leaves = leaves + 1`,
  invites_created: `INSERT INTO analytics_daily_guild (day, day_ts, guild_id, message_count, unique_speakers, joins, leaves, invites_created, invites_used)
                    VALUES (?, ?, ?, 0, 0, 0, 0, 1, 0)
                    ON CONFLICT(day, guild_id) DO UPDATE SET invites_created = invites_created + 1`,
  invites_used: `INSERT INTO analytics_daily_guild (day, day_ts, guild_id, message_count, unique_speakers, joins, leaves, invites_created, invites_used)
                 VALUES (?, ?, ?, 0, 0, 0, 0, 0, 1)
                 ON CONFLICT(day, guild_id) DO UPDATE SET invites_used = invites_used + 1`
};

async function bumpDailyGuildCounter(guildId, timestamp, field) {
  const sql = DAILY_GUILD_COUNTER_SQL[field];
  if (!sql || !guildId) return;
  const ts = timestamp || Date.now();
  await db.run(sql, toDayKey(ts), toDayTs(ts), guildId);
}

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

function mergeCountEntry(target, incoming, fields = ['count']) {
  if (!incoming) return target;
  if (!target) return { ...incoming };
  const merged = { ...target };
  for (const field of fields) {
    merged[field] = (Number(merged[field]) || 0) + (Number(incoming[field]) || 0);
  }
  if (incoming.lastMessageAt != null) {
    merged.lastMessageAt = Math.max(Number(merged.lastMessageAt) || 0, Number(incoming.lastMessageAt) || 0);
  }
  return merged;
}

function mergeActivityEntry(target, incoming) {
  if (!incoming) return target;
  if (!target) return { ...incoming };
  return {
    ...target,
    lastMessageAt: Math.max(Number(target.lastMessageAt) || 0, Number(incoming.lastMessageAt) || 0),
    lastVoiceAt: Math.max(Number(target.lastVoiceAt) || 0, Number(incoming.lastVoiceAt) || 0),
    lastActiveAt: Math.max(Number(target.lastActiveAt) || 0, Number(incoming.lastActiveAt) || 0)
  };
}

function mergeSnapshot(snapshot) {
  if (!snapshot) return;

  for (const [key, entry] of snapshot.channelCounts.entries()) {
    const existing = channelCounts.get(key);
    channelCounts.set(key, mergeCountEntry(existing, entry, ['count']));
  }
  for (const [key, speakers] of snapshot.channelSpeakers.entries()) {
    const existing = channelSpeakers.get(key) || new Set();
    for (const userId of speakers || []) existing.add(userId);
    channelSpeakers.set(key, existing);
  }
  for (const [key, entry] of snapshot.guildCounts.entries()) {
    const existing = guildCounts.get(key);
    guildCounts.set(key, mergeCountEntry(existing, entry, ['messageCount']));
  }
  for (const [key, speakers] of snapshot.guildSpeakers.entries()) {
    const existing = guildSpeakers.get(key) || new Set();
    for (const userId of speakers || []) existing.add(userId);
    guildSpeakers.set(key, existing);
  }
  for (const [key, entry] of snapshot.userDailyMessages.entries()) {
    const existing = userDailyMessages.get(key);
    userDailyMessages.set(key, mergeCountEntry(existing, entry, ['count']));
  }
  for (const [key, entry] of snapshot.commandUsage.entries()) {
    const existing = commandUsage.get(key);
    commandUsage.set(key, mergeCountEntry(existing, entry, ['count']));
  }
  for (const [key, entry] of snapshot.voiceDaily.entries()) {
    const existing = voiceDaily.get(key);
    voiceDaily.set(key, mergeCountEntry(existing, entry, ['minutes']));
  }
  for (const [key, entry] of snapshot.userActivity.entries()) {
    const existing = userActivity.get(key);
    userActivity.set(key, mergeActivityEntry(existing, entry));
  }
}

function countSnapshotEntries(snapshot) {
  if (!snapshot) return 0;
  return snapshot.channelCounts.size
    + snapshot.channelSpeakers.size
    + snapshot.guildCounts.size
    + snapshot.guildSpeakers.size
    + snapshot.userDailyMessages.size
    + snapshot.userActivity.size
    + snapshot.commandUsage.size
    + snapshot.voiceDaily.size;
}

function serializeSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    channelCounts: Array.from(snapshot.channelCounts.entries()),
    channelSpeakers: Array.from(snapshot.channelSpeakers.entries()).map(([k, speakers]) => [k, Array.from(speakers || [])]),
    guildCounts: Array.from(snapshot.guildCounts.entries()),
    guildSpeakers: Array.from(snapshot.guildSpeakers.entries()).map(([k, speakers]) => [k, Array.from(speakers || [])]),
    userDailyMessages: Array.from(snapshot.userDailyMessages.entries()),
    userActivity: Array.from(snapshot.userActivity.entries()),
    commandUsage: Array.from(snapshot.commandUsage.entries()),
    voiceDaily: Array.from(snapshot.voiceDaily.entries())
  };
}

function deserializeSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    channelCounts: new Map(Array.isArray(raw.channelCounts) ? raw.channelCounts : []),
    channelSpeakers: new Map(
      Array.isArray(raw.channelSpeakers)
        ? raw.channelSpeakers.map(([k, speakers]) => [k, new Set(Array.isArray(speakers) ? speakers : [])])
        : []
    ),
    guildCounts: new Map(Array.isArray(raw.guildCounts) ? raw.guildCounts : []),
    guildSpeakers: new Map(
      Array.isArray(raw.guildSpeakers)
        ? raw.guildSpeakers.map(([k, speakers]) => [k, new Set(Array.isArray(speakers) ? speakers : [])])
        : []
    ),
    userDailyMessages: new Map(Array.isArray(raw.userDailyMessages) ? raw.userDailyMessages : []),
    userActivity: new Map(Array.isArray(raw.userActivity) ? raw.userActivity : []),
    commandUsage: new Map(Array.isArray(raw.commandUsage) ? raw.commandUsage : []),
    voiceDaily: new Map(Array.isArray(raw.voiceDaily) ? raw.voiceDaily : [])
  };
}

async function spillPendingToDisk() {
  const snapshot = drainBuffers();
  if (!hasPending(snapshot)) return false;
  try {
    await fs.mkdir(path.dirname(ANALYTICS_PENDING_FILE), { recursive: true });
    const tmpPath = `${ANALYTICS_PENDING_FILE}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify({
      createdAt: Date.now(),
      snapshot: serializeSnapshot(snapshot)
    }), 'utf8');
    await fs.rename(tmpPath, ANALYTICS_PENDING_FILE);
    return true;
  } catch (e) {
    console.error('Failed to spill analytics pending buffer to disk:', e);
    mergeSnapshot(snapshot);
    pendingWrites = Math.min(MAX_BUFFER_SIZE, pendingWrites + countSnapshotEntries(snapshot));
    scheduleFlush();
    return false;
  }
}

async function restorePendingFromDisk() {
  try {
    const content = await fs.readFile(ANALYTICS_PENDING_FILE, 'utf8');
    const parsed = JSON.parse(content);
    const snapshot = deserializeSnapshot(parsed && parsed.snapshot ? parsed.snapshot : parsed);
    if (!snapshot || !hasPending(snapshot)) {
      try { await fs.unlink(ANALYTICS_PENDING_FILE); } catch (e) { void e; }
      return 0;
    }
    const entryCount = countSnapshotEntries(snapshot);
    mergeSnapshot(snapshot);
    pendingWrites = Math.min(MAX_BUFFER_SIZE, pendingWrites + entryCount);
    try { await fs.unlink(ANALYTICS_PENDING_FILE); } catch (e) { void e; }
    scheduleFlush();
    return entryCount;
  } catch (e) {
    if (e && e.code === 'ENOENT') return 0;
    console.error('Failed to restore analytics pending buffer:', e);
    return 0;
  }
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
          `INSERT INTO analytics_user_activity (guild_id, user_id, last_message_at, last_voice_at, last_active_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(guild_id, user_id) DO UPDATE SET
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
          entry.guildId,
          entry.userId,
          entry.lastMessageAt,
          entry.lastVoiceAt,
          entry.lastActiveAt
        );
      }

      await db.exec('COMMIT');
    } catch (e) {
      try {
        await db.exec('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Analytics rollback failed:', rollbackErr);
      }
      console.error('Analytics flush failed:', e);
      mergeSnapshot(snapshot);
      pendingWrites = Math.min(MAX_BUFFER_SIZE, pendingWrites + countSnapshotEntries(snapshot));
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

  const activityKey = `${guildId}:${userId}`;
  const activityEntry = userActivity.get(activityKey) || {
    guildId,
    userId,
    lastMessageAt: 0,
    lastVoiceAt: null,
    lastActiveAt: 0
  };
  activityEntry.lastMessageAt = Math.max(activityEntry.lastMessageAt, timestamp);
  activityEntry.lastActiveAt = Math.max(activityEntry.lastActiveAt, timestamp);
  userActivity.set(activityKey, activityEntry);

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
  await bumpDailyGuildCounter(guildId, ts, 'joins');
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
  await bumpDailyGuildCounter(guildId, ts, 'leaves');
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
  await bumpDailyGuildCounter(guildId, timestamp, 'invites_created');
}

async function recordInviteUsed({ guildId, timestamp = Date.now() }) {
  if (!guildId) return;
  await bumpDailyGuildCounter(guildId, timestamp, 'invites_used');
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

  const activityKey = `${guildId}:${userId}`;
  const activityEntry = userActivity.get(activityKey) || {
    guildId,
    userId,
    lastMessageAt: 0,
    lastVoiceAt: 0,
    lastActiveAt: 0
  };
  activityEntry.lastVoiceAt = Math.max(activityEntry.lastVoiceAt || 0, timestamp);
  activityEntry.lastActiveAt = Math.max(activityEntry.lastActiveAt || 0, timestamp);
  userActivity.set(activityKey, activityEntry);
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
  flushAll,
  spillPendingToDisk,
  restorePendingFromDisk
};
