require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(process.env.DATABASE_PATH || './data/recruiter.db');

db.all("PRAGMA table_info(recruits)", (err, columns) => {
  if (err) {
    console.error('Error:', err);
    process.exit(1);
  }
  console.log('Recruits table schema:');
  columns.forEach(col => {
    console.log(`  ${col.name}: ${col.type}`);
  });
  
  db.all("SELECT * FROM recruits WHERE guild_id = '1412808625017065544' LIMIT 3", (err2, rows) => {
    if (err2) {
      console.error('Error:', err2);
      process.exit(1);
    }
    console.log('\nSample recruits:');
    console.log(rows);
    db.close();
  });
});