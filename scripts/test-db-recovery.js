const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

(async () => {
  const db = await open({
    filename: './data/recruiter.db',
    driver: sqlite3.Database
  });
  
  const check = await db.get('PRAGMA integrity_check');
  console.log('✅ Database integrity:', check.integrity_check);
  
  const tables = await db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`);
  console.log('✅ Tables found:', tables.length);
  
  const recruits = await db.get('SELECT COUNT(*) as count FROM recruits');
  console.log('✅ Recruits:', recruits.count);
  
  const recruiters = await db.get('SELECT COUNT(*) as count FROM recruiters');
  console.log('✅ Recruiters:', recruiters.count);
  
  const rookiePoints = await db.get('SELECT COUNT(*) as count FROM rookie_points');
  console.log('✅ Rookie points:', rookiePoints.count);
  
  await db.close();
  console.log('\n✅ Database is healthy!');
})().catch(err => {
  console.error('❌ Database test failed:', err);
  process.exit(1);
});
