const db = require('./src/db_async');
(async () => {
    try {
        const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table'");
        console.log('Tables:', tables.map(t => t.name).join(', '));
        const columns = await db.all("PRAGMA table_info(dm_queue)").catch(() => []);
        console.log('dm_queue columns:', columns.map(c => c.name).join(', '));
    } catch (e) {
        console.error(e);
    } finally {
        await db.close();
    }
})();
