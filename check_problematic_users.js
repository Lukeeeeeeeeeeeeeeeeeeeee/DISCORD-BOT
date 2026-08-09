const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./data/recruiter.db');

const problemUsers = ['1050044494736150579', '1141653573959299102', '1356543666088448071'];

console.log('=== CHECKING PROBLEMATIC USERS ===\n');

let completed = 0;
problemUsers.forEach(userId => {
  db.all("SELECT * FROM recruits WHERE recruiter_id = ?", [userId], (err, recruits) => {
    if (err) {
      console.error(`Error for ${userId}:`, err);
    } else {
      console.log(`\n--- User ${userId} ---`);
      console.log(`Total recruits: ${recruits.length}`);
      if (recruits.length > 0) {
        const regions = {};
        recruits.forEach(r => {
          regions[r.region] = (regions[r.region] || 0) + 1;
        });
        console.log(`Regions:`, regions);
        console.log(`Guild ID: ${recruits[0].guild_id}`);
        console.log(`Sample recruit:`, JSON.stringify(recruits[0], null, 2));
      }
    }
    
    completed++;
    if (completed === problemUsers.length) {
      db.close();
    }
  });
});
