require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(process.env.DATABASE_PATH || './data/recruiter.db');

async function cleanDatabase() {
  console.log('🧹 Cleaning up database corruption...');
  
  // 1. Clean up leaderboard_messages table if it exists
  try {
    await new Promise((resolve, reject) => {
      db.run("DELETE FROM leaderboard_messages WHERE guild_id = ?", ['1412808625017065544'], (err) => {
        if (err && !err.message.includes('no such table')) reject(err);
        else {
          console.log('✓ Cleared leaderboard message cache');
          resolve();
        }
      });
    });
  } catch (err) {
    console.log('ℹ️ No leaderboard_messages table to clean');
  }
  
  // 2. Verify recruiter points are correct
  const expectedPoints = {
    '1381692847018868778': 6,  // AvoidMyRevol
    '1238882108097953864': 4,  // Str1k3_C0re  
    '882597723864449054': 2,   // Centurion5866
    '573654608971563029': 10,  // Hikaru
    '1385608712080851075': 1   // pero0244421
  };
  
  console.log('📊 Verifying recruiter points...');
  for (const [userId, expectedPts] of Object.entries(expectedPoints)) {
    await new Promise((resolve, reject) => {
      db.get("SELECT points FROM recruiters WHERE guild_id = ? AND id = ?", 
        ['1412808625017065544', userId], (err, row) => {
        if (err) reject(err);
        else {
          const currentPts = row ? row.points : 0;
          if (currentPts !== expectedPts) {
            console.log(`⚠️ Fixing ${userId}: ${currentPts} -> ${expectedPts} pts`);
            db.run("UPDATE recruiters SET points = ? WHERE guild_id = ? AND id = ?",
              [expectedPts, '1412808625017065544', userId], resolve);
          } else {
            console.log(`✓ ${userId}: ${currentPts} pts (correct)`);
            resolve();
          }
        }
      });
    });
  }
  
  // 3. Check for any corrupted data
  console.log('🔍 Checking for data integrity issues...');
  
  const corruptCheck = await new Promise((resolve) => {
    db.all("SELECT id, points FROM recruiters WHERE guild_id = ? AND (points < 0 OR points > 1000)", 
      ['1412808625017065544'], (err, rows) => {
      if (err) {
        console.warn('Could not check for corrupt data:', err.message);
        resolve([]);
      } else {
        resolve(rows || []);
      }
    });
  });
  
  if (corruptCheck.length > 0) {
    console.log(`⚠️ Found ${corruptCheck.length} entries with suspicious points:`);
    corruptCheck.forEach(r => console.log(`  ${r.id}: ${r.points} pts`));
  } else {
    console.log('✓ No obvious data corruption found');
  }
  
  console.log('✅ Database cleanup complete!');
  db.close();
}

cleanDatabase().catch(console.error);