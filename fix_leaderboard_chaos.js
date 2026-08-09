require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const db = require('./src/db_async');
const { GUILD_ID } = require('./src/constants');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ]
});

async function fixEverything() {
  try {
    console.log('🔧 Fixing the leaderboard chaos...');

    // Find the leaderboard channel
    console.log('🎯 Finding leaderboard channel...');
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) throw new Error('Guild not found');

    // Delete ALL existing leaderboard messages for cleanup
    console.log('🗑️ Cleaning up stale leaderboard messages...');
    const channels = [
      require('./src/constants').CHANNELS.INVITES_EU,
      require('./src/constants').CHANNELS.INVITES_NA,
      require('./src/constants').CHANNELS.INVITES_AS,
      require('./src/constants').CHANNELS.CENTRAL_LEADERBOARD
    ].filter(Boolean);

    for (const chId of channels) {
      const channel = guild.channels.cache.get(chId);
      if (!channel || !channel.messages || typeof channel.messages.fetch !== 'function') continue;
      try {
        const messages = await channel.messages.fetch({ limit: 100 });
        const leaderboardMessages = messages.filter(msg => {
          if (!msg.author || msg.author.id !== client.user.id) return false;
          return msg.content.includes('🔥 Leaderboard') ||
                 msg.content.includes('💧 Leaderboard') ||
                 msg.content.includes('🌪️ Leaderboard') ||
                 msg.content.includes('Leaderboard (Fire)') ||
                 msg.content.includes('Leaderboard (Water)') ||
                 msg.content.includes('Leaderboard (Air)');
        });
        for (const msg of leaderboardMessages.values()) {
          try {
            await msg.delete();
            console.log(`  ✓ Deleted stale message ${msg.id} in ${channel.name || channel.id}`);
          } catch (err) {
            console.warn(`  ⚠️ Could not delete ${msg.id}: ${err.message}`);
          }
        }
      } catch (err) {
        console.warn(`  ⚠️ Could not fetch messages from ${channel.name || channel.id}: ${err.message}`);
      }
    }

    // Use the bot's own recomputeLeaderboards function to generate correct data
    console.log('📊 Regenerating leaderboards from database...');
    const scheduler = require('./src/scheduler');
    const { recomputeLeaderboards, recomputeWarningsLeaderboard } = scheduler;

    if (typeof recomputeLeaderboards === 'function') {
      await recomputeLeaderboards(db, guild);
      console.log('✅ Main leaderboards recomputed successfully!');
    } else {
      console.error('❌ Could not find recomputeLeaderboards function');
    }

    if (typeof recomputeWarningsLeaderboard === 'function') {
      try {
        await recomputeWarningsLeaderboard(db, guild);
        console.log('✅ Warnings leaderboard recomputed successfully!');
      } catch (warnErr) {
        console.log('⚠️ Warning leaderboard recompute failed:', warnErr.message);
      }
    }

    console.log('✅ Leaderboard chaos fixed! Using live database data.');
    process.exit(0);

  } catch (err) {
    console.error('❌ Failed to fix leaderboard:', err);
    process.exit(1);
  }
}

client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  // Wait a moment for guild cache to populate
  await new Promise(resolve => setTimeout(resolve, 2000));
  await fixEverything();
});

client.login(process.env.DISCORD_TOKEN);
