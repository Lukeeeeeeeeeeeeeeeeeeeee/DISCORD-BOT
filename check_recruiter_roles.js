require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { GUILD_ID, RECRUITER_ROLE_IDS } = require('./src/constants');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) {
    console.error('Guild not found');
    process.exit(1);
  }
  
  console.log('\n📋 RECRUITER ROLE CONFIGURATION:');
  console.log('RECRUITER_ROLE_IDS:', RECRUITER_ROLE_IDS);
  console.log('');
  
  for (const [region, roleId] of Object.entries(RECRUITER_ROLE_IDS)) {
    const role = guild.roles.cache.get(roleId);
    console.log(`\n${region} Team (${roleId}):`);
    
    if (!role) {
      console.log('  ❌ ROLE NOT FOUND IN GUILD!');
      continue;
    }
    
    console.log(`  ✓ Role: ${role.name}`);
    console.log(`  ✓ Members: ${role.members.size}`);
    
    if (role.members.size > 0) {
      role.members.forEach(m => {
        console.log(`    - ${m.user.tag} (${m.id})`);
      });
    } else {
      console.log('    (no members with this role)');
    }
  }
  
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);