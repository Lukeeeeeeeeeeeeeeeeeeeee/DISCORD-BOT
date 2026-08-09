require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const db = require('./src/db_async');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ]
});

async function regenerateLeaderboards() {
  console.log('=== REGENERATING LEADERBOARDS ===\n');
  
  await client.login(process.env.DISCORD_TOKEN);
  
  console.log('✓ Logged in as', client.user.tag);
  
  const guildId = process.env.GUILD_ID;
  const guild = await client.guilds.fetch(guildId);
  
  console.log('✓ Fetched guild:', guild.name);
  
  // Import the scheduler's recomputeLeaderboards function
  const { recomputeLeaderboards } = require('./src/scheduler');
  
  console.log('\nRegenerating leaderboards...');
  
  try {
    await recomputeLeaderboards(db, guild);
    console.log('✅ Leaderboards regenerated successfully!');
  } catch (error) {
    console.error('❌ Error regenerating leaderboards:', error);
  }
  
  await client.destroy();
  await db.close();
  
  console.log('\n✅ Complete! Check your Discord channels.');
}

regenerateLeaderboards().catch(console.error);
