require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(process.env.DATABASE_PATH || './data/recruiter.db');

db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", (err, rows) => {
  if (err) {
    console.error('Error:', err);
    process.exit(1);
  }
  console.log('Tables in database:');
  rows.forEach(row => console.log(`  - ${row.name}`));
  
  // Now update all remaining tables
  const tables = rows.map(r => r.name).filter(n => !n.startsWith('sqlite_'));
  
  const OLD_GUILD_ID = '1331020304763453522';
  const NEW_GUILD_ID = '1412808625017065544';
  
  console.log('\nUpdating remaining tables...');
  
  let completed = 0;
  tables.forEach(table => {
    // Check if table has guild_id column
    db.all(`PRAGMA table_info(${table})`, (err, cols) => {
      if (err) {
        console.error(`Error getting info for ${table}:`, err);
        completed++;
        return;
      }
      
      const hasGuildId = cols.some(col => col.name === 'guild_id');
      if (hasGuildId) {
        db.run(`UPDATE ${table} SET guild_id = ? WHERE guild_id = ?`, [NEW_GUILD_ID, OLD_GUILD_ID], function(err) {
          if (err) {
            console.error(`Error updating ${table}:`, err.message);
          } else if (this.changes > 0) {
            console.log(`✓ Updated ${this.changes} rows in ${table}`);
          }
          completed++;
          if (completed === tables.length) db.close();
        });
      } else {
        completed++;
        if (completed === tables.length) db.close();
      }
    });
  });
});
