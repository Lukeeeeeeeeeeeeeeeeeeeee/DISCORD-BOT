const Database = require('better-sqlite3');
const db = new Database('./data/recruiter.db');

console.log('=== BEFORE CHANGES ===');
console.log('\nFire leaderboard (1535651146767798363):');
const fireBefore = db.prepare('SELECT user_id, recruit_count, points FROM leaderboards WHERE guild_id = ? ORDER BY points DESC').all('1535651146767798363');
fireBefore.forEach(row => console.log(`User: ${row.user_id}, Recruits: ${row.recruit_count}, Points: ${row.points}`));

console.log('\nAir leaderboard (1535651147048558692):');
const airBefore = db.prepare('SELECT user_id, recruit_count, points FROM leaderboards WHERE guild_id = ? ORDER BY points DESC').all('1535651147048558692');
airBefore.forEach(row => console.log(`User: ${row.user_id}, Recruits: ${row.recruit_count}, Points: ${row.points}`));

// 1. Remove user 1356543666088448071 from Fire leaderboard
console.log('\n=== REMOVING USER 1356543666088448071 FROM FIRE ===');
const removeResult = db.prepare('DELETE FROM leaderboards WHERE guild_id = ? AND user_id = ?').run('1535651146767798363', '1356543666088448071');
console.log(`Deleted ${removeResult.changes} row(s)`);

// 2. Add or update user in Air leaderboard with 1 recruit
console.log('\n=== ADDING/UPDATING USER IN AIR WITH 1 RECRUIT ===');
const existing = db.prepare('SELECT * FROM leaderboards WHERE guild_id = ? AND user_id = ?').get('1535651147048558692', '1356543666088448071');

if (existing) {
  const updateResult = db.prepare('UPDATE leaderboards SET recruit_count = 1, points = 1 WHERE guild_id = ? AND user_id = ?').run('1535651147048558692', '1356543666088448071');
  console.log(`Updated existing entry: ${updateResult.changes} row(s)`);
} else {
  const insertResult = db.prepare('INSERT INTO leaderboards (guild_id, user_id, recruit_count, points) VALUES (?, ?, 1, 1)').run('1535651147048558692', '1356543666088448071');
  console.log(`Inserted new entry: ${insertResult.changes} row(s)`);
}

// 3. Check for the problematic user IDs and remove them
console.log('\n=== CHECKING FOR PROBLEMATIC ENTRIES ===');
const problematic1 = db.prepare('SELECT * FROM leaderboards WHERE user_id = ?').all('1050044494736150579');
const problematic2 = db.prepare('SELECT * FROM leaderboards WHERE user_id = ?').all('1141653573959299102');

if (problematic1.length > 0) {
  console.log('Found problematic user 1050044494736150579:', problematic1);
  const del1 = db.prepare('DELETE FROM leaderboards WHERE user_id = ?').run('1050044494736150579');
  console.log(`Removed ${del1.changes} entry/entries`);
}

if (problematic2.length > 0) {
  console.log('Found problematic user 1141653573959299102:', problematic2);
  const del2 = db.prepare('DELETE FROM leaderboards WHERE user_id = ?').run('1141653573959299102');
  console.log(`Removed ${del2.changes} entry/entries`);
}

console.log('\n=== AFTER CHANGES ===');
console.log('\nFire leaderboard (1535651146767798363):');
const fireAfter = db.prepare('SELECT user_id, recruit_count, points FROM leaderboards WHERE guild_id = ? ORDER BY points DESC').all('1535651146767798363');
fireAfter.forEach(row => console.log(`User: ${row.user_id}, Recruits: ${row.recruit_count}, Points: ${row.points}`));

console.log('\nAir leaderboard (1535651147048558692):');
const airAfter = db.prepare('SELECT user_id, recruit_count, points FROM leaderboards WHERE guild_id = ? ORDER BY points DESC').all('1535651147048558692');
airAfter.forEach(row => console.log(`User: ${row.user_id}, Recruits: ${row.recruit_count}, Points: ${row.points}`));

db.close();
console.log('\n✅ Database changes completed');
