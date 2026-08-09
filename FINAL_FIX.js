require('dotenv').config();
const db = require('./src/db_async');

async function finalFix() {
  const guildId = process.env.GUILD_ID || '1412808625017065544';
  const peroId = '1356543666088448071';
  const fireChannelId = '1535651146767798363';
  const airChannelId = '1535651147048558692';
  
  console.log('=== FINAL FIX ===\n');
  
  // 1. Delete pero's leaderboard entry from Fire channel
  console.log('1. Removing pero from Fire leaderboard tracking...');
  const deleted = await db.run(
    'DELETE FROM leaderboard_messages WHERE guild_id = ? AND channel_id = ? AND region = ?',
    guildId, fireChannelId, 'EU'
  );
  console.log(`   Deleted ${deleted.changes} Fire leaderboard message(s)`);
  
  // 2. Update pero's recruit to AS region
  console.log('\n2. Moving pero\'s recruit to AS (Air) region...');
  const updated = await db.run(
    'UPDATE recruits SET region = ? WHERE guild_id = ? AND recruiter_id = ? AND valid = 1',
    'AS', guildId, peroId
  );
  console.log(`   Updated ${updated.changes} recruit(s) to AS region`);
  
  // 3. Remove duplicate leaderboard messages for users showing twice
  console.log('\n3. Cleaning duplicate leaderboard entries...');
  
  // Get all leaderboard messages
  const allMessages = await db.all(
    'SELECT id, channel_id, region, message_id FROM leaderboard_messages WHERE guild_id = ?',
    guildId
  );
  
  console.log(`   Found ${allMessages.length} leaderboard message records`);
  
  // Group by channel+region to find duplicates
  const grouped = {};
  for (const msg of allMessages) {
    const key = `${msg.channel_id}_${msg.region}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(msg);
  }
  
  // Keep only the most recent message for each channel+region
  let removed = 0;
  for (const key in grouped) {
    const msgs = grouped[key];
    if (msgs.length > 1) {
      // Sort by id desc (newest first)
      msgs.sort((a, b) => b.id - a.id);
      // Remove all except the first (newest)
      for (let i = 1; i < msgs.length; i++) {
        await db.run('DELETE FROM leaderboard_messages WHERE id = ?', msgs[i].id);
        removed++;
      }
    }
  }
  console.log(`   Removed ${removed} duplicate tracking records`);
  
  // 4. Verify final state
  console.log('\n4. Verification:');
  
  const peroRecruits = await db.all(
    'SELECT id, region, points FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1',
    guildId, peroId
  );
  console.log(`   Pero recruits: ${peroRecruits.length} in region ${peroRecruits[0]?.region || 'NONE'}`);
  
  const finalMessages = await db.all(
    'SELECT channel_id, region, COUNT(*) as cnt FROM leaderboard_messages WHERE guild_id = ? GROUP BY channel_id, region',
    guildId
  );
  console.log(`   Leaderboard messages: ${finalMessages.length} unique channel+region combinations`);
  
  await db.close();
  
  console.log('\n✅ DONE. Now run /leaderboard recompute in Discord');
}

finalFix().catch(console.error);
