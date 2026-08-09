require('dotenv').config();
const db = require('./src/db_async');

async function fixPeroRegion() {
  const guildId = process.env.GUILD_ID || '1412808625017065544';
  const peroId = '1356543666088448071';
  
  console.log('=== FIXING PERO REGION ===');
  
  // Check current data
  const currentRecruits = await db.all(
    'SELECT id, recruited_id, region, points FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1',
    guildId, peroId
  );
  
  console.log(`Found ${currentRecruits.length} recruits for pero:`);
  currentRecruits.forEach(r => {
    console.log(`  - ${r.recruited_id}: region=${r.region}, points=${r.points}`);
  });
  
  // Update pero's recruits to AS (Air) region
  const result = await db.run(
    'UPDATE recruits SET region = ? WHERE guild_id = ? AND recruiter_id = ? AND valid = 1',
    'AS', guildId, peroId
  );
  
  console.log(`Updated ${result.changes} recruit(s) to AS region`);
  
  // Verify
  const updated = await db.all(
    'SELECT id, recruited_id, region, points FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1',
    guildId, peroId
  );
  
  console.log('After update:');
  updated.forEach(r => {
    console.log(`  - ${r.recruited_id}: region=${r.region}, points=${r.points}`);
  });
  
  await db.close();
  console.log('\nDone! Now run /leaderboard recompute in Discord');
}

fixPeroRegion().catch(console.error);
