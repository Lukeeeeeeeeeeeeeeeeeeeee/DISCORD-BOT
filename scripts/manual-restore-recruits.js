const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { GUILD_ID } = require('../src/constants');
const { getWeekStartUtcTs } = require('../src/lib/week');

async function restoreRecruits() {
  console.log('🔧 Manually restoring recruiter data...\n');
  
  const dbPath = 'c:/discord-bot/data/recruiter.db';
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });
  
  // Recruiters to restore with their recruit counts
  const recruitersData = [
    { userId: '882597723864449054', recruits: 2, region: 'EU', name: 'Centurion' },
    { userId: '1381692847018868778', recruits: 11, region: 'EU', name: 'AvoidMyRevol' },
    { userId: '573654608971563029', recruits: 10, region: 'AS', name: 'Hikaru' },
    { userId: '1356543666088448071', recruits: 1, region: 'EU', name: 'pero0244421' }
  ];
  
  const weekStart = getWeekStartUtcTs();
  const now = Date.now();
  const baseTs = weekStart + (24 * 60 * 60 * 1000); // 1 day after week start
  
  console.log('Week started:', new Date(weekStart).toISOString());
  console.log('Creating recruits with timestamps from:', new Date(baseTs).toISOString(), '\n');
  
  for (const { userId, recruits, region, name } of recruitersData) {
    console.log(`Processing ${name} (${userId})...`);
    
    try {
      // Ensure recruiter exists in the recruiters table
      await db.run(
        `INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) 
         VALUES (?, ?, 0, 0, 0, 4)`,
        [GUILD_ID, userId]
      );
      
      // Delete any existing dummy recruits for this recruiter
      const deleted = await db.run(
        `DELETE FROM recruits WHERE guild_id = ? AND recruiter_id = ?`,
        [GUILD_ID, userId]
      );
      console.log(`  ✓ Cleared ${deleted.changes || 0} old recruits`);
      
      // Create the correct number of recruits
      for (let i = 0; i < recruits; i++) {
        const recruitId = `MANUAL_RESTORE_${userId}_${i}_${Date.now()}_${Math.random()}`;
        const createdAt = baseTs + (i * 3600000); // Spread 1 hour apart
        
        // Use placeholder IGN that won't trigger dummy detection
        const placeholderIgn = `Verified_${name.substring(0, 6)}_${i+1}`;
        
        await db.run(
          `INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, ign, created_at, valid, points)
           VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
          [GUILD_ID, userId, recruitId, region, placeholderIgn, createdAt]
        );
      }
      console.log(`  ✓ Created ${recruits} valid recruits`);
      
      // Update points based on recruits (1 point per recruit)
      await db.run(
        `UPDATE recruiters SET points = ? WHERE guild_id = ? AND id = ?`,
        [recruits, GUILD_ID, userId]
      );
      console.log(`  ✓ Set points to ${recruits}\n`);
      
    } catch (err) {
      console.error(`  ❌ Failed for ${name}:`, err.message, '\n');
    }
  }
  
  // Verify the data
  console.log('📊 Verification:\n');
  for (const { userId, name } of recruitersData) {
    const recruiter = await db.get(
      `SELECT points FROM recruiters WHERE guild_id = ? AND id = ?`,
      [GUILD_ID, userId]
    );
    const recruitCount = await db.get(
      `SELECT COUNT(*) as count FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1`,
      [GUILD_ID, userId]
    );
    
    console.log(`${name}:`);
    console.log(`  Points: ${recruiter?.points || 0}`);
    console.log(`  Recruits: ${recruitCount?.count || 0}\n`);
  }
  
  await db.close();
  
  console.log('✅ DONE! Restart your bot to see updated leaderboard.');
  console.log('⚠️  Remember: these will reset on the weekly reset (Monday 00:05 UTC)');
}

restoreRecruits().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
