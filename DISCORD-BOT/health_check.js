const sqlite3 = require('sqlite3').verbose();
const dbPath = 'C:/discord-bot/data/recruiter.db';
const db = new sqlite3.Database(dbPath);

console.log('--- Fleet Operational Audit ---');
db.serialize(() => {
    // 1. Check Campaign Status
    db.all("SELECT status, count(*) as count FROM dm_campaigns GROUP BY status", (err, rows) => {
        console.log('Campaigns:', rows || err);
    });

    // 2. Check Target Counts by Status
    db.all("SELECT status, count(*) as count FROM dm_campaign_targets GROUP BY status", (err, rows) => {
        console.log('Targets:', rows || err);
    });

    // 3. Check Worker Claims
    db.all("SELECT assigned_worker_id, count(*) as count FROM dm_campaign_targets WHERE assigned_worker_id IS NOT NULL GROUP BY assigned_worker_id", (err, rows) => {
        console.log('Active Claims per Worker:', rows || err);
        db.close();
    });
});
