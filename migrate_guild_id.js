require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(process.env.DATABASE_PATH || './data/recruiter.db');

const OLD_GUILD_ID = '1331020304763453522';
const NEW_GUILD_ID = '1412808625017065544';

console.log(`Migrating data from guild ${OLD_GUILD_ID} to ${NEW_GUILD_ID}...`);

db.serialize(() => {
  db.run('BEGIN TRANSACTION');

  // Update all tables with guild_id
  const tables = [
    'recruits',
    'recruiters',
    'leaderboards',
    'recruiter_warnings',
    'invites',
    'economy_transactions',
    'purchase_history',
    'activity_flags'
  ];

  let completed = 0;
  tables.forEach(table => {
    const sql = `UPDATE ${table} SET guild_id = ? WHERE guild_id = ?`;
    db.run(sql, [NEW_GUILD_ID, OLD_GUILD_ID], function(err) {
      if (err) {
        console.error(`Error updating ${table}:`, err.message);
      } else {
        console.log(`✓ Updated ${this.changes} rows in ${table}`);
      }
      completed++;
      if (completed === tables.length) {
        db.run('COMMIT', (err) => {
          if (err) {
            console.error('Commit failed:', err);
            db.run('ROLLBACK');
          } else {
            console.log('\n✅ Migration complete!');
            console.log('Verifying...');
            
            db.all("SELECT guild_id, COUNT(*) as count FROM recruits GROUP BY guild_id", (err, rows) => {
              console.log('Recruits by guild:', rows);
            });
            
            db.all("SELECT guild_id, COUNT(*) as count FROM recruiters GROUP BY guild_id", (err, rows) => {
              console.log('Recruiters by guild:', rows);
              db.close();
            });
          }
        });
      }
    });
  });
});
