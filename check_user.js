const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./data/recruiter.db');

const userId = '1356543666088448071';

console.log('=== CHECKING USER', userId, '===\n');

// Check schema
db.all("SELECT sql FROM sqlite_master WHERE type='table' AND name='recruits'", (err, schema) => {
  if (err) {
    console.error('Schema error:', err);
    db.close();
    process.exit(1);
  }
  console.log('RECRUITS TABLE SCHEMA:');
  console.log(schema[0]?.sql || 'No schema found');
  console.log('\n');

  // Check all recruits by this user
  db.all("SELECT * FROM recruits WHERE recruiter_id = ?", [userId], (err, recruits) => {
    if (err) {
      console.error('Query error:', err);
      db.close();
      process.exit(1);
    }
    
    console.log(`Found ${recruits.length} recruits by user ${userId}:`);
    console.log(JSON.stringify(recruits, null, 2));
    console.log('\n');

    // Check guild_id
    if (recruits.length > 0) {
      const guildId = recruits[0].guild_id;
      console.log(`Guild ID: ${guildId}`);
      console.log(`Region distribution:`);
      const regions = {};
      recruits.forEach(r => {
        regions[r.region] = (regions[r.region] || 0) + 1;
      });
      console.log(regions);
    }

    db.close();
  });
});
