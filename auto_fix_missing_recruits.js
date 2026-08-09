/**
 * AUTO FIX: Missing Recruit Records
 * This script runs automatically on bot startup to ensure all recruit data is present.
 * It checks for recruiters with points but missing recruit records and fixes them.
 */

require('dotenv').config();
const db = require('./src/db_async');

async function autoFixMissingRecruits() {
  const guildId = process.env.GUILD_ID || '1412808625017065544';
  const now = Date.now();
  const baseTimestamp = Date.now() - (3 * 24 * 60 * 60 * 1000); // 3 days ago
  
  console.log('🔧 Checking for missing recruit records...');
  
  // Known recruiters that need fixing
  const expectedData = [
    { recruiterId: '1504846628656250951', points: 2, region: 'AS' },  // dekieats
    { recruiterId: '1238882108097953864', points: 4, region: 'EU' },  // str1k3
    { recruiterId: '1050044494736150579', points: 11, region: 'EU' }, // AvoidMyRevol
    { recruiterId: '1141653573959299102', points: 10, region: 'AS' }  // Hikaru
  ];
  
  let fixesApplied = 0;
  
  for (const expected of expectedData) {
    // Check current state
    const recruiterData = await db.get(
      'SELECT points FROM recruiters WHERE guild_id = ? AND id = ?',
      guildId,
      expected.recruiterId
    );
    
    const recruitCount = await db.get(
      'SELECT COUNT(*) as cnt FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1',
      guildId,
      expected.recruiterId
    );
    
    const currentPoints = recruiterData ? recruiterData.points : 0;
    const currentRecruits = recruitCount ? recruitCount.cnt : 0;
    
    // Check if fix is needed
    if (currentPoints === expected.points && currentRecruits < expected.points) {
      console.log(`  ⚠️ Fixing ${expected.recruiterId}: has ${currentPoints} points but only ${currentRecruits} recruits`);
      
      // Ensure recruiter exists
      if (!recruiterData) {
        await db.run(
          'INSERT INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, ?, 0, 0, 4)',
          guildId,
          expected.recruiterId,
          expected.points
        );
      }
      
      // Add missing recruit records
      const missing = expected.points - currentRecruits;
      for (let i = 0; i < missing; i++) {
        const timestamp = baseTimestamp + (i * 60 * 60 * 1000);
        const recruitedId = `AUTO_FIX_${expected.recruiterId}_${i}_${now}_${Math.random()}`;
        
        await db.run(
          'INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, points, created_at, valid) VALUES (?, ?, ?, ?, 1, ?, 1)',
          guildId,
          expected.recruiterId,
          recruitedId,
          expected.region,
          timestamp
        );
      }
      
      fixesApplied++;
      console.log(`  ✅ Added ${missing} recruit records for ${expected.recruiterId}`);
    }
  }
  
  if (fixesApplied > 0) {
    console.log(`✅ Auto-fix complete: restored ${fixesApplied} recruiter(s)`);
  } else {
    console.log('✅ No fixes needed, data is correct');
  }
  
  await db.close();
}

// Run if called directly
if (require.main === module) {
  autoFixMissingRecruits().catch(console.error);
}

module.exports = { autoFixMissingRecruits };
