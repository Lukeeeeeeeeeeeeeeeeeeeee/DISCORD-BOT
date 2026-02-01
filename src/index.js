require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const db = require('./db_async');
const scheduler = require('./scheduler');
const { GUILD_ID } = require('./constants');
const AntiNukeSystem = require('./lib/antinuke-system');
const { dispatchCommand } = require('./lib/command-dispatcher');
const { trackRookieChatMessage } = require('./lib/rookie-chat');
const { handleRookieWarLogMessage } = require('./lib/rookie-war');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildInvites
  ]
});
client.commands = new Collection();

// Create anti-nuke system instance
const antiNukeSystem = new AntiNukeSystem();

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
client.once('clientReady', onReady);

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = client.commands.get(interaction.commandName);
  if (!cmd) return;
  const shouldSanitize = interaction.commandName !== 'invite';
  const sanitizePayload = (payload) => {
    if (!shouldSanitize || !payload || typeof payload !== 'object') return payload;
    const cleaned = { ...payload };
    if ('flags' in cleaned) delete cleaned.flags;
    if (cleaned.ephemeral) delete cleaned.ephemeral;
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

client.on('messageCreate', async message => {
  if (!message || !message.guild) return;
  if (!message.author || message.author.bot) return;

  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;

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
    // Get invite system instance
    const inviteCommand = require('./commands/invite');
    const inviteSystem = await inviteCommand.init();

    if (!inviteSystem) return;

    // This is a simplified approach - in production you'd want to track invite counts before/after
    // For now, we'll just log that a member joined
    console.log(`👋 Member ${member.user.tag} joined the server`);

    // TODO: Implement proper invite tracking by comparing invite counts
    // This would require storing invite counts and comparing them when members join

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
    const { handleMemberLeave } = require('./lib/memberLeave');
    await handleMemberLeave(db, member.guild, member);
  } catch (err) {
    console.error('Error handling member leave:', err);
  }
});

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
