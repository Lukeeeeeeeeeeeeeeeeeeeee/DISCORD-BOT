require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(process.env.DATABASE_PATH || './data/recruiter.db');

db.all("SELECT DISTINCT guild_id FROM recruits", (err, rows) => {
  if (err) {
    console.error('Error:', err);
    process.exit(1);
  }
  console.log('Guild IDs in recruits table:', rows);
});

db.all("SELECT guild_id, COUNT(*) as count FROM recruits GROUP BY guild_id", (err, rows) => {
  if (err) {
    console.error('Error:', err);
    process.exit(1);
  }
  console.log('Recruit counts by guild:', rows);
});

db.all("SELECT guild_id, COUNT(*) as count FROM recruiters GROUP BY guild_id", (err, rows) => {
  if (err) {
    console.error('Error:', err);
    process.exit(1);
  }
  console.log('Recruiter counts by guild:', rows);
  db.close();
});
