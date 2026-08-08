const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');
const path = require('path');

const DUMP_PATH = path.join(__dirname, '..', 'data', 'dump-1786201628627.sql');

(async () => {
  console.log('🔧 Restoring missing recruits table...\n');
  
  const db = await open({
    filename: './data/recruiter.db',
    driver: sqlite3.Database
  });
  
  // Drop if exists and recreate
  await db.exec(`DROP TABLE IF EXISTS recruits`);
  
  await db.exec(`CREATE TABLE recruits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recruiter_id TEXT NOT NULL,
    recruited_id TEXT NOT NULL,
    region TEXT NOT NULL,
    ign TEXT,
    created_at INTEGER NOT NULL,
    valid INTEGER DEFAULT 1,
    points INTEGER DEFAULT 0,
    guild_id TEXT
  )`);
  
  console.log('✅ Created recruits table');
  
  // Now restore the data from the dump
  const dumpContent = fs.readFileSync(DUMP_PATH, 'utf8');
  const insertPattern = /INSERT INTO recruits \([^)]+\) VALUES \([^)]+\);/g;
  const inserts = dumpContent.match(insertPattern) || [];
  
  console.log(`📝 Found ${inserts.length} recruit records to restore`);
  
  for (const insert of inserts) {
    try {
      await db.exec(insert);
    } catch (err) {
      console.warn('⚠️  Failed to insert:', err.message);
    }
  }
  
  const count = await db.get('SELECT COUNT(*) as count FROM recruits');
  console.log(`✅ Restored ${count.count} recruits`);
  
  const integrity = await db.get('PRAGMA integrity_check');
  console.log('✅ Database integrity:', integrity.integrity_check);
  
  await db.close();
  console.log('\n✅ Recovery complete!');
})().catch(err => {
  console.error('❌ Failed:', err);
  process.exit(1);
});
