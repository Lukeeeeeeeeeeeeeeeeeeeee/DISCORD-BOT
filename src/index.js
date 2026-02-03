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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildInvites
  ]
});
client.commands = new Collection();

// Create anti-nuke system instance
const antiNukeSystem = new AntiNukeSystem();
const inviteSnapshots = new Map();
const voiceSessions = new Map();

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath)
  .filter(f => f.endsWith('.js'))
  .filter(f => f !== 'verify.js');
for (const file of commandFiles) {
  const cmd = require(path.join(commandsPath, file));
  client.commands.set(cmd.data.name, cmd);
}

let _readyCalled = false;
function onReady() {
  if (_readyCalled) return;
  _readyCalled = true;
  console.log(`Logged in as ${client.user.tag}`);
  scheduler.start(client, db);

  // Initialize anti-nuke system
  antiNukeSystem.init(client).then(() => {
    console.log('🛡️ Complete anti-nuke system with rollback ready!');
  }).catch(err => {
    console.error('❌ Failed to initialize anti-nuke:', err);
  });

  // Initialize invite system
  const { createInviteTables } = require('./lib/create-invite-tables');
  const inviteCommand = require('./commands/invite');

  createInviteTables().then(() => {
    return inviteCommand.init();
  }).then(() => {
    console.log('🔗 Invite system ready!');
    const guildId = GUILD_ID;
    const guild = guildId ? client.guilds.cache.get(guildId) : null;
    if (guild) cacheGuildInvites(guild).catch(() => { });
  }).catch(err => {
    console.error('❌ Failed to initialize invite system:', err);
  });

  // Auto-sync commands to the configured guild (non-blocking) so commands appear immediately
  const guildId = GUILD_ID;
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

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = client.commands.get(interaction.commandName);
  if (!cmd) return;
  const shouldSanitize = interaction.commandName !== 'invite';
  const sanitizePayload = (payload) => {
    if (!payload) return payload;
    const cleaned = typeof payload === 'string' ? { content: payload } : { ...payload };

    if (typeof cleaned.content === 'string' && cleaned.content.length > 2000) {
      cleaned.content = cleaned.content.slice(0, 1997) + '...';
    }

    if (!shouldSanitize) return cleaned;
    if (cleaned.flags !== undefined) delete cleaned.flags;
    if (cleaned.ephemeral !== undefined) delete cleaned.ephemeral;
    return cleaned;
  };
  const wrapInteractionMethod = (methodName) => {
    if (typeof interaction[methodName] !== 'function') return;
    const original = interaction[methodName].bind(interaction);
    interaction[methodName] = (payload, ...rest) => original(sanitizePayload(payload), ...rest);
  };
  wrapInteractionMethod('reply');
  wrapInteractionMethod('editReply');
  wrapInteractionMethod('deferReply');
  wrapInteractionMethod('followUp');
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
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: 'Command failed.' });
      } else {
        await interaction.reply({ content: 'Command failed.' });
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

    const staffRoles = [
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

  try {
    await handleRookieWarLogMessage({ db, message, member, guild: message.guild, client });
  } catch (e) {
    console.error('Failed to track rookie war log:', e);
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

    console.log(`👋 Member ${member.user.tag} joined the server`);
    await trackInviteUsage(member.guild, inviteSystem, member.id).catch(() => { });

  } catch (error) {
    console.error('Error tracking invite usage:', error);
  }
});

// Prevent uncaught rejections / exceptions from crashing the process
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason);
});
process.on('uncaughtException', err => {
  console.error('Uncaught Exception:', err);
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

async function cacheGuildInvites(guild) {
  if (!guild || typeof guild.invites?.fetch !== 'function') return;
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return;
  const map = new Map();
  invites.forEach(inv => map.set(inv.code, inv.uses || 0));
  inviteSnapshots.set(guild.id, map);
}

async function trackInviteUsage(guild, inviteSystem, joinedUserId) {
  if (!guild || typeof guild.invites?.fetch !== 'function') return;
  const previous = inviteSnapshots.get(guild.id) || new Map();
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return;
  let usedCode = null;
  invites.forEach(inv => {
    const prevUses = previous.get(inv.code) || 0;
    const newUses = inv.uses || 0;
    if (newUses > prevUses) usedCode = inv.code;
  });
  const updated = new Map();
  invites.forEach(inv => updated.set(inv.code, inv.uses || 0));
  inviteSnapshots.set(guild.id, updated);

  if (usedCode && inviteSystem && typeof inviteSystem.markInviteUsed === 'function') {
    await inviteSystem.markInviteUsed(usedCode, joinedUserId);
    await analytics.recordInviteUsed({ guildId: guild.id, timestamp: Date.now() });
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
