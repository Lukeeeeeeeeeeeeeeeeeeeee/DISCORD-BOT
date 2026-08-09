const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./data/recruiter.db');

console.log('=== INVESTIGATING LEADERBOARD MISMATCH ===\n');

// Check what SHOULD be in Fire
const fireUsers = [
  '1381692847018868778',
  '1238882108097953864',
  '771800679194951722',
  '772733115969175562'
];

// Check what SHOULD be in Air
const airUsers = [
  '573654608971563029',
  '1504846628656250951',
  '1356543666088448071',
  '923399906985664532',
  '1483515679587045578',
  '1476591532357320714',
  '584623617912995859',
  '1359969963405873222'
];

// What's WRONGLY showing in Fire
const wrongFire = ['1050044494736150579'];

// What's WRONGLY showing in Air
const wrongAir = ['1141653573959299102'];

let completed = 0;
const total = fireUsers.length + airUsers.length + wrongFire.length + wrongAir.length;

function checkUser(userId, expectedRegion, label) {
  db.all("SELECT * FROM recruits WHERE recruiter_id = ?", [userId], (err, recruits) => {
    if (err) {
      console.error(`Error checking ${userId}:`, err);
    } else {
      console.log(`\n--- ${label}: ${userId} (expected ${expectedRegion}) ---`);
      console.log(`Total recruits: ${recruits.length}`);
      
      if (recruits.length > 0) {
        const regions = {};
        let totalPoints = 0;
        recruits.forEach(r => {
          regions[r.region] = (regions[r.region] || 0) + 1;
          totalPoints += r.points || 0;
        });
        console.log(`Regions in DB:`, regions);
        console.log(`Total points: ${totalPoints}`);
        console.log(`Guild ID: ${recruits[0].guild_id}`);
        
        const actualRegion = Object.keys(regions)[0];
        if (actualRegion !== expectedRegion) {
          console.log(`❌ MISMATCH! In DB as ${actualRegion} but expected ${expectedRegion}`);
        } else {
          console.log(`✅ Correct region`);
        }
      } else {
        console.log(`⚠️  NO RECRUITS IN DATABASE`);
      }
    }
    
    completed++;
    if (completed === total) {
      console.log('\n\n=== SUMMARY ===');
      console.log('Checking role configuration issue...\n');
      db.close();
    }
  });
}

console.log('FIRE REGION (Expected):');
fireUsers.forEach(userId => checkUser(userId, 'EU', 'Fire User'));

console.log('\n\nAIR REGION (Expected):');
airUsers.forEach(userId => checkUser(userId, 'AS', 'Air User'));

console.log('\n\nWRONGLY IN FIRE:');
wrongFire.forEach(userId => checkUser(userId, 'EU', 'Wrong in Fire'));

console.log('\n\nWRONGLY IN AIR:');
wrongAir.forEach(userId => checkUser(userId, 'AS', 'Wrong in Air'));
