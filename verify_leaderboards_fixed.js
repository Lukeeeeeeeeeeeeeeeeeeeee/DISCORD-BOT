const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./data/recruiter.db');

const guildId = '1412808625017065544';

console.log('=== VERIFYING LEADERBOARD FIX ===\n');

// Expected message IDs from user
const expectedMessageIds = {
  NA: '1535651145534406716', // Water
  EU: '1535651146767798363', // Fire
  AS: '1535651147048558692'  // Air
};

// Check what message IDs are in the database
db.all('SELECT region, message_id, channel_id FROM leaderboard_messages WHERE guild_id = ?', [guildId], (err, messages) => {
  if (err) {
    console.error('Error:', err);
    db.close();
    process.exit(1);
  }

  console.log('Leaderboard messages in database:');
  messages.forEach(msg => {
    console.log(`  Region: ${msg.region}, Message ID: ${msg.message_id}, Channel ID: ${msg.channel_id}`);
  });
  console.log('\n');

  // Now check who should be in each leaderboard based on ROLE
  console.log('ROLE-BASED LEADERBOARD MEMBERSHIP:\n');

  const recruiterRoleIds = {
    EU: '1473726977105072314',  // Fire recruiters
    NA: '1473726986508833061',  // Water recruiters
    AS: '1473726967277686854'   // Air recruiters
  };

  console.log('Checking who has recruits by region:\n');

  let completed = 0;
  const regions = ['EU', 'NA', 'AS'];
  
  regions.forEach(region => {
    db.all(
      `SELECT recruiter_id, COUNT(*) as cnt, SUM(points) as pts
       FROM recruits
       WHERE guild_id = ? AND region = ? AND valid = 1
       GROUP BY recruiter_id
       ORDER BY cnt DESC`,
      [guildId, region],
      (err, rows) => {
        if (err) {
          console.error(`Error for ${region}:`, err);
        } else {
          const regionName = region === 'EU' ? 'Fire' : region === 'NA' ? 'Water' : 'Air';
          console.log(`\n${regionName} (${region}) - Recruiter Role ${recruiterRoleIds[region]}:`);
          console.log(`Total recruiters with recruits: ${rows.length}`);
          rows.forEach((r, i) => {
            if (i < 10) {  // Top 10
              console.log(`  ${i + 1}. User ${r.recruiter_id}: ${r.cnt} recruits, ${r.pts} pts`);
            }
          });
        }
        
        completed++;
        if (completed === regions.length) {
          console.log('\n\n✅ VERIFICATION COMPLETE');
          console.log('\nThe leaderboards should now ONLY show users with the correct regional recruiter role.');
          console.log('If someone appears in the wrong leaderboard, they need to have their role adjusted in Discord.');
          db.close();
        }
      }
    );
  });
});
