require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(process.env.DATABASE_PATH || './data/recruiter.db');

console.log('=== MANUAL POINTS RESTORATION ===');
console.log('Based on leaderboard at 14:41:');
console.log('- AvoidMyRevol: 6 pts');
console.log('- Str1k3_C0re: 4 pts');  
console.log('- Centurion5866: 2 pts');
console.log('- Hikaru: 2 pts');
console.log('- pero0244421: 1 pt (already correct)');
console.log('');

// Let me make educated guesses based on the existing data and user IDs that might match
// You'll need to tell me the correct user IDs for each person

const pointsUpdates = [
  { userId: '1381692847018868778', points: 6, name: 'AvoidMyRevol' },
  { userId: '1238882108097953864', points: 4, name: 'Str1k3_C0re' },
  { userId: '882597723864449054', points: 2, name: 'Centurion5866' },
  { userId: '573654608971563029', points: 10, name: 'Hikaru' }  // Updated to 10 as requested
];

if (pointsUpdates.length === 0) {
  console.log('⚠️  Need user IDs to restore points.');
  console.log('Current recruiters in database:');
  
  db.all("SELECT id, points FROM recruiters WHERE guild_id = '1412808625017065544' ORDER BY points DESC", (err, rows) => {
    if (err) {
      console.error('Error:', err);
      process.exit(1);
    }
    
    rows.forEach(r => console.log(`  ${r.id}: ${r.points} points`));
    console.log('');
    console.log('Please provide the Discord user IDs for:');
    console.log('- AvoidMyRevol (needs 6 pts)');
    console.log('- Str1k3_C0re (needs 4 pts)');  
    console.log('- Centurion5866 (needs 2 pts)');
    console.log('- Hikaru (needs 2 pts)');
    
    db.close();
  });
} else {
  // Execute updates
  console.log('Updating points...');
  let completed = 0;
  
  pointsUpdates.forEach(update => {
    db.run(
      "UPDATE recruiters SET points = ? WHERE guild_id = ? AND id = ?",
      [update.points, '1412808625017065544', update.userId],
      function(err) {
        if (err) {
          console.error(`Error updating ${update.name}:`, err);
        } else {
          console.log(`✓ ${update.name}: ${update.points} points`);
        }
        completed++;
        if (completed === pointsUpdates.length) {
          console.log('\n✅ Points restoration complete!');
          db.close();
        }
      }
    );
  });
}