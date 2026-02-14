const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { withTransaction } = require('../src/lib/transactions');

describe('withTransaction concurrency safety', () => {
  test('serializes concurrent transactions on a single DB handle', async () => {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
      CREATE TABLE IF NOT EXISTS counters (
        id INTEGER PRIMARY KEY,
        value INTEGER NOT NULL
      );
      INSERT INTO counters (id, value) VALUES (1, 0);
    `);

    const workers = Array.from({ length: 20 }, () => withTransaction(db, async (tx) => {
      const row = await tx.get('SELECT value FROM counters WHERE id = 1');
      const next = (row ? row.value : 0) + 1;
      // Force overlap pressure between jobs; queueing should still keep updates safe.
      await new Promise(resolve => setTimeout(resolve, 2));
      await tx.run('UPDATE counters SET value = ? WHERE id = 1', next);
    }));

    await Promise.all(workers);

    const finalRow = await db.get('SELECT value FROM counters WHERE id = 1');
    expect(finalRow.value).toBe(20);
    await db.close();
  });
});
