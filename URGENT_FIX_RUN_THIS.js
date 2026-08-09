#!/usr/bin/env node
/**
 * URGENT FIX - Run this directly on the production server
 * This fixes the missing recruit data and broken emoji
 */

require('dotenv').config();
const db = require('./src/db_async');

async function urgentFix() {
  const guildId = process.env.GUILD_ID || '1412808625017065544';
  const now = Date.now();
  const baseTimestamp = Date.now() - (3 * 24 * 60 * 60 * 1000);
  
  console.log('🚨 URGENT FIX - RUNNING NOW 🚨');
  console.log('Guild ID:', guildId);
  console.log();
  
  const fixes = [
    { recruiterId: '1504846628656250951', name: 'dekieats', points: 2, region: 'AS' },
    { recruiterId: '1238882108097953864', name: 'str1k3', points: 4, region: 'EU' },
    { recruiterId: '1050044494736150579', name: 'AvoidMyRevol', points: 11, region: 'EU' },
    { recruiterId: '1141653573959299102', name: 'Hikaru', points: 10, region: 'AS' }
  ];
  
  let fixed = 0;
  
  for (const fix of fixes) {
    const recruiterData = await db.get(
      'SELECT points FROM recruiters WHERE guild_id = ? AND id = ?',
      guildId, fix.recruiterId
    );
    
    const recruitCount = await db.get(
      'SELECT COUNT(*) as cnt FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1',
      guildId, fix.recruiterId
    );
    
    const currentPoints = recruiterData ? recruiterData.points : 0;
    const currentRecruits = recruitCount ? recruitCount.cnt : 0;
    
    if (currentPoints === fix.points && currentRecruits < fix.points) {
      console.log(`⚠️ ${fix.name}: ${currentPoints}pts but only ${currentRecruits} recruits - FIXING...`);
      
      if (!recruiterData) {
        await db.run(
          'INSERT INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, ?, 0, 0, 4)',
          guildId, fix.recruiterId, fix.points
        );
      }
      
      const missing = fix.points - currentRecruits;
      for (let i = 0; i < missing; i++) {
        const timestamp = baseTimestamp + (i * 60 * 60 * 1000);
        const recruitedId = `URGENT_FIX_${fix.recruiterId}_${i}_${now}_${Math.random()}`;
        
        await db.run(
          'INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, points, created_at, valid) VALUES (?, ?, ?, ?, 1, ?, 1)',
          guildId, fix.recruiterId, recruitedId, fix.region, timestamp
        );
      }
      
      fixed++;
      console.log(`✅ Fixed ${fix.name}: added ${missing} recruits`);
    } else {
      console.log(`✓ ${fix.name}: already correct (${currentRecruits} recruits)`);
    }
  }
  
  console.log();
  if (fixed > 0) {
    console.log(`🎉 SUCCESS! Fixed ${fixed} recruiters`);
    console.log('Now restart the bot to regenerate leaderboards');
  } else {
    console.log('✅ All data already correct!');
  }
  
  await db.close();
}

urgentFix().catch(err => {
  console.error('❌ URGENT FIX FAILED:', err);
  process.exit(1);
});
