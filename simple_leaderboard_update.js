require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { GUILD_ID, CHANNELS } = require('./src/constants');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

// Manually craft the leaderboard with restored points
const restoredLeaderboardText = `🔥 Leaderboard (Fire)
@EU | Hikaru [10/2 | 10 pts]
@EU | AvoidMyRevol [6/3 | 6 pts]
@EU | Str1k3_C0re [4/2 | 4 pts]
@EU | Centurion5866 [2/2 | 2 pts]
@EU | pero0244421 [1/2 | 1 pts]
@SummerShawty | ME [0/2 | 0 pts]
@inactive [0/3 | 0 pts]
 
💧 Leaderboard (Water)
@EU | yonoflower [0/2 | 0 pts]
@AS | AvoidMyPing [0/2 | 0 pts]
@ME | ObsessedWithHer_ [0/2 | 0 pts]
@EU | AvoidMySkillIssue [0/3 | 0 pts]
@EU | AvoidMySoup [0/3 | 0 pts]
 
🌪️ Leaderboard (Air)
@Ameer [0/2 | 0 pts]
@EU | MentaalStabiel | absent [0/2 | 0 pts]
@EU | 1Sqcrifice [0/3 | 0 pts]
@NA | AvoidMynubl [0/3 | 0 pts]
@0/2 | itz_Urbi [0/3 | 0 pts]`;

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
    
    // Fetch recent messages to find the FIRST leaderboard (the one from 14:41)
    const messages = await channel.messages.fetch({ limit: 50 });
    const leaderboardMessages = messages.filter(msg => 
      msg.author.id === client.user.id && 
      msg.content.includes('🔥 Leaderboard (Fire)')
    ).sort((a, b) => a.createdTimestamp - b.createdTimestamp); // Oldest first
    
    if (leaderboardMessages.size === 0) {
      console.error('❌ Could not find existing leaderboard message');
      return;
    }
    
    // Get the FIRST (oldest) leaderboard message - that's the 14:41 one
    const firstLeaderboardMsg = leaderboardMessages.first();
    
    console.log(`📝 Found FIRST leaderboard message: ${firstLeaderboardMsg.id}`);
    console.log('Original timestamp:', new Date(firstLeaderboardMsg.createdTimestamp));
    
    // Update the existing message with restored points
    await firstLeaderboardMsg.edit(restoredLeaderboardText);
    console.log('✅ First leaderboard updated with restored points!');
    
    // Delete the newer duplicate leaderboard messages
    const duplicates = leaderboardMessages.filter(msg => msg.id !== firstLeaderboardMsg.id);
    console.log(`🗑️ Deleting ${duplicates.size} duplicate leaderboard messages...`);
    
    for (const duplicate of duplicates.values()) {
      try {
        await duplicate.delete();
        console.log(`  ✓ Deleted message ${duplicate.id}`);
      } catch (err) {
        console.warn(`  ⚠️ Could not delete message ${duplicate.id}:`, err.message);
      }
    }
    
    console.log('✅ All done! The first leaderboard now shows correct points.');
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