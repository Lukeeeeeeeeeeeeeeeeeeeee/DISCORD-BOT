require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { GUILD_ID, CHANNELS } = require('./src/constants');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

async function finalCleanup() {
  try {
    console.log('🔥 FINAL CLEANUP - Deleting ALL broken leaderboards...');
    
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) throw new Error('Guild not found');
    
    const channel = guild.channels.cache.get(CHANNELS.CENTRAL_LEADERBOARD);
    if (!channel) throw new Error('Leaderboard channel not found');
    
    console.log(`📍 Cleaning channel: ${channel.name}`);
    
    // Delete ALL bot messages that contain leaderboard content
    let deletedCount = 0;
    let totalMessages = 0;
    
    // Fetch messages in batches
    let lastId = null;
    
    while (true) {
      const fetchOptions = { limit: 100 };
      if (lastId) fetchOptions.before = lastId;
      
      const messages = await channel.messages.fetch(fetchOptions);
      if (messages.size === 0) break;
      
      totalMessages += messages.size;
      lastId = messages.last().id;
      
      // Filter bot messages with leaderboard content
      const leaderboardMessages = messages.filter(msg => 
        msg.author.id === client.user.id && 
        (msg.content.includes('Leaderboard') || 
         msg.content.includes('🔥') || 
         msg.content.includes('💧') || 
         msg.content.includes('🌪️'))
      );
      
      console.log(`Found ${leaderboardMessages.size} leaderboard messages in batch of ${messages.size}`);
      
      // Delete them
      for (const msg of leaderboardMessages.values()) {
        try {
          await msg.delete();
          deletedCount++;
          console.log(`  ✓ Deleted ${msg.id} (${new Date(msg.createdTimestamp).toISOString()})`);
        } catch (err) {
          console.warn(`  ⚠️ Could not delete ${msg.id}: ${err.message}`);
        }
      }
      
      // Prevent rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log(`\n📊 Cleanup Summary:`);
    console.log(`  - Scanned ${totalMessages} total messages`);
    console.log(`  - Deleted ${deletedCount} leaderboard messages`);
    console.log(`\n✅ Channel is now clean! Bot will create fresh leaderboards on next update.`);
    
    process.exit(0);
    
  } catch (err) {
    console.error('❌ Cleanup failed:', err);
    process.exit(1);
  }
}

client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  finalCleanup();
});

client.login(process.env.DISCORD_TOKEN);