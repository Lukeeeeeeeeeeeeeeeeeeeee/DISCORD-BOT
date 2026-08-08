const { GUILD_ID } = require('../constants');
const { getWeekStartUtcTs } = require('./week');

async function restorePointsOnStartup(db) {
  console.log('🔄 Restoring recruiter points and recruits...');
  
  const recruitersToRestore = [
    { userId: '1381692847018868778', points: 6, recruits: 3 },   // AvoidMyRevol
    { userId: '1238882108097953864', points: 4, recruits: 2 },   // Str1k3_C0re
    { userId: '882597723864449054', points: 2, recruits: 2 },    // Centurion5866
    { userId: '573654608971563029', points: 10, recruits: 10 },  // Hikaru
    { userId: '1385608712080851075', points: 1, recruits: 2 }    // pero0244421
  ];
  
  // Get the actual current week start (Monday 00:05 UTC)
  const weekStart = getWeekStartUtcTs();
  const now = Date.now();
  const baseTs = weekStart + (24 * 60 * 60 * 1000); // 1 day after week start
  
  for (const { userId, points, recruits } of recruitersToRestore) {
    try {
      // Restore recruiter points
      await db.run(
        "INSERT OR REPLACE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, ?, 0, 0, 4)",
        [GUILD_ID, userId, points]
      );
      
      // Check how many valid recruits this recruiter already has
      const existing = await db.get(
        'SELECT COUNT(*) as count FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1',
        [GUILD_ID, userId]
      );
      
      const currentCount = existing ? existing.count : 0;
      const needed = recruits - currentCount;
      
      // Create dummy recruits if needed (with timestamps WITHIN current week)
      if (needed > 0) {
        for (let i = 0; i < needed; i++) {
          const dummyId = `DUMMY_${userId}_${i}_${Date.now()}`;
          const createdAt = baseTs + (i * 3600000); // Start 1 day after week start, spread 1 hour apart
          
          await db.run(
            `INSERT OR IGNORE INTO recruits (guild_id, recruiter_id, recruited_id, region, ign, created_at, valid, points)
             VALUES (?, ?, ?, 'EU', ?, ?, 1, 1)`,
            [GUILD_ID, userId, dummyId, `Restored_Recruit_${i+1}`, createdAt]
          );
        }
        console.log(`  ✓ Created ${needed} dummy recruits for ${userId} (timestamps from ${new Date(baseTs).toISOString()})`);
      }
      
    } catch (err) {
      console.error(`Failed to restore data for ${userId}:`, err);
    }
  }
  
  console.log('✅ Points and recruits restored on startup');
}

module.exports = { restorePointsOnStartup };