const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

describe('invite cooldowns persistence', () => {
  test('writes and reads invite cooldowns from DB', async () => {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
      CREATE TABLE IF NOT EXISTS invite_cooldowns (
        guild_id TEXT NOT NULL,
        recruiter_id TEXT NOT NULL,
        cooldown_until INTEGER NOT NULL,
        PRIMARY KEY (guild_id, recruiter_id)
      );
    `);
    const repo = require('../src/repos/invite-cooldowns-repo');
    const now = Date.now();
    await repo.upsertCooldown(db, 'G1', 'U1', now + 1000);
    const row = await repo.getCooldown(db, 'G1', 'U1');
    expect(row).toBeDefined();
    expect(row.cooldown_until).toBeGreaterThan(now);
    await repo.cleanupExpired(db, { guildId: 'G1', now: now + 2000 });
    const cleared = await repo.getCooldown(db, 'G1', 'U1');
    expect(cleared).toBeUndefined();
    await db.close();
  });

  test('cleanupExpired does not perform global delete unless explicitly allowed', async () => {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
      CREATE TABLE IF NOT EXISTS invite_cooldowns (
        guild_id TEXT NOT NULL,
        recruiter_id TEXT NOT NULL,
        cooldown_until INTEGER NOT NULL,
        PRIMARY KEY (guild_id, recruiter_id)
      );
    `);
    const repo = require('../src/repos/invite-cooldowns-repo');
    const now = Date.now();

    await repo.upsertCooldown(db, 'G1', 'U1', now - 1000);
    await repo.upsertCooldown(db, 'G2', 'U2', now - 1000);

    await repo.cleanupExpired(db, { now });
    const stillG1 = await repo.getCooldown(db, 'G1', 'U1');
    const stillG2 = await repo.getCooldown(db, 'G2', 'U2');
    expect(stillG1).toBeDefined();
    expect(stillG2).toBeDefined();

    await repo.cleanupExpired(db, { now, allowGlobal: true });
    const clearedG1 = await repo.getCooldown(db, 'G1', 'U1');
    const clearedG2 = await repo.getCooldown(db, 'G2', 'U2');
    expect(clearedG1).toBeUndefined();
    expect(clearedG2).toBeUndefined();

    await db.close();
  });
});
