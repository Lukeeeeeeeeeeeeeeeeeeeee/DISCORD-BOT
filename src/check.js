require('dotenv').config();
const db = require('./db_async');

(async () => {
  console.log('DB path:', process.env.DATABASE_PATH || './data/recruiter.db');
  console.log('Tables:');

  const rows = await db.all("SELECT name FROM sqlite_master WHERE type='table'");
  console.log(rows.map(r=>r.name));
  console.log('Sample recruiters:', await db.all('SELECT * FROM recruiters LIMIT 5'));
  console.log('OK');
})();