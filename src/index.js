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
const analytics = require('./lib/analytics');
const runtime = require('./lib/runtime');

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

// Create anti-nuke system instance
const antiNukeSystem = new AntiNukeSystem();
const inviteSnapshots = new Map();
const inviteTrackLocks = new Map();
const invitePendingAttributions = new Map();
const voiceSessions = new Map();
const INVITE_SNAPSHOT_TTL_MS = Number.parseInt(process.env.INVITE_SNAPSHOT_TTL_MS || '900000', 10);

const antiNukeInitPromise = antiNukeSystem.init(client).then(() => {
  console.log('🛡️ Complete anti-nuke system with rollback ready!');
}).catch(err => {
  console.error('❌ Failed to initialize anti-nuke:', err);
});

const inviteInitPromise = (async () => {
  const { createInviteTables } = require('./lib/create-invite-tables');
  const inviteCommand = require('./commands/invite');
  await createInviteTables();
  await inviteCommand.init();
  console.log('🔗 Invite system ready!');
})().catch(err => {
  console.error('❌ Failed to initialize invite system:', err);
});

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath)
  .filter(f => f.endsWith('.js'))
  .filter(f => f !== 'verify.js');
for (const file of commandFiles) {
  const cmd = require(path.join(commandsPath, file));
  if (!cmd || !cmd.data || !cmd.data.name || typeof cmd.execute !== 'function') {
    console.warn(`Skipping invalid command module: ${file}`);
    continue;
  }
  client.commands.set(cmd.data.name, cmd);
}

let _readyCalled = false;
async function onReady() {
  if (_readyCalled) return;
  _readyCalled = true;
  console.log(`Logged in as ${client.user.tag}`);
  await antiNukeInitPromise;
  scheduler.start(client, db);

  await inviteInitPromise;
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
      const { registerCommands } = require('./register-commands');
      registerCommands({ guildId }).then(() => {
        console.log(`Auto-synced commands to guild ${guildId}.`);
      }).catch(err => {
        console.error('Failed to auto-sync commands on startup:', err);
      });
    } catch (err) {
      console.error('Failed to require register-commands for auto-sync:', err);
    }
  }
}
// Use the ready event to start schedulers and subsystems once the client is online.
client.once('ready', onReady);

async function flushShutdown(signal) {
  try {
    if (analytics && typeof analytics.flushAll === 'function') {
      await analytics.flushAll();
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
    if (signal) process.exit(0);
  }
}

process.on('SIGINT', () => void flushShutdown('SIGINT'));
process.on('SIGTERM', () => void flushShutdown('SIGTERM'));
process.on('uncaughtException', async (err) => {
  console.error('Uncaught exception:', err);
  await flushShutdown('uncaughtException');
});
process.on('unhandledRejection', async (reason) => {
  console.error('Unhandled rejection:', reason);
  await flushShutdown('unhandledRejection');
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = client.commands.get(interaction.commandName);
  if (!cmd) return;
  try {
    if (interaction.guild) {
      await analytics.recordCommand({ guildId: interaction.guild.id, commandName: interaction.commandName });
    }
    await dispatchCommand(cmd, interaction, { client, db });
  } catch (err) {
    // If the interaction itself failed because it's unknown/expired (10062), ignore silently
    if (err && err.code === 10062) return;
    console.error('Command handler failed', err);
    // Safely notify the user (use editReply if deferred/replied)
    try {
      const { buildErrorEmbed } = require('./lib/embeds');
      const embed = buildErrorEmbed('Command failed.');
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ embeds: [embed] });
      } else {
        await interaction.reply({ embeds: [embed], flags: 64 });
      }
    } catch (err2) {
      // If the interaction is expired, Discord returns code 10062 — ignore silently
      if (err2 && err2.code === 10062) return;
      // otherwise log
      console.error('Failed to send error response for interaction:', err2);
    }
  }
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    if (!oldMember || !newMember) return;
    if (!newMember.user || newMember.user.bot) return;
    if (!oldMember.roles || !oldMember.roles.cache || !newMember.roles || !newMember.roles.cache) return;

    const staffRoles = Array.isArray(ROLE_IDS.STAFF) && ROLE_IDS.STAFF.length
      ? ROLE_IDS.STAFF.filter(Boolean)
      : [
        ROLE_IDS.HELPER,
        ROLE_IDS.HELPER_PLUS,
        ROLE_IDS.HIGH_STAFF,
        ROLE_IDS.MOD,
        ROLE_IDS.CHIEF,
        ROLE_IDS.CHIEF_OF_WAR,
        ROLE_IDS.CHIEF_OF_COMMUNITY,
        ROLE_IDS.CHIEF_OF_RECRUITMENT,
        ROLE_IDS.CO_LEADER,
        ROLE_IDS.LEADER
      ].filter(Boolean);

    const recruiterRoles = [
      ROLE_IDS.RECRUITER,
      ROLE_IDS.TRIAL_RECRUITER,
      ...(RECRUITER_ROLE_IDS ? Object.values(RECRUITER_ROLE_IDS) : [])
    ].filter(Boolean);

    const teamRoles = ROLE_IDS.TEAM_MEMBER ? Object.values(ROLE_IDS.TEAM_MEMBER).filter(Boolean) : [];
    const trackedRoleIds = new Set([...staffRoles, ...recruiterRoles, ...teamRoles, ROLE_IDS.AUTO_PROMOTE_ROLE]);

    const added = newMember.roles.cache.filter(role => !oldMember.roles.cache.has(role.id) && trackedRoleIds.has(role.id));
    const removed = oldMember.roles.cache.filter(role => !newMember.roles.cache.has(role.id) && trackedRoleIds.has(role.id));

    for (const role of added.values()) {
      await analytics.recordRoleChange({
        guildId: newMember.guild.id,
        userId: newMember.id,
        roleId: role.id,
        roleName: role.name,
        action: 'added',
        timestamp: Date.now()
      });
    }

    for (const role of removed.values()) {
      await analytics.recordRoleChange({
        guildId: newMember.guild.id,
        userId: newMember.id,
        roleId: role.id,
        roleName: role.name,
        action: 'removed',
        timestamp: Date.now()
      });
    }
  } catch (e) {
    console.error('Failed to record role change analytics:', e);
  }
});

client.on('messageCreate', async message => {
  if (!message || !message.guild) return;
  if (!message.author || message.author.bot) return;

  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;

  try {
    await analytics.recordMessage({
      guildId: message.guild.id,
      channelId: message.channelId,
      userId: message.author.id,
      timestamp: message.createdTimestamp || Date.now()
    });
  } catch (e) {
    console.error('Failed to record analytics message:', e);
  }

  try {
    await trackRookieChatMessage({ db, member, guild: message.guild, client });
  } catch (e) {
    console.error('Failed to track rookie chat message:', e);
  }

  if (enableMessageContent) {
    try {
      await handleRookieWarLogMessage({ db, message, member, guild: message.guild, client });
    } catch (e) {
      console.error('Failed to track rookie war log:', e);
    }
  }
});

// Track invite usage when members join
client.on('guildMemberAdd', async (member) => {
  try {
    await analytics.recordJoin({ guildId: member.guild.id, userId: member.id, joinedAt: member.joinedAt ? member.joinedAt.getTime() : Date.now() });
  } catch (e) {
    console.error('Failed to record join analytics:', e);
  }

  try {
    // Get invite system instance
    const inviteCommand = require('./commands/invite');
    const inviteSystem = await inviteCommand.init();

    if (!inviteSystem) return;

    console.log(` Member ${member.user.tag} joined the server`);
    await trackInviteUsage(member.guild, inviteSystem, member.id).catch(err => {
      console.error('Invite usage tracking failed:', err);
    });

  } catch (error) {
    console.error('Error tracking invite usage:', error);
  }
});

client.on('error', err => {
  console.error('Discord client error:', err);
});

// When a member leaves, mark their recruit(s) invalid and recompute flags/leaderboards immediately
client.on('guildMemberRemove', async member => {
  try {
    await analytics.recordLeave({ guildId: member.guild.id, userId: member.id, leftAt: Date.now() });
  } catch (e) {
    console.error('Failed to record leave analytics:', e);
  }

  try {
    voiceSessions.delete(`${member.guild.id}:${member.id}`);
  } catch (e) {
    void e;
  }

  try {
    const { handleMemberLeave } = require('./lib/memberLeave');
    await handleMemberLeave(db, member.guild, member);
  } catch (err) {
    console.error('Error handling member leave:', err);
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  const member = newState.member || oldState.member;
  if (!member || !member.user || member.user.bot) return;
  const guild = newState.guild || oldState.guild;
  if (!guild) return;
  const key = `${guild.id}:${member.id}`;
  const now = Date.now();
  const oldChannelId = oldState.channelId;
  const newChannelId = newState.channelId;

  if (!oldChannelId && newChannelId) {
    voiceSessions.set(key, { joinedAt: now });
    return;
  }

  if (oldChannelId && !newChannelId) {
    const session = voiceSessions.get(key);
    const joinedAt = session ? session.joinedAt : null;
    if (joinedAt) {
      const minutes = Math.max(1, Math.round((now - joinedAt) / 60000));
      await analytics.recordVoiceMinutes({ guildId: guild.id, userId: member.id, minutes, timestamp: now });
    }
    voiceSessions.delete(key);
    return;
  }

  if (oldChannelId && newChannelId && oldChannelId !== newChannelId) {
    const session = voiceSessions.get(key);
    const joinedAt = session ? session.joinedAt : null;
    if (joinedAt) {
      const minutes = Math.max(1, Math.round((now - joinedAt) / 60000));
      await analytics.recordVoiceMinutes({ guildId: guild.id, userId: member.id, minutes, timestamp: now });
    }
    voiceSessions.set(key, { joinedAt: now });
  }
});

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
    await db.exec('BEGIN');
    const now = Date.now();
    for (const code of codes) {
      const uses = Number(snapshot.get(code) || 0);
      await db.run(
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
      await db.run(
        `DELETE FROM invite_snapshots WHERE guild_id = ? AND invite_code NOT IN (${placeholders})`,
        guildId,
        ...codes
      );
    } else {
      await db.run('DELETE FROM invite_snapshots WHERE guild_id = ?', guildId);
    }
    await db.exec('COMMIT');
  } catch (e) {
    try { await db.exec('ROLLBACK'); } catch (err) { void err; }
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

    if (coldStart) {
      // With no pre-join snapshot, avoid guessing from total uses.
      try {
        const canFallback = invites && invites.size === 1;
        if (canFallback && inviteSystem && typeof inviteSystem.getActiveInviteCodeCandidates === 'function') {
          const candidates = await inviteSystem.getActiveInviteCodeCandidates();
          if (candidates && candidates.length === 1 && invites.has(candidates[0])) {
            await inviteSystem.markInviteUsed(candidates[0], joinedUserId);
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
    } else {
      invitePendingAttributions.delete(guild.id);
    }

    // If this invite code belongs to our tracked recruiter_invites, mark it used
    if (usedCode && inviteSystem && typeof inviteSystem.markInviteUsed === 'function') {
      await inviteSystem.markInviteUsed(usedCode, joinedUserId);
      await analytics.recordInviteUsed({ guildId: guild.id, timestamp: Date.now() });
      return;
    }

    // Fallback: only attribute when there is exactly one invite and it matches the tracked code.
    try {
      const canFallback = invites && invites.size === 1;
      if (!usedCode && canFallback && inviteSystem && typeof inviteSystem.getActiveInviteCodeCandidates === 'function') {
        const candidates = await inviteSystem.getActiveInviteCodeCandidates();
        if (candidates && candidates.length === 1 && invites.has(candidates[0])) {
          await inviteSystem.markInviteUsed(candidates[0], joinedUserId);
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
  // sanitize token from .env (trim, remove surrounding quotes)
  const rawToken = process.env.DISCORD_TOKEN;
  const token = rawToken ? rawToken.trim().replace(/^"(.+)"$/, '$1') : null;
  if (!token) {
    console.error('FATAL: DISCORD_TOKEN is missing from environment. Create a .env with DISCORD_TOKEN=<your token> and restart.');
    process.exit(1);
  }
  if (token.length < 40) {
    console.error('FATAL: DISCORD_TOKEN appears too short — ensure you pasted the full bot token with no quotes or trailing spaces.');
    process.exit(1);
  }

  try {
    await antiNukeInitPromise;
    await inviteInitPromise;
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
