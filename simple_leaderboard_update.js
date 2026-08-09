require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const db = require('./src/db_async');
const { GUILD_ID, CHANNELS, RECRUITER_ROLE_IDS } = require('./src/constants');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ]
});

async function triggerLeaderboard() {
  try {
    console.log('🔄 Regenerating leaderboards with live database data...');

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) throw new Error('Guild not found');

    // Use the bot's own recomputeLeaderboards function
    const scheduler = require('./src/scheduler');
    const { recomputeLeaderboards } = scheduler;

    if (typeof recomputeLeaderboards === 'function') {
      await recomputeLeaderboards(db, guild);
      console.log('✅ Leaderboard generated successfully!');
    } else {
      console.error('❌ Could not find recomputeLeaderboards function');
      console.log('Available exports:', Object.keys(scheduler));
      process.exit(1);
    }

    process.exit(0);

  } catch (err) {
    console.error('❌ Failed to regenerate leaderboard:', err);
    process.exit(1);
  }
}

client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await new Promise(resolve => setTimeout(resolve, 2000));
  await triggerLeaderboard();
});

client.login(process.env.DISCORD_TOKEN);
