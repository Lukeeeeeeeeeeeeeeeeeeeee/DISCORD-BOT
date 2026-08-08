require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const db = require('./src/db_async');
const { GUILD_ID, CHANNELS } = require('./src/constants');
const { fetchLeaderboardRows, loadRecruiterMeta } = require('./src/lib/leaderboard-utils');
const { makeLeaderboardText } = require('./src/lib/messages');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

async function updateExistingLeaderboard() {
  try {
    console.log('🔄 Updating existing leaderboard with restored points...');
    
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) {
      console.error('Guild not found');
      return;
    }
    
    const channel = guild.channels.cache.get(CHANNELS.CENTRAL_LEADERBOARD);
    if (!channel) {
      console.error('Leaderboard channel not found');
      return;
    }
    
    console.log(`📍 Found channel: ${channel.name}`);
    
    // Fetch recent messages to find the leaderboard
    const messages = await channel.messages.fetch({ limit: 50 });
    const leaderboardMsg = messages.find(msg => 
      msg.author.id === client.user.id && 
      msg.content.includes('🔥 Leaderboard (Fire)')
    );
    
    if (!leaderboardMsg) {
      console.error('❌ Could not find existing leaderboard message');
      return;
    }
    
    console.log(`📝 Found leaderboard message: ${leaderboardMsg.id}`);
    console.log('Original timestamp:', new Date(leaderboardMsg.createdTimestamp));
    
    // Generate updated leaderboard content
    const regions = ['EU', 'NA', 'AS'];
    let fullLeaderboardText = '';
    
    for (const region of regions) {
      const rows = await fetchLeaderboardRows(db, GUILD_ID, region);
      const enriched = await loadRecruiterMeta(guild, rows);
      const regionText = makeLeaderboardText(enriched, region, 'en');
      fullLeaderboardText += regionText + '\n';
    }
    
    // Update the existing message
    await leaderboardMsg.edit(fullLeaderboardText.trim());
    console.log('✅ Leaderboard updated successfully!');
    
    process.exit(0);
    
  } catch (err) {
    console.error('❌ Failed to update leaderboard:', err);
    process.exit(1);
  }
}

client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  updateExistingLeaderboard();
});

client.login(process.env.DISCORD_TOKEN);