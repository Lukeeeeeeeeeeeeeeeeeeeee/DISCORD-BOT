require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const db = require('./src/db_async');
const { GUILD_ID } = require('./src/constants');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ]
});

async function triggerLeaderboard() {
  try {
    console.log('🔄 Manually triggering leaderboard generation...');
    
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) throw new Error('Guild not found');
    
    // Import the scheduler's recompute function
    const scheduler = require('./src/scheduler');
    
    // Get the internal recompute function
    // We need to access the recomputeLeaderboards function
    const { recomputeLeaderboards } = scheduler;
    
    if (typeof recomputeLeaderboards === 'function') {
      await recomputeLeaderboards(db, guild);
      console.log('✅ Leaderboard generated successfully!');
    } else {
      console.error('❌ Could not find recomputeLeaderboards function');
      console.log('Available exports:', Object.keys(scheduler));
    }
    
    process.exit(0);
    
  } catch (err) {
    console.error('❌ Failed to trigger leaderboard:', err);
    process.exit(1);
  }
}

client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  
  // Wait a moment for guild cache to populate
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  triggerLeaderboard();
});

client.login(process.env.DISCORD_TOKEN);