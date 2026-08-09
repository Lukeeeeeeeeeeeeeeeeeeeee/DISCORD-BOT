const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');
const path = require('path');

async function recoverFromCorruptedBackup() {
  console.log('🔧 Starting recovery from corrupted backup...\n');
  
  const corruptedPath = 'c:/discord-bot/data/recruiter.db.corrupted-1786201628627';
  const currentPath = 'c:/discord-bot/data/recruiter.db';
  const backupPath = `c:/discord-bot/data/recruiter.db.before-recovery-${Date.now()}`;
  
  // Backup current DB first
  console.log('📦 Backing up current database...');
  fs.copyFileSync(currentPath, backupPath);
  console.log(`✅ Backed up to: ${backupPath}\n`);
  
  // Open corrupted DB (read-only)
  console.log('📖 Reading data from corrupted backup...');
  const corruptedDb = await open({
    filename: corruptedPath,
    driver: sqlite3.Database,
    mode: sqlite3.OPEN_READONLY
  });
  
  try {
    // Read all recruiter points
    const recruiters = await corruptedDb.all('SELECT * FROM recruiters ORDER BY points DESC');
    console.log(`✅ Found ${recruiters.length} recruiters with points\n`);
    
    console.log('Top 10 Recruiters:');
    for (let i = 0; i < Math.min(10, recruiters.length); i++) {
      const r = recruiters[i];
      console.log(`  ${i+1}. User ${r.id}: ${r.points} pts`);
    }
    
    // Read all valid recruits
    const recruits = await corruptedDb.all('SELECT * FROM recruits WHERE valid=1 ORDER BY created_at DESC');
    console.log(`\n✅ Found ${recruits.length} valid recruits\n`);
    
    console.log('Recent 10 Recruits:');
    for (let i = 0; i < Math.min(10, recruits.length); i++) {
      const r = recruits[i];
      console.log(`  ${i+1}. ${r.ign || r.recruited_id} (by ${r.recruiter_id}) - ${r.points} pts`);
    }
    
    await corruptedDb.close();
    
    // Now write to current DB
    console.log('\n📝 Writing recovered data to current database...');
    const currentDb = await open({
      filename: currentPath,
      driver: sqlite3.Database
    });
    
    // Clear old dummy data
    await currentDb.run('DELETE FROM recruiters');
    await currentDb.run('DELETE FROM recruits');
    console.log('✅ Cleared old data\n');
    
    // Restore recruiters
    for (const r of recruiters) {
      await currentDb.run(
        `INSERT INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [r.guild_id, r.id, r.points, r.warnings || 0, r.promoted || 0, r.channel_base || 4]
      );
    }
    console.log(`✅ Restored ${recruiters.length} recruiters\n`);
    
    // Restore recruits
    for (const r of recruits) {
      await currentDb.run(
        `INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, ign, created_at, valid, points)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.guild_id, r.recruiter_id, r.recruited_id, r.region, r.ign, r.created_at, r.valid, r.points]
      );
    }
    console.log(`✅ Restored ${recruits.length} recruits\n`);
    
    await currentDb.close();
    
    console.log('✅ RECOVERY COMPLETE!\n');
    console.log('Summary:');
    console.log(`  - ${recruiters.length} recruiters restored`);
    console.log(`  - ${recruits.length} recruits restored`);
    console.log(`  - Backup saved at: ${backupPath}`);
    console.log('\n🚀 Restart your bot to see the correct leaderboard!');
    
  } catch (error) {
    console.error('❌ Recovery failed:', error);
    console.log('\n⚠️  You can restore from backup:', backupPath);
    throw error;
  }
}

recoverFromCorruptedBackup().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
