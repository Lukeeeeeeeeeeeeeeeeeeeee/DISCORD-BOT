const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');

async function testAnalyticsFailure() {
    console.log('Running Diagnostic: Analytics Flush Memory Accumulation');
    const dbPath = './data/test_race.db';
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const db = await open({ filename: dbPath, driver: sqlite3.Database });
    await db.exec('PRAGMA journal_mode = WAL;');
    await db.exec('CREATE TABLE mock_analytics (id INTEGER PRIMARY KEY)');

    // Simulate a prolonged lock
    console.log('[+] Simulating exclusive lock on SQLite file');
    await db.exec('BEGIN EXCLUSIVE');

    let lockReleased = false;
    setTimeout(async () => {
        console.log('[+] Releasing exclusive lock');
        lockReleased = true;
        await db.exec('COMMIT');
    }, 2000);

    const start = Date.now();
    try {
        const writer = await open({ filename: dbPath, driver: sqlite3.Database });
        // Because of WAL mode, a reader wouldn't block, but write will. 
        // We set a very short busy_timeout to simulate extreme contention
        await writer.exec('PRAGMA busy_timeout = 500');
        console.log('[!] Attempting concurrent write...');
        await writer.exec('INSERT INTO mock_analytics (id) VALUES (1)');
        console.log('[-] Write succeeded (Unexpected)');
    } catch (err) {
        console.log(`[+] Write failed intentionally: ${err.message}`);
        console.log(`[+] Time blocked: ${Date.now() - start}ms`);
    }
}

testAnalyticsFailure().catch(console.error);
