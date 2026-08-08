require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(process.env.DATABASE_PATH || './data/recruiter.db');

db.all("SELECT id, points, recruits, promoted FROM recruiters WHERE guild_id = '1412808625017065544' ORDER BY points DESC", (err, rows) => {
  if (err) {
    console.error('Error:', err);
    process.exit(1);
  }
  console.log('Current recruiter points:');
  rows.forEach(row => {
    console.log(`  ${row.id}: ${row.points} pts, ${row.recruits} recruits, promoted: ${row.promoted}`);
  });
  
  db.all("SELECT recruited_by_id, COUNT(*) as count FROM recruits WHERE guild_id = '1412808625017065544' AND valid = 1 GROUP BY recruited_by_id", (err2, counts) => {
    if (err2) {
      console.error('Error:', err2);
      process.exit(1);
    }
    console.log('\nActual recruit counts from recruits table:');
    counts.forEach(c => {
      console.log(`  ${c.recruited_by_id}: ${c.count} recruits`);
    });
    db.close();
  });
});
