const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

(async () => {
  const db = await open({
    filename: './data/recruiter.db',
    driver: sqlite3.Database
  });
  
  const tables = await db.all(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`);
  console.log('Tables in database:', tables.map(t => t.name).join(', '));
  
  // Check for recruits table specifically
  const recruitsTable = await db.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='recruits'`);
  if (recruitsTable) {
    console.log('\n✅ recruits table exists');
    console.log(recruitsTable.sql);
  } else {
    console.log('\n❌ recruits table MISSING');
  }
  
  await db.close();
})().catch(console.error);
