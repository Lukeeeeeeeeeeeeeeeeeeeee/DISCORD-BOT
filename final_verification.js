require('dotenv').config();
const db = require('./src/db_async');
const { getRolling7DayStartTs } = require('./src/lib/week');
const { getRegionInfo } = require('./src/lib/regions');

async function finalVerification() {
  const guildId = process.env.GUILD_ID;
  const rolling7dStart = getRolling7DayStartTs();
  
  console.log('=== FINAL VERIFICATION ===');
  console.log('Guild ID:', guildId);
  console.log('7-day window:', new Date(rolling7dStart).toISOString(), 'to', new Date().toISOString());
  console.log();
  
  const expected = [
    { id: '882597723864449054', name: 'Centurion', recruits: 2, region: 'NA' },
    { id: '1356543666088448071', name: 'pero', recruits: 1, region: 'EU' },
    { id: '1050044494736150579', name: 'AvoidMyRevol', recruits: 11, region: 'EU' },
    { id: '1238882108097953864', name: 'Str1k3_C0re', recruits: 4, region: 'EU' },
    { id: '1141653573959299102', name: 'Hikaru', recruits: 10, region: 'AS' },
    { id: '1504846628656250951', name: 'Dekieats', recruits: 2, region: 'AS' }
  ];
  
  let allCorrect = true;
  
  for (const exp of expected) {
    const actual = await db.get(`
      SELECT COUNT(*) as cnt 
      FROM recruits 
      WHERE guild_id = ? 
        AND recruiter_id = ? 
        AND valid = 1 
        AND created_at >= ?
    `, guildId, exp.id, rolling7dStart);
    
    const recruiterData = await db.get(`
      SELECT points 
      FROM recruiters 
      WHERE guild_id = ? AND id = ?
    `, guildId, exp.id);
    
    const regionInfo = getRegionInfo(exp.region);
    const match = actual.cnt === exp.recruits;
    const status = match ? '✅' : '❌';
    
    console.log(`${status} ${regionInfo.emoji} ${exp.name}: ${actual.cnt}/${exp.recruits} recruits, ${recruiterData ? recruiterData.points : 0}pts`);
    
    if (!match) allCorrect = false;
  }
  
  console.log();
  
  if (allCorrect) {
    console.log('🎉 ALL CHECKS PASSED! Leaderboards should now be correct.');
  } else {
    console.log('⚠️ Some discrepancies remain. Check the output above.');
  }
  
  // Check Air emoji is fixed
  const airInfo = getRegionInfo('AS');
  console.log();
  console.log('Air Region Emoji Check:', airInfo.emoji === '🌪️' ? '✅ Fixed' : '❌ Still broken');
  
  await db.close();
}

finalVerification().catch(console.error);
