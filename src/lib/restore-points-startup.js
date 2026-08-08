const { GUILD_ID } = require('../constants');

async function restorePointsOnStartup(db) {
  console.log('🔄 Restoring recruiter points...');
  
  const pointsToRestore = [
    { userId: '1381692847018868778', points: 6 },  // AvoidMyRevol
    { userId: '1238882108097953864', points: 4 },  // Str1k3_C0re
    { userId: '882597723864449054', points: 2 },   // Centurion5866
    { userId: '573654608971563029', points: 10 },  // Hikaru
    { userId: '1385608712080851075', points: 1 }   // pero0244421
  ];
  
  for (const { userId, points } of pointsToRestore) {
    try {
      await db.run(
        "INSERT OR REPLACE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, ?, 0, 0, 4)",
        [GUILD_ID, userId, points]
      );
    } catch (err) {
      console.error(`Failed to restore points for ${userId}:`, err);
    }
  }
  
  console.log('✅ Points restored on startup');
}

module.exports = { restorePointsOnStartup };