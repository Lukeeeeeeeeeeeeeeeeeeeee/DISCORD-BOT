require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { GUILD_ID, RECRUITER_ROLE_IDS } = require('./src/constants');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) {
    console.error('❌ Guild not found');
    process.exit(1);
  }
  
  console.log(`\n📊 Guild: ${guild.name}`);
  console.log(`   Total members in cache: ${guild.members.cache.size}`);
  console.log(`   Total roles: ${guild.roles.cache.size}`);
  
  console.log('\n🔄 Fetching all members (this may take a moment)...');
  await guild.members.fetch();
  console.log(`   ✓ Members after fetch: ${guild.members.cache.size}`);
  
  console.log('\n📋 Checking recruiter roles:');
  for (const [region, roleId] of Object.entries(RECRUITER_ROLE_IDS)) {
    const role = guild.roles.cache.get(roleId);
    
    if (!role) {
      console.log(`\n❌ ${region} (${roleId}): ROLE NOT FOUND`);
      continue;
    }
    
    console.log(`\n✓ ${region} - ${role.name} (${roleId})`);
    console.log(`  Members in role.members: ${role.members.size}`);
    
    // Check manually by iterating all members
    let manualCount = 0;
    const manualMembers = [];
    guild.members.cache.forEach(member => {
      if (member.roles.cache.has(roleId)) {
        manualCount++;
        manualMembers.push(member);
      }
    });
    
    console.log(`  Members found manually: ${manualCount}`);
    
    if (manualCount > 0) {
      manualMembers.forEach(m => {
        console.log(`    - ${m.user.tag} (${m.id})`);
      });
    }
  }
  
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);