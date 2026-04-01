const db = require('../db_async');
const { withTransaction } = require('./transactions');

const FLUSH_INTERVAL_MS = Number.parseInt(process.env.ANALYTICS_FLUSH_MS || '10000', 10);
const MAX_BUFFER_SIZE = Number.parseInt(process.env.ANALYTICS_BUFFER_MAX || '5000', 10);
const MAX_REQUEUE_SIZE = Number.parseInt(process.env.ANALYTICS_REQUEUE_MAX || `${MAX_BUFFER_SIZE * 4}`, 10);
const FLUSH_WARN_MS = Number.parseInt(process.env.ANALYTICS_FLUSH_WARN_MS || '2000', 10);
const IMMEDIATE_TX_MAX_RETRIES = Number.parseInt(process.env.ANALYTICS_IMMEDIATE_TX_RETRIES || '3', 10);
const ROLE_CHANGE_FLUSH_MS = Number.parseInt(process.env.ANALYTICS_ROLE_CHANGE_FLUSH_MS || '2500', 10);
const ROLE_CHANGE_BATCH_BASE = Number.parseInt(process.env.ANALYTICS_ROLE_CHANGE_BATCH_BASE || '50', 10);
const ROLE_CHANGE_BATCH_MAX = Number.parseInt(process.env.ANALYTICS_ROLE_CHANGE_BATCH_MAX || '500', 10);
const ROLE_CHANGE_RATE_WINDOW_MS = Number.parseInt(process.env.ANALYTICS_ROLE_CHANGE_RATE_WINDOW_MS || '10000', 10);
const ROLE_CHANGE_QUEUE_MAX = Number.parseInt(process.env.ANALYTICS_ROLE_CHANGE_QUEUE_MAX || `${MAX_REQUEUE_SIZE}`, 10);
const DROP_ON_REQUEUE_CAP = String(process.env.ANALYTICS_DROP_ON_REQUEUE_CAP || 'true').toLowerCase() !== 'false';

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

function isSqliteBusyError(err) {
  if (!err) return false;
  const msg = String(err.message || err).toLowerCase();
  return msg.includes('sqlite_busy')
    || msg.includes('sqlite_locked')
    || msg.includes('database is locked');
}

function capRoleChangeQueue(reason = 'unknown') {
  if (!Number.isFinite(ROLE_CHANGE_QUEUE_MAX) || ROLE_CHANGE_QUEUE_MAX <= 0) return;
  if (roleChangeQueue.length <= ROLE_CHANGE_QUEUE_MAX) return;

  const dropCount = roleChangeQueue.length - ROLE_CHANGE_QUEUE_MAX;
  roleChangeQueue = roleChangeQueue.slice(dropCount);
  droppedRoleChangeEntries += dropCount;

  if (roleChangeEventTimes.length > ROLE_CHANGE_QUEUE_MAX * 2) {
    roleChangeEventTimes = roleChangeEventTimes.slice(-ROLE_CHANGE_QUEUE_MAX);
  }

  console.warn('Analytics role change queue capped', {
    reason,
    dropped: dropCount,
    queued: roleChangeQueue.length,
    droppedTotal: droppedRoleChangeEntries,
    cap: ROLE_CHANGE_QUEUE_MAX
  });
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
let roleChangeQueue = [];
let roleChangeTimer = null;
let roleChangeFlushInFlight = null;
let roleChangeEventTimes = [];
let droppedBufferedEntries = 0;
let droppedRoleChangeEntries = 0;

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

function pruneRoleChangeRateWindow(nowTs = Date.now()) {
  const cutoff = nowTs - ROLE_CHANGE_RATE_WINDOW_MS;
  roleChangeEventTimes = roleChangeEventTimes.filter(ts => ts >= cutoff);
}

function getRoleChangeBatchSize(nowTs = Date.now()) {
  pruneRoleChangeRateWindow(nowTs);
  const windowSeconds = Math.max(1, ROLE_CHANGE_RATE_WINDOW_MS / 1000);
  const eventRate = roleChangeEventTimes.length / windowSeconds;
  const scale = Math.floor(eventRate * 5);
  const target = ROLE_CHANGE_BATCH_BASE + scale;
  return Math.max(ROLE_CHANGE_BATCH_BASE, Math.min(ROLE_CHANGE_BATCH_MAX, target));
}

function scheduleRoleChangeFlush() {
  if (!ROLE_CHANGE_FLUSH_MS || ROLE_CHANGE_FLUSH_MS <= 0) return;
  if (roleChangeTimer) return;
  roleChangeTimer = setTimeout(() => {
    roleChangeTimer = null;
    void flushRoleChanges();
  }, ROLE_CHANGE_FLUSH_MS);
}

async function flushRoleChanges(opts = {}) {
  if (roleChangeFlushInFlight) return roleChangeFlushInFlight;
  roleChangeFlushInFlight = (async () => {
    const forceAll = opts && opts.forceAll === true;
    while (roleChangeQueue.length) {
      const batchSize = forceAll ? roleChangeQueue.length : getRoleChangeBatchSize();
      const batch = roleChangeQueue.splice(0, batchSize);
      if (!batch.length) break;
      try {
        await withTransaction(db, async (tx) => {
          for (const entry of batch) {
            await tx.run(
              'INSERT INTO analytics_role_changes (guild_id, user_id, role_id, role_name, action, created_at) VALUES (?, ?, ?, ?, ?, ?)',
              entry.guildId,
              entry.userId,
              entry.roleId,
              entry.roleName || null,
              entry.action,
              entry.timestamp
            );
          }
        }, { maxRetries: IMMEDIATE_TX_MAX_RETRIES });
      } catch (e) {
        console.error('Role change analytics flush failed:', e);
        roleChangeQueue = batch.concat(roleChangeQueue);
        capRoleChangeQueue(isSqliteBusyError(e) ? 'flush-sqlite-busy' : 'flush-failed');
        break;
      }
      if (!forceAll) break;
    }
  })();

  try {
    return await roleChangeFlushInFlight;
  } finally {
    roleChangeFlushInFlight = null;
    if (roleChangeQueue.length > 0) {
      scheduleRoleChangeFlush();
    }
  }
}

async function flushAll() {
  if (flushInFlight) return flushInFlight;
  flushInFlight = (async () => {
    await flushRoleChanges({ forceAll: true });
    const startedAt = Date.now();
    const snapshot = drainBuffers();
    const snapshotEntries = countSnapshotEntries(snapshot);
    if (!hasPending(snapshot)) return;

    try {
      await withTransaction(db, async (tx) => {
        for (const entry of snapshot.channelCounts.values()) {
          await tx.run(
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
            await tx.run(
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
          await tx.run(
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
            await tx.run(
              'INSERT OR IGNORE INTO analytics_daily_guild_speakers (day, day_ts, guild_id, user_id) VALUES (?, ?, ?, ?)',
              day,
              dayTs,
              guildId,
              userId
            );
          }
        }

        for (const entry of snapshot.userDailyMessages.values()) {
          await tx.run(
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
          await tx.run(
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
          await tx.run(
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
          await tx.run(
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
      }, { maxRetries: IMMEDIATE_TX_MAX_RETRIES });

      const durationMs = Date.now() - startedAt;
      if (durationMs >= FLUSH_WARN_MS) {
        console.warn('Analytics flush completed slowly', {
          durationMs,
          snapshotEntries
        });
      }
    } catch (e) {
      console.error('Analytics flush failed:', e);
      const mergedPending = pendingWrites + snapshotEntries;
      const capped = mergedPending > MAX_REQUEUE_SIZE;

      if (capped && DROP_ON_REQUEUE_CAP) {
        droppedBufferedEntries += snapshotEntries;
        pendingWrites = Math.min(MAX_REQUEUE_SIZE, pendingWrites);
        console.warn('Analytics snapshot dropped after flush failure to prevent unbounded memory growth', {
          mergedPending,
          cap: MAX_REQUEUE_SIZE,
          snapshotEntries,
          droppedBufferedEntries,
          sqliteBusy: isSqliteBusyError(e)
        });
      } else {
        mergeSnapshot(snapshot);
        if (capped) {
          console.warn('Analytics pending queue capped after flush failure', {
            mergedPending,
            cap: MAX_REQUEUE_SIZE,
            snapshotEntries,
            sqliteBusy: isSqliteBusyError(e)
          });
        }
        pendingWrites = Math.min(MAX_REQUEUE_SIZE, mergedPending);
      }
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
  roleChangeQueue.push({
    guildId,
    userId,
    roleId,
    roleName: roleName || null,
    action,
    timestamp
  });
  capRoleChangeQueue('enqueue');
  roleChangeEventTimes.push(timestamp);
  pruneRoleChangeRateWindow(timestamp);
  if (roleChangeQueue.length >= getRoleChangeBatchSize(timestamp)) {
    void flushRoleChanges();
    return;
  }
  scheduleRoleChangeFlush();
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
  const day = toDayKey(ts);
  const dayTs = toDayTs(ts);

  await withTransaction(db, async (tx) => {
    await tx.run(
      `INSERT INTO analytics_daily_guild (day, day_ts, guild_id, message_count, unique_speakers, joins, leaves, invites_created, invites_used)
       VALUES (?, ?, ?, 0, 0, 1, 0, 0, 0)
       ON CONFLICT(day, guild_id) DO UPDATE SET
         joins = joins + 1,
         day_ts = excluded.day_ts`,
      day,
      dayTs,
      guildId
    );
    await tx.run(
      'INSERT OR REPLACE INTO analytics_members (guild_id, user_id, joined_at, left_at) VALUES (?, ?, ?, NULL)',
      guildId,
      userId,
      ts
    );
  }, { maxRetries: IMMEDIATE_TX_MAX_RETRIES });
}

async function recordLeave({ guildId, userId, leftAt }) {
  if (!guildId || !userId) return;
  const ts = leftAt || Date.now();
  const day = toDayKey(ts);
  const dayTs = toDayTs(ts);

  await withTransaction(db, async (tx) => {
    await tx.run(
      `INSERT INTO analytics_daily_guild (day, day_ts, guild_id, message_count, unique_speakers, joins, leaves, invites_created, invites_used)
       VALUES (?, ?, ?, 0, 0, 0, 1, 0, 0)
       ON CONFLICT(day, guild_id) DO UPDATE SET
         leaves = leaves + 1,
         day_ts = excluded.day_ts`,
      day,
      dayTs,
      guildId
    );
    await tx.run(
      'INSERT OR REPLACE INTO analytics_members (guild_id, user_id, joined_at, left_at) VALUES (?, ?, COALESCE((SELECT joined_at FROM analytics_members WHERE guild_id = ? AND user_id = ?), NULL), ?)',
      guildId,
      userId,
      guildId,
      userId,
      ts
    );
  }, { maxRetries: IMMEDIATE_TX_MAX_RETRIES });
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
  flushRoleChanges
};
