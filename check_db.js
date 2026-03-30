const sqlite3 = require('sqlite3').verbose();
const dbPath = 'C:/discord-bot/data/recruiter.db'; // Use absolute path for Windows
const db = new sqlite3.Database(dbPath);

console.log('Checking dm_campaigns schema...');
db.all("PRAGMA table_info(dm_campaigns)", (err, rows) => {
    if (err) {
        console.error('Error reading dm_campaigns:', err);
    } else {
        console.log('dm_campaigns columns:', rows.map(r => r.name).join(', '));
    }

    console.log('\nChecking dm_worker_user_blocks schema...');
    db.all("PRAGMA table_info(dm_worker_user_blocks)", (err, rows) => {
        if (err) {
            console.error('Error reading dm_worker_user_blocks:', err);
        } else {
            console.log('dm_worker_user_blocks columns:', rows.map(r => r.name).join(', '));
        }
        db.close();
    });
});
