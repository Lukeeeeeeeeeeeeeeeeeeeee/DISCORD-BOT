require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

const GUILD_ID = '1412808625017065544';
const RECRUITER_ROLE_IDS = {
  EU: '1473726977105072314',  // Fire recruiters
  NA: '1473726986508833061',  // Water recruiters
  AS: '1473726967277686854'   // Air recruiters
};

const problematicUsers = [
  '1050044494736150579',  // Shows in Fire but user says shouldn't
  '1141653573959299102',  // Shows in Air but user says shouldn't
  '1381692847018868778',  // SHOULD be in Fire
  '573654608971563029',   // SHOULD be in Air
];

client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}\n`);
  console.log('=== CHECKING RECRUITER ROLES IN DISCORD ===\n');

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    
    // Fetch all members to ensure cache is fresh
    console.log('Fetching all guild members...');
    await guild.members.fetch();
    console.log('✓ Members fetched\n');

    for (const userId of problematicUsers) {
      try {
        const member = await guild.members.fetch(userId);
        console.log(`\n--- User: ${member.user.tag} (${userId}) ---`);
        
        const hasEU = member.roles.cache.has(RECRUITER_ROLE_IDS.EU);
        const hasNA = member.roles.cache.has(RECRUITER_ROLE_IDS.NA);
        const hasAS = member.roles.cache.has(RECRUITER_ROLE_IDS.AS);
        
        console.log(`  Fire/EU Recruiter Role: ${hasEU ? '✅ YES' : '❌ NO'}`);
        console.log(`  Water/NA Recruiter Role: ${hasNA ? '✅ YES' : '❌ NO'}`);
        console.log(`  Air/AS Recruiter Role: ${hasAS ? '✅ YES' : '❌ NO'}`);
        
        if (!hasEU && !hasNA && !hasAS) {
          console.log(`  ⚠️  WARNING: User has NO regional recruiter roles!`);
        }
        
        if ((hasEU && hasNA) || (hasEU && hasAS) || (hasNA && hasAS)) {
          console.log(`  ⚠️  WARNING: User has MULTIPLE regional recruiter roles!`);
        }
        
      } catch (e) {
        console.log(`\n--- User: ${userId} ---`);
        console.log(`  ❌ Could not fetch user: ${e.message}`);
      }
    }
    
    console.log('\n\n=== CHECKING ALL REGIONAL RECRUITER ROLE MEMBERS ===\n');
    
    for (const [region, roleId] of Object.entries(RECRUITER_ROLE_IDS)) {
      const role = guild.roles.cache.get(roleId);
      if (role) {
        const regionName = region === 'EU' ? 'Fire' : region === 'NA' ? 'Water' : 'Air';
        console.log(`\n${regionName} (${region}) Recruiter Role Members (${role.members.size}):`);
        role.members.forEach((member, i) => {
          if (i < 10) {  // First 10
            console.log(`  - ${member.user.tag} (${member.id})`);
          }
        });
        if (role.members.size > 10) {
          console.log(`  ... and ${role.members.size - 10} more`);
        }
      } else {
        console.log(`\n${region}: Role ${roleId} not found`);
      }
    }
    
  } catch (e) {
    console.error('Error:', e);
  }
  
  console.log('\n✅ CHECK COMPLETE\n');
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
