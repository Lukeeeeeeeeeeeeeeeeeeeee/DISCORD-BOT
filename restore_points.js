require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(process.env.DATABASE_PATH || './data/recruiter.db');

// Based on the leaderboard at 14:41, restore these points:
const pointsToRestore = {
  // We need to find the user IDs for these members
  // Format: userId: points
};

// First, let's see all the recruiters and try to match them
console.log('Current recruiters:');
db.all("SELECT id, points FROM recruiters WHERE guild_id = '1412808625017065544'", (err, rows) => {
  if (err) {
    console.error('Error:', err);
    process.exit(1);
  }
  
  console.log('All recruiters in database:');
  rows.forEach(r => console.log(`  ${r.id}: ${r.points} points`));
  
  // Let's also check the recruits table to see who recruited who
  db.all("SELECT recruited_by_id, recruited_id, ign FROM recruits WHERE guild_id = '1412808625017065544'", (err2, recruits) => {
    if (err2) {
      console.error('Error:', err2);
      process.exit(1);
    }
    
    console.log('\nRecruit records:');
    recruits.forEach(r => console.log(`  ${r.recruited_by_id} recruited ${r.ign} (${r.recruited_id})`));
    
    console.log('\nBased on the leaderboard, I need to manually update these points:');
    console.log('EU | AvoidMyRevol: 6 pts');
    console.log('EU | Str1k3_C0re: 4 pts'); 
    console.log('EU | Centurion5866: 2 pts');
    console.log('EU | Hikaru: 2 pts');
    console.log('EU | pero0244421: 1 pt');
    console.log('\nPlease provide the Discord user IDs for these members so I can restore their points.');
    
    db.close();
  });
});