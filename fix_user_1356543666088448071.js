const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./data/recruiter.db');

const userId = '1356543666088448071';
const guildId = '1412808625017065544';

console.log('=== FIXING USER', userId, '===\n');

// First, show current state
db.all("SELECT * FROM recruits WHERE recruiter_id = ?", [userId], (err, before) => {
  if (err) {
    console.error('Error:', err);
    db.close();
    process.exit(1);
  }

  console.log('BEFORE:');
  console.log(`User ${userId} has ${before.length} recruits`);
  before.forEach(r => console.log(`  - ID ${r.id}: Region ${r.region}, Points ${r.points}, Created ${new Date(r.created_at).toISOString()}`));
  console.log('\n');

  // Delete ALL recruits for this user
  db.run("DELETE FROM recruits WHERE recruiter_id = ?", [userId], function(err) {
    if (err) {
      console.error('Delete error:', err);
      db.close();
      process.exit(1);
    }

    console.log(`Deleted ${this.changes} recruit(s)`);
    console.log('\n');

    // Insert exactly 1 recruit in Air/AS region
    const newRecruit = {
      recruiter_id: userId,
      recruited_id: `CORRECTED_${userId}_${Date.now()}_${Math.random()}`,
      region: 'AS',
      ign: 'Corrected_Entry',
      created_at: Date.now(),
      valid: 1,
      points: 1,
      guild_id: guildId
    };

    db.run(
      `INSERT INTO recruits (recruiter_id, recruited_id, region, ign, created_at, valid, points, guild_id) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [newRecruit.recruiter_id, newRecruit.recruited_id, newRecruit.region, newRecruit.ign, 
       newRecruit.created_at, newRecruit.valid, newRecruit.points, newRecruit.guild_id],
      function(err) {
        if (err) {
          console.error('Insert error:', err);
          db.close();
          process.exit(1);
        }

        console.log(`Inserted new recruit with ID ${this.lastID}`);
        console.log('\n');

        // Show final state
        db.all("SELECT * FROM recruits WHERE recruiter_id = ?", [userId], (err, after) => {
          if (err) {
            console.error('Final check error:', err);
            db.close();
            process.exit(1);
          }

          console.log('AFTER:');
          console.log(`User ${userId} now has ${after.length} recruits`);
          after.forEach(r => console.log(`  - ID ${r.id}: Region ${r.region}, Points ${r.points}, Created ${new Date(r.created_at).toISOString()}`));
          
          console.log('\n✅ FIX COMPLETE');
          console.log(`User ${userId} now has exactly 1 recruit in Air/AS region`);
          
          db.close();
        });
      }
    );
  });
});
