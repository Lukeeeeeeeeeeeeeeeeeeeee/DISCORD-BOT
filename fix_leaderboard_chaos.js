require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(process.env.DATABASE_PATH || './data/recruiter.db');
const { GUILD_ID, CHANNELS } = require('./src/constants');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ]
});

// Correct leaderboard data based on your original 14:41 message
const correctLeaderboardData = {
  'Fire': [
    { userId: '573654608971563029', name: 'Hikaru', points: 10, recruits: 2 },
    { userId: '1381692847018868778', name: 'AvoidMyRevol', points: 6, recruits: 3 },
    { userId: '1238882108097953864', name: 'Str1k3_C0re', points: 4, recruits: 2 },
    { userId: '882597723864449054', name: 'Centurion5866', points: 2, recruits: 2 },
    { userId: '1385608712080851075', name: 'pero0244421', points: 1, recruits: 2 },
    { name: 'SummerShawty | ME', points: 0, recruits: 2 },
    { name: 'inactive', points: 0, recruits: 3 }
  ],
  'Water': [
    { name: 'yonoflower', points: 0, recruits: 2 },
    { name: 'AvoidMyPing', points: 0, recruits: 2 },
    { name: 'ObsessedWithHer_', points: 0, recruits: 2 },
    { name: 'AvoidMySkillIssue', points: 0, recruits: 3 },
    { name: 'AvoidMySoup', points: 0, recruits: 3 }
  ],
  'Air': [
    { name: 'Ameer', points: 0, recruits: 2 },
    { name: 'MentaalStabiel | absent', points: 0, recruits: 2 },
    { name: '1Sqcrifice', points: 0, recruits: 3 },
    { name: 'AvoidMynubl', points: 0, recruits: 3 },
    { name: 'itz_Urbi', points: 0, recruits: 3 }
  ]
};

function formatLeaderboard() {
  let text = '';
  
  // Fire team
  text += '🔥 Leaderboard (Fire)\n';
  correctLeaderboardData.Fire.forEach(member => {
    const prefix = member.name.includes('|') ? '@' : '@EU | ';
    text += `${prefix}${member.name} [${member.points}/${member.recruits} | ${member.points} pts]\n`;
  });
  
  text += '\n💧 Leaderboard (Water)\n';
  correctLeaderboardData.Water.forEach(member => {
    const prefix = member.name.includes('|') ? '@' : '@EU | ';
    text += `${prefix}${member.name} [${member.points}/${member.recruits} | ${member.points} pts]\n`;
  });
  
  text += '\n🌪️ Leaderboard (Air)\n';
  correctLeaderboardData.Air.forEach(member => {
    let prefix = '@EU | ';
    if (member.name === 'Ameer') prefix = '@';
    if (member.name === 'AvoidMynubl') prefix = '@NA | ';
    if (member.name === 'itz_Urbi') prefix = '@';
    text += `${prefix}${member.name} [${member.points}/${member.recruits} | ${member.points} pts]\n`;
  });
  
  return text.trim();
}

async function fixEverything() {
  try {
    console.log('🔧 Fixing the leaderboard chaos...');
    
    // 1. Update database with correct points
    console.log('📊 Restoring correct points in database...');
    for (const team of Object.values(correctLeaderboardData)) {
      for (const member of team) {
        if (member.userId) {
          await new Promise((resolve, reject) => {
            db.run(
              "UPDATE recruiters SET points = ? WHERE guild_id = ? AND id = ?",
              [member.points, GUILD_ID, member.userId],
              function(err) {
                if (err) reject(err);
                else {
                  console.log(`  ✓ ${member.name}: ${member.points} points`);
                  resolve();
                }
              }
            );
          });
        }
      }
    }
    
    // 2. Find and update the leaderboard message
    console.log('🎯 Finding leaderboard channel...');
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) throw new Error('Guild not found');
    
    const channel = guild.channels.cache.get(CHANNELS.CENTRAL_LEADERBOARD);
    if (!channel) throw new Error('Leaderboard channel not found');
    
    console.log(`📍 Found channel: ${channel.name}`);
    
    // 3. Delete ALL existing leaderboard messages and post ONE clean one
    console.log('🗑️ Cleaning up existing leaderboard messages...');
    const messages = await channel.messages.fetch({ limit: 100 });
    const leaderboardMessages = messages.filter(msg => 
      msg.author.id === client.user.id && 
      (msg.content.includes('🔥 Leaderboard') || msg.content.includes('Leaderboard (Fire)'))
    );
    
    console.log(`Found ${leaderboardMessages.size} leaderboard messages to clean up`);
    
    for (const msg of leaderboardMessages.values()) {
      try {
        await msg.delete();
        console.log(`  ✓ Deleted message ${msg.id}`);
      } catch (err) {
        console.warn(`  ⚠️ Could not delete ${msg.id}: ${err.message}`);
      }
    }
    
    // 4. Post ONE clean, correct leaderboard
    console.log('📝 Posting clean leaderboard...');
    const correctText = formatLeaderboard();
    await channel.send(correctText);
    
    console.log('✅ Leaderboard fixed! Clean slate with correct data.');
    process.exit(0);
    
  } catch (err) {
    console.error('❌ Failed to fix leaderboard:', err);
    process.exit(1);
  }
}

client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  fixEverything();
});

client.login(process.env.DISCORD_TOKEN);