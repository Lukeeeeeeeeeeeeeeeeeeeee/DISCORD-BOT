require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const db = require('./db_async');
const scheduler = require('./scheduler');
const { GUILD_ID, ROLE_IDS, RECRUITER_ROLE_IDS } = require('./constants');
const AntiNukeSystem = require('./lib/antinuke-system');
const { dispatchCommand } = require('./lib/command-dispatcher');
const { trackRookieChatMessage } = require('./lib/rookie-chat');
const { handleRookieWarLogMessage } = require('./lib/rookie-war');
const { handleMemberLeave } = require('./lib/memberLeave');
const analytics = require('./lib/analytics');
const runtime = require('./lib/runtime');
const { logUnexpectedError, logVerbose, getCommandCategory, getInteractionMeta } = require('./lib/logger');
const { startHealthServer } = require('./lib/health-server');
const { sanitizeEnvToken, validateRuntimeEnvironment } = require('./lib/env');
const { acquireJobLock } = require('./lib/job-locks');
const { withTransaction } = require('./lib/transactions');
const { registerCommands } = require('./register-commands');
const { isAppError } = require('./lib/errors');
const { buildErrorEmbed } = require('./lib/embeds');
const { createInviteTables } = require('./lib/create-invite-tables');
const { createInteractionCreateHandler } = require('./events/interaction-create');
const { createGuildMemberRemoveHandler } = require('./events/guild-member-remove');
const { createVoiceStateUpdateHandler } = require('./events/voice-state-update');
const { createGuildMemberUpdateHandler } = require('./events/guild-member-update');
const { createMessageCreateHandler } = require('./events/message-create');
const { createGuildMemberAddHandler } = require('./events/guild-member-add');
const { createGuildDeleteHandler } = require('./events/guild-delete');
const { createGuildBanAddHandler } = require('./events/guild-ban-add');
const {
  initWithDb: initInviteSystem,
  dispose: disposeInviteSystem,
  getCached: getCachedInviteSystem
} = require('./services/recruiting/invite-service');
const { initI18n } = require('./lib/i18n');

const enableMessageContent = (process.env.ENABLE_MESSAGE_CONTENT || '').toLowerCase() === 'true';
const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildWebhooks,
  GatewayIntentBits.GuildInvites
];
if (enableMessageContent) intents.push(GatewayIntentBits.MessageContent);

const client = new Client({ intents });
client.commands = new Collection();
runtime.setClient(client);
runtime.setDb(db);

const healthPort = Number.parseInt(process.env.HEALTHCHECK_PORT || '', 10);
if (Number.isFinite(healthPort)) {
  startHealthServer({ db, port: healthPort });
}

// Create anti-nuke system instance
const antiNukeSystem = new AntiNukeSystem();
const inviteSnapshots = new Map();
const inviteTrackLocks = new Map();
const invitePendingAttributions = new Map();
const invitePendingUpdatedAt = new Map();
const voiceSessions = new Map();
const INVITE_SNAPSHOT_TTL_MS = Number.parseInt(process.env.INVITE_SNAPSHOT_TTL_MS || '900000', 10);
const INVITE_PENDING_TTL_MS = Number.parseInt(process.env.INVITE_PENDING_TTL_MS || '60000', 10);
const VOICE_SESSION_STALE_MS = Number.parseInt(process.env.VOICE_SESSION_STALE_MS || String(12 * 60 * 60 * 1000), 10);
const LOG_ROTATE_MAX_BYTES = Number.parseInt(process.env.LOG_ROTATE_MAX_BYTES || String(10 * 1024 * 1024), 10);
const LOG_ROTATE_KEEP = Number.parseInt(process.env.LOG_ROTATE_KEEP || '5', 10);
const LOCAL_LOG_FILES = [
  'error.log',
  'failures.txt',
  'final_test_results.txt',
  'jest_failures.txt',
  'verify_output.txt'
];

async function rotateLogFileIfNeeded(fileName) {
  if (!fileName) return;
  const maxBytes = Number.isFinite(LOG_ROTATE_MAX_BYTES) && LOG_ROTATE_MAX_BYTES > 0
    ? LOG_ROTATE_MAX_BYTES
    : (10 * 1024 * 1024);
  const keep = Number.isFinite(LOG_ROTATE_KEEP) && LOG_ROTATE_KEEP > 0 ? LOG_ROTATE_KEEP : 5;
  const fullPath = path.join(__dirname, '..', fileName);

  let stat = null;
  try {
    stat = await fs.promises.stat(fullPath);
  } catch (e) {
    return;
  }
  if (!stat || !Number.isFinite(stat.size) || stat.size < maxBytes) return;

  try {
    for (let i = keep; i >= 1; i--) {
      const src = `${fullPath}.${i}`;
      const dest = `${fullPath}.${i + 1}`;
      if (i === keep) {
        await fs.promises.unlink(src).catch(() => {});
      } else {
        await fs.promises.rename(src, dest).catch(() => {});
      }
    }
    await fs.promises.rename(fullPath, `${fullPath}.1`);
    console.log(`Rotated oversized log file: ${fileName}`);
  } catch (e) {
    console.error(`Failed rotating log file ${fileName}:`, e);
  }
}

async function rotateLocalLogsIfNeeded() {
  await Promise.all(LOCAL_LOG_FILES.map(file => rotateLogFileIfNeeded(file)));
}

async function ensureRuntimeStateTables() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_voice_sessions (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
  `);
}

async function loadVoiceSessionsFromDb() {
  const now = Date.now();
  const staleCutoff = now - (Number.isFinite(VOICE_SESSION_STALE_MS) && VOICE_SESSION_STALE_MS > 0
    ? VOICE_SESSION_STALE_MS
    : (12 * 60 * 60 * 1000));
  try {
    await db.run('DELETE FROM runtime_voice_sessions WHERE updated_at < ?', staleCutoff);
  } catch (e) {
    console.error('Failed to prune stale runtime voice sessions:', e);
  }

  try {
    const rows = await db.all('SELECT guild_id, user_id, joined_at FROM runtime_voice_sessions');
    for (const row of rows || []) {
      if (!row || !row.guild_id || !row.user_id) continue;
      voiceSessions.set(`${row.guild_id}:${row.user_id}`, { joinedAt: Number(row.joined_at) || now });
    }
  } catch (e) {
    console.error('Failed to load runtime voice sessions:', e);
  }
}

async function upsertVoiceSession(guildId, userId, joinedAt) {
  if (!guildId || !userId || !Number.isFinite(joinedAt)) return;
  await db.run(
    `INSERT INTO runtime_voice_sessions (guild_id, user_id, joined_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET
       joined_at = excluded.joined_at,
       updated_at = excluded.updated_at`,
    guildId,
    userId,
    joinedAt,
    Date.now()
  );
}

async function deleteVoiceSession(guildId, userId) {
  if (!guildId || !userId) return;
  await db.run('DELETE FROM runtime_voice_sessions WHERE guild_id = ? AND user_id = ?', guildId, userId);
}

const antiNukeInitPromise = antiNukeSystem.init(client).then(() => {
  console.log('ðŸ›¡ï¸ Complete anti-nuke system with rollback ready!');
}).catch(err => {
  console.error('âŒ Failed to initialize anti-nuke:', err);
});

const inviteInitPromise = (async () => {
  await createInviteTables();
  // Migrate guild ID if needed (from old server to new server)
  const { migrateGuildIdIfNeeded } = require('./lib/migrate-guild-id');
  await migrateGuildIdIfNeeded(db);
  await initInviteSystem(GUILD_ID, db);
  console.log('ðŸ”— Invite system ready!');
})().catch(err => {
  console.error('âŒ Failed to initialize invite system:', err);
});

const commandsPath = path.join(__dirname, 'commands');
const IGNORE_COMMAND_DIRS = new Set(['recruiter-handlers']);
const IGNORE_COMMAND_FILES = new Set(['verify.js', 'recruiter-helpers.js']);

function loadCommandsRecursively(dir) {
  return fs.promises.readdir(dir, { withFileTypes: true }).then(async (entries) => {
    for (const entry of entries) {
      if (!entry) continue;
      const file = entry.name;
      const fullPath = path.join(dir, file);

      if (entry.isDirectory()) {
        if (IGNORE_COMMAND_DIRS.has(file)) continue;
        await loadCommandsRecursively(fullPath);
        continue;
      }

      if (!entry.isFile() || !file.endsWith('.js') || IGNORE_COMMAND_FILES.has(file)) continue;
      try {
        const cmd = require(fullPath);
        if (cmd && cmd.data && cmd.data.name && typeof cmd.execute === 'function') {
          client.commands.set(cmd.data.name, cmd);
        } else {
          console.warn(`Skipping invalid command module: ${file}`);
        }
      } catch (e) {
        console.error(`Failed to load command ${file}:`, e);
      }
    }
  });
}

const commandLoadPromise = loadCommandsRecursively(commandsPath).catch((err) => {
  console.error('Failed while loading command modules:', err);
});

let _readyCalled = false;
let systemsReady = false;
async function onReady() {
  if (_readyCalled) return;
  _readyCalled = true;
  try {
    console.log(`Logged in as ${client.user.tag}`);
    await rotateLocalLogsIfNeeded();
    await commandLoadPromise;
    await initI18n();
    if (analytics && typeof analytics.restorePendingFromDisk === 'function') {
      const restoredEntries = await analytics.restorePendingFromDisk();
      if (restoredEntries > 0) {
        console.log(`Restored ${restoredEntries} pending analytics entries from disk.`);
      }
    }
    await ensureRuntimeStateTables();
    await loadVoiceSessionsFromDb();
    await antiNukeInitPromise;
    scheduler.start(client, db);

    await inviteInitPromise.catch(err => {
      logUnexpectedError('startup.inviteInitAwait', err);
    });
    for (const cachedGuild of client.guilds.cache.values()) {
      const snapshot = await loadInviteSnapshotFromDb(cachedGuild.id).catch(() => null);
      if (snapshot && snapshot.size) {
        inviteSnapshots.set(cachedGuild.id, snapshot);
      }
    }
    const guildId = GUILD_ID;
    const guild = guildId ? client.guilds.cache.get(guildId) : null;
    if (guild) {
      cacheGuildInvites(guild).catch(err => {
        console.error('Failed to cache guild invites on startup:', err);
      });
    }

    // Auto-sync commands to the configured guild (non-blocking) so commands appear immediately
    if (guildId) {
      try {
        registerCommands({ guildId }).then(() => {
          console.log(`Auto-synced commands to guild ${guildId}.`);
        }).catch(err => {
          console.error('Failed to auto-sync commands on startup:', err);
        });
      } catch (err) {
        console.error('Failed to require register-commands for auto-sync:', err);
      }
    }
    systemsReady = true;
  } catch (err) {
    systemsReady = false;
    console.error('Startup initialization failed; bot will remain in guarded mode.', err);
  }
}
// Start schedulers/subsystems once the client is online (support both event names for compatibility).
client.once('ready', onReady);
client.once('clientReady', onReady);

async function flushShutdown(signal) {
  try {
    if (analytics) {
      if (typeof analytics.flushAll === 'function') {
        try {
          await analytics.flushAll();
        } catch (flushErr) {
          console.error('Failed to flush analytics during shutdown:', flushErr);
        }
      }
      if (typeof analytics.spillPendingToDisk === 'function') {
        try {
          await analytics.spillPendingToDisk();
        } catch (spillErr) {
          console.error('Failed to spill pending analytics during shutdown:', spillErr);
        }
      }
    }
    const antiNuke = runtime.getAntiNuke();
    if (antiNuke && typeof antiNuke.saveData === 'function') {
      await antiNuke.saveData();
    }
    const antiNukeRollback = runtime.getAntiNukeRollback();
    if (antiNukeRollback && typeof antiNukeRollback.saveRollbackData === 'function') {
      await antiNukeRollback.saveRollbackData();
    }
  } catch (e) {
    console.error('Failed to flush anti-nuke data on shutdown:', e);
  } finally {
    try {
      if (db && typeof db.close === 'function') {
        await db.close();
      }
    } catch (closeErr) {
      console.error('Failed to close DB on shutdown:', closeErr);
    }
    try {
      runtime.clearAntiNukeRollback();
      runtime.clearAntiNuke();
      runtime.clearDb();
      runtime.clearClient();
    } catch (stateErr) {
      console.error('Error during runtime state cleanup:', stateErr);
    }
    if (signal) process.exit(0);
  }
}

process.on('SIGINT', () => flushShutdown('SIGINT').catch(err => console.error('Flush shutdown (SIGINT) failed:', err)));
process.on('SIGTERM', () => flushShutdown('SIGTERM').catch(err => console.error('Flush shutdown (SIGTERM) failed:', err)));
process.on('message', async (msg) => {
  if (msg === 'shutdown') {
    await flushShutdown('SHARD_MANAGER');
    return;
  }
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'shutdown') {
    await flushShutdown(msg.signal || 'SHARD_MANAGER');
  }
});
process.on('uncaughtException', async (err) => {
  console.error('Uncaught exception:', err);
  await flushShutdown('uncaughtException');
});
process.on('unhandledRejection', async (reason) => {
  console.error('Unhandled rejection:', reason);
  await flushShutdown('unhandledRejection');
});

client.on('interactionCreate', createInteractionCreateHandler({
  isSystemsReady: () => systemsReady,
  client,
  db,
  analytics,
  dispatchCommand,
  logVerbose,
  getCommandCategory,
  getInteractionMeta,
  isAppError,
  logUnexpectedError,
  buildErrorEmbed
}));

client.on('guildMemberUpdate', createGuildMemberUpdateHandler({
  isSystemsReady: () => systemsReady,
  ROLE_IDS,
  RECRUITER_ROLE_IDS,
  analytics
}));

client.on('messageCreate', createMessageCreateHandler({
  isSystemsReady: () => systemsReady,
  enableMessageContent,
  analytics,
  db,
  client,
  trackRookieChatMessage,
  handleRookieWarLogMessage
}));

client.on('guildMemberAdd', createGuildMemberAddHandler({
  isSystemsReady: () => systemsReady,
  analytics,
  inviteInitPromise,
  getCachedInviteSystem,
  initInviteSystem,
  trackInviteUsage,
  db
}));

client.on('error', err => {
  console.error('Discord client error:', err);
});

client.on('guildDelete', createGuildDeleteHandler({
  inviteSnapshots,
  inviteTrackLocks,
  invitePendingAttributions,
  invitePendingUpdatedAt,
  voiceSessions,
  db,
  disposeInviteSystem
}));

// When a member leaves, mark their recruit(s) invalid and recompute flags/leaderboards immediately
client.on('guildMemberRemove', createGuildMemberRemoveHandler({
  isSystemsReady: () => systemsReady,
  analytics,
  voiceSessions,
  deleteVoiceSession,
  handleMemberLeave,
  db
}));

client.on('guildBanAdd', createGuildBanAddHandler({
  voiceSessions,
  deleteVoiceSession
}));

client.on('voiceStateUpdate', createVoiceStateUpdateHandler({
  isSystemsReady: () => systemsReady,
  analytics,
  voiceSessions,
  upsertVoiceSession,
  deleteVoiceSession
}));

if (typeof process.send === 'function') {
  const heartbeatMs = Number.parseInt(process.env.SHARD_HEARTBEAT_MS || '30000', 10);
  const safeHeartbeatMs = Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : 30000;
  const timer = setInterval(() => {
    try {
      process.send({ type: 'heartbeat', timestamp: Date.now(), pid: process.pid });
    } catch (e) {
      console.error(e);
    }
  }, safeHeartbeatMs);
  if (typeof timer.unref === 'function') timer.unref();
}

async function loadInviteSnapshotFromDb(guildId) {
  if (!guildId) return null;
  try {
    const rows = await db.all(
      'SELECT invite_code, uses, updated_at FROM invite_snapshots WHERE guild_id = ?',
      guildId
    );
    if (!rows || rows.length === 0) return null;
    const freshest = rows.reduce((max, row) => Math.max(max, Number(row.updated_at || 0)), 0);
    if (INVITE_SNAPSHOT_TTL_MS > 0 && freshest && (Date.now() - freshest) > INVITE_SNAPSHOT_TTL_MS) {
      return null;
    }
    const map = new Map();
    for (const row of rows) {
      if (!row || !row.invite_code) continue;
      map.set(row.invite_code, Number(row.uses || 0));
    }
    return map.size ? map : null;
  } catch (e) {
    console.error('Failed to load invite snapshot from DB:', e);
    return null;
  }
}

async function persistInviteSnapshot(guildId, snapshot) {
  if (!guildId || !snapshot) return;
  const codes = Array.from(snapshot.keys());
  try {
    await withTransaction(db, async (tx) => {
      const now = Date.now();
      for (const code of codes) {
        const uses = Number(snapshot.get(code) || 0);
        await tx.run(
          `INSERT INTO invite_snapshots (guild_id, invite_code, uses, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(guild_id, invite_code) DO UPDATE SET uses = excluded.uses, updated_at = excluded.updated_at`,
          guildId,
          code,
          uses,
          now
        );
      }
      if (codes.length) {
        const placeholders = codes.map(() => '?').join(', ');
        await tx.run(
          `DELETE FROM invite_snapshots WHERE guild_id = ? AND invite_code NOT IN (${placeholders})`,
          guildId,
          ...codes
        );
      } else {
        await tx.run('DELETE FROM invite_snapshots WHERE guild_id = ?', guildId);
      }
    });
  } catch (e) {
    console.error('Failed to persist invite snapshot:', e);
  }
}

async function cacheGuildInvites(guild) {
  if (!guild || typeof guild.invites?.fetch !== 'function') return;
  const invites = await guild.invites.fetch().catch(err => {
    console.error('Failed to fetch guild invites:', err);
    return null;
  });
  if (!invites) return;
  const map = new Map();
  invites.forEach(inv => map.set(inv.code, inv.uses || 0));
  inviteSnapshots.set(guild.id, map);
  await persistInviteSnapshot(guild.id, map);
  return map;
}

async function trackInviteUsage(guild, inviteSystem, joinedUserId) {
  if (!guild || typeof guild.invites?.fetch !== 'function') return;
  const lock = inviteTrackLocks.get(guild.id) || Promise.resolve();
  const run = lock.then(async () => {
    // Cross-process/shard safety: only one process should diff invite snapshots per guild per second bucket.
    // This reduces duplicate/misattributed usage when multiple shards/processes observe the same join burst.
    try {
      const bucket = Math.floor(Date.now() / 1000);
      const lockOk = await acquireJobLock(db, {
        guildId: guild.id,
        key: `invite_track_${bucket}`,
        ttlMs: 5000,
        failOpen: false
      });
      if (!lockOk) return;
    } catch (e) {
      // Best effort only; continue with local lock behavior when lock acquisition fails unexpectedly.
      console.error('Invite attribution distributed lock check failed:', e);
    }

    let previous = inviteSnapshots.get(guild.id);
    let coldStart = !previous || previous.size === 0;
    if (coldStart) {
      const dbSnapshot = await loadInviteSnapshotFromDb(guild.id);
      if (dbSnapshot && dbSnapshot.size) {
        previous = dbSnapshot;
        inviteSnapshots.set(guild.id, previous);
        coldStart = false;
      }
    }
    if (coldStart) {
      previous = await cacheGuildInvites(guild).catch(err => {
        console.error('Failed to refresh invite snapshot:', err);
        return null;
      });
    }

    const invites = await guild.invites.fetch().catch(err => {
      console.error('Failed to fetch invites for attribution:', err);
      return null;
    });
    if (!invites) return;

    const updated = new Map();
    invites.forEach(inv => updated.set(inv.code, inv.uses || 0));
    inviteSnapshots.set(guild.id, updated);
    await persistInviteSnapshot(guild.id, updated);
    const pendingMap = invitePendingAttributions.get(guild.id) || new Map();
    const lastPendingAt = invitePendingUpdatedAt.get(guild.id) || 0;
    if (pendingMap.size && INVITE_PENDING_TTL_MS > 0 && (Date.now() - lastPendingAt) > INVITE_PENDING_TTL_MS) {
      pendingMap.clear();
    }

    if (coldStart) {
      // With no pre-join snapshot, avoid guessing from total uses.
      try {
        const canFallback = invites && invites.size === 1;
        if (canFallback && inviteSystem && typeof inviteSystem.getActiveInviteCodeCandidates === 'function') {
          const candidates = await inviteSystem.getActiveInviteCodeCandidates(guild.id);
          if (candidates && candidates.length === 1 && invites.has(candidates[0])) {
            await inviteSystem.markInviteUsed(candidates[0], joinedUserId, guild.id);
            await analytics.recordInviteUsed({ guildId: guild.id, timestamp: Date.now() });
          }
        }
      } catch (e) {
        console.error('Invite attribution fallback failed:', e);
      }
      return;
    }

    const changed = [];
    let best = { code: null, delta: 0 };
    invites.forEach(inv => {
      const prevUses = (previous && previous.get(inv.code)) || 0;
      const newUses = inv.uses || 0;
      const delta = newUses - prevUses;
      if (delta > 0) {
        changed.push({ code: inv.code, delta });
        pendingMap.set(inv.code, (pendingMap.get(inv.code) || 0) + delta);
      }
      if (delta > best.delta) {
        best = { code: inv.code, delta };
      }
    });

    let usedCode = null;
    let bestPending = 0;
    for (const [code, count] of pendingMap.entries()) {
      if (count > bestPending) {
        bestPending = count;
        usedCode = code;
      }
    }

    if (!usedCode) {
      usedCode = changed.length === 1 ? changed[0].code : null;
      if (!usedCode && best.code && best.delta > 0) usedCode = best.code;
    }

    if (usedCode && pendingMap.has(usedCode)) {
      const remaining = (pendingMap.get(usedCode) || 0) - 1;
      if (remaining > 0) {
        pendingMap.set(usedCode, remaining);
      } else {
        pendingMap.delete(usedCode);
      }
    }

    if (pendingMap.size) {
      invitePendingAttributions.set(guild.id, pendingMap);
      invitePendingUpdatedAt.set(guild.id, Date.now());
    } else {
      invitePendingAttributions.delete(guild.id);
      invitePendingUpdatedAt.delete(guild.id);
    }

    // If this invite code belongs to our tracked recruiter_invites, mark it used
    if (usedCode && inviteSystem && typeof inviteSystem.markInviteUsed === 'function') {
      await inviteSystem.markInviteUsed(usedCode, joinedUserId, guild.id);
      await analytics.recordInviteUsed({ guildId: guild.id, timestamp: Date.now() });
      return;
    }

    // Fallback: only attribute when there is exactly one invite and it matches the tracked code.
    try {
      const canFallback = invites && invites.size === 1;
      if (!usedCode && canFallback && inviteSystem && typeof inviteSystem.getActiveInviteCodeCandidates === 'function') {
        const candidates = await inviteSystem.getActiveInviteCodeCandidates(guild.id);
        if (candidates && candidates.length === 1 && invites.has(candidates[0])) {
          await inviteSystem.markInviteUsed(candidates[0], joinedUserId, guild.id);
          await analytics.recordInviteUsed({ guildId: guild.id, timestamp: Date.now() });
        }
      }
    } catch (e) {
      console.error('Invite attribution fallback failed:', e);
    }
  });

  inviteTrackLocks.set(guild.id, run);
  try {
    await run;
  } catch (e) {
    console.error('Invite tracking failed:', e);
  } finally {
    if (inviteTrackLocks.get(guild.id) === run) {
      inviteTrackLocks.delete(guild.id);
    }
  }
}

(async () => {
  try {
    const warnings = validateRuntimeEnvironment({ minNodeMajor: 18 });
    for (const warning of warnings) {
      console.warn(`ENV WARNING: ${warning}`);
    }
  } catch (e) {
    console.error(`FATAL: ${e.message}`);
    process.exit(1);
  }

  const token = sanitizeEnvToken(process.env.DISCORD_TOKEN);
  if (!token) {
    console.error('FATAL: DISCORD_TOKEN is missing from environment. Create a .env with DISCORD_TOKEN=<your token> and restart.');
    process.exit(1);
  }
  if (token.length < 40) {
    console.error('FATAL: DISCORD_TOKEN appears too short â€” ensure you pasted the full bot token with no quotes or trailing spaces.');
    process.exit(1);
  }

  try {
    await antiNukeInitPromise;
    await inviteInitPromise.catch(err => {
      logUnexpectedError('startup.inviteInitAwait', err);
    });
    await client.login(token);
  } catch (err) {
    if (err && err.code === 'TokenInvalid') {
      console.error('FATAL: Provided DISCORD_TOKEN is invalid or has been revoked. Regenerate it in the Discord Developer Portal and update your .env.');
      process.exit(1);
    }
    console.error('FATAL: Failed to login:', err);
    process.exit(1);
  }
})();

