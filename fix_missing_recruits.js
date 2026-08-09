require('dotenv').config();
const db = require('./src/db_async');

async function fixMissingRecruits() {
  const guildId = process.env.GUILD_ID || '1412808625017065544';
  const now = Date.now();
  const baseTimestamp = Date.now() - (3 * 24 * 60 * 60 * 1000); // 3 days ago to ensure in 7-day window
  
  console.log('=== FIXING MISSING RECRUITS ===');
  console.log('Guild ID:', guildId);
  console.log();
  
  // Missing recruits to add
  const missingRecruits = [
    // dekieats - needs 2 recruits
    { recruiterId: '1504846628656250951', recruiterName: 'dekieats', count: 2, region: 'AS', points: 1 },
    // str1k3 - has points but missing the recruit records for those 4 points
    { recruiterId: '1238882108097953864', recruiterName: 'str1k3', count: 4, region: 'EU', points: 1 },
    // AvoidMyRevol - needs 11 recruits
    { recruiterId: '1050044494736150579', recruiterName: 'AvoidMyRevol', count: 11, region: 'EU', points: 1 },
    // Hikaru - needs 10 recruits  
    { recruiterId: '1141653573959299102', recruiterName: 'Hikaru', count: 10, region: 'AS', points: 1 }
  ];
  
  for (const rec of missingRecruits) {
    console.log(`\n--- Adding ${rec.count} recruits for ${rec.recruiterName} (${rec.recruiterId}) ---`);
    
    // Ensure recruiter exists in recruiters table
    const existing = await db.get(
      'SELECT id, points FROM recruiters WHERE guild_id = ? AND id = ?',
      guildId,
      rec.recruiterId
    );
    
    if (!existing) {
      console.log('Creating recruiter record...');
      await db.run(
        `INSERT INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
         VALUES (?, ?, ?, 0, 0, 4)`,
        guildId,
        rec.recruiterId,
        rec.count * rec.points
      );
    } else {
      // Update points if needed
      const expectedPoints = rec.count * rec.points;
      if (existing.points !== expectedPoints) {
        console.log(`Updating points from ${existing.points} to ${expectedPoints}...`);
        await db.run(
          'UPDATE recruiters SET points = ? WHERE guild_id = ? AND id = ?',
          expectedPoints,
          guildId,
          rec.recruiterId
        );
      }
    }
    
    // Add recruit records
    for (let i = 0; i < rec.count; i++) {
      const timestamp = baseTimestamp + (i * 60 * 60 * 1000); // Spread over hours
      const recruitedId = `FIXED_${rec.recruiterId}_${i}_${now}_${Math.random()}`;
      
      try {
        await db.run(
          `INSERT INTO recruits 
           (guild_id, recruiter_id, recruited_id, region, points, created_at, valid)
           VALUES (?, ?, ?, ?, ?, ?, 1)`,
          guildId,
          rec.recruiterId,
          recruitedId,
          rec.region,
          rec.points,
          timestamp
        );
        console.log(`  ✓ Added recruit ${i + 1}/${rec.count}`);
      } catch (error) {
        console.error(`  ❌ Failed to add recruit ${i + 1}:`, error.message);
      }
    }
    
    // Also insert into recruiter_points_ledger for audit trail
    await db.run(
      `INSERT INTO recruiter_points_ledger 
       (guild_id, recruiter_id, delta, reason, ref_type, ref_id, created_at)
       VALUES (?, ?, ?, 'manual_fix_2026-08-09', 'bulk', 'data_restoration', ?)`,
      guildId,
      rec.recruiterId,
      rec.count * rec.points,
      now
    ).catch(() => console.log('  (Ledger insert skipped - table may not exist)'));
  }
  
  console.log('\n=== VERIFICATION ===\n');
  
  // Verify the fixes
  const allRecruiters = [
    { id: '1504846628656250951', name: 'dekieats', expected: 2 },
    { id: '1356543666088448071', name: 'pero', expected: 1 },
    { id: '1238882108097953864', name: 'str1k3', expected: 4 },
    { id: '882597723864449054', name: 'centurion', expected: 2 },
    { id: '1050044494736150579', name: 'AvoidMyRevol', expected: 11 },
    { id: '1141653573959299102', name: 'Hikaru', expected: 10 }
  ];
  
  for (const r of allRecruiters) {
    const recruiterData = await db.get(
      'SELECT points FROM recruiters WHERE guild_id = ? AND id = ?',
      guildId,
      r.id
    );
    
    const recruitCount = await db.get(
      'SELECT COUNT(*) as cnt FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1',
      guildId,
      r.id
    );
    
    const match = recruitCount.cnt === r.expected ? '✅' : '❌';
    console.log(`${match} ${r.name}: ${recruitCount.cnt}/${r.expected} recruits, ${recruiterData ? recruiterData.points : 0} points`);
  }
  
  await db.close();
  console.log('\n✅ Fix complete! Please restart the bot and regenerate leaderboards.');
}

fixMissingRecruits().catch(console.error);
