require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const db = require('./db_async');
const scheduler = require('./scheduler');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages] });
client.commands = new Collection();

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
for (const file of commandFiles) {
  const cmd = require(path.join(commandsPath, file));
  client.commands.set(cmd.data.name, cmd);
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  scheduler.start(client, db);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = client.commands.get(interaction.commandName);
  if (!cmd) return;
  try {
    await cmd.execute(interaction);
  } catch (err) {
    console.error(err);
    await interaction.reply({ content: 'Command failed.', ephemeral: true });
  }
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
  const token = rawToken ? rawToken.trim().replace(/^"(.+)"$/,'$1') : null;
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
