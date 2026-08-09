/**
 * CLEANUP DUMMY RECRUITS
 * 
 * Removes all fake/dummy recruit entries from the database.
 * Run this after the manual restore to clean up the fake data.
 */

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

async function cleanupDummyRecruits() {
  console.log('🧹 CLEANING UP DUMMY RECRUITS\n');
  
  const dbPath = path.join(__dirname, '..', 'data', 'recruiter.db');
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });
  
  try {
    // Count dummy recruits before deletion
    const before = await db.get(
      `SELECT COUNT(*) as count FROM recruits 
       WHERE ign LIKE 'Restored_Recruit_%' 
       OR recruited_id LIKE 'DUMMY_%' 
       OR recruited_id LIKE 'RESTORED_%'`
    );
    
    console.log(`Found ${before.count} dummy recruits to remove\n`);
    
    if (before.count === 0) {
      console.log('✅ No dummy recruits found - database is clean!');
      await db.close();
      return;
    }
    
    // Delete dummy recruits (but NOT manual restore data)
    const result = await db.run(
      `DELETE FROM recruits 
       WHERE ign LIKE 'Restored_Recruit_%' 
       OR recruited_id LIKE 'DUMMY_%' 
       OR recruited_id LIKE 'RESTORED_%'`
    );
    
    console.log(`✅ Deleted ${result.changes} dummy recruit entries\n`);
    
    // Verify
    const after = await db.get(
      `SELECT COUNT(*) as count FROM recruits 
       WHERE ign LIKE 'Restored_Recruit_%' 
       OR recruited_id LIKE 'DUMMY_%' 
       OR recruited_id LIKE 'RESTORED_%'`
    );
    
    if (after.count === 0) {
      console.log('✅ Cleanup complete - all dummy recruits removed!');
    } else {
      console.log(`⚠️  Warning: ${after.count} dummy recruits still remain`);
    }
    
    // Show current stats
    const totalRecruits = await db.get('SELECT COUNT(*) as count FROM recruits WHERE valid = 1');
    const totalPoints = await db.get('SELECT SUM(points) as sum FROM recruiters');
    
    console.log('\n📊 Current Database State:');
    console.log(`  Valid Recruits: ${totalRecruits.count}`);
    console.log(`  Total Points: ${totalPoints.sum || 0}`);
    
  } catch (err) {
    console.error('❌ Cleanup failed:', err);
    throw err;
  } finally {
    await db.close();
  }
}

cleanupDummyRecruits().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
