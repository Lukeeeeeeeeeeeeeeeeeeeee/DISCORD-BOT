const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
  applyMultiplier,
  getActiveMultiplier,
  resetMultipliers
} = require('../src/lib/economy');

describe('economy legacy multipliers compatibility', () => {
  test('reads/writes/resets multiplier rows when guild_id column is absent', async () => {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
      CREATE TABLE IF NOT EXISTS multipliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recruiter_id TEXT NOT NULL,
        value REAL NOT NULL,
        type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);

    await applyMultiplier(db, 'R1', 'm1.5_7d', { guildId: 'G1' });

    const active = await getActiveMultiplier(db, 'R1', { guildId: 'G1' });
    expect(active).toBeDefined();
    expect(active.value).toBeGreaterThan(1.0);

    await resetMultipliers(db, 'R1', { guildId: 'G1' });
    const after = await getActiveMultiplier(db, 'R1', { guildId: 'G1' });
    expect(after.value).toBe(1.0);

    await db.close();
  });
});
