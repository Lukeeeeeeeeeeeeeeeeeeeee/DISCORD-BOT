const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { acquireJobLock } = require('../src/lib/job-locks');

describe('job-locks', () => {
  let db;

  beforeEach(async () => {
    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
      CREATE TABLE IF NOT EXISTS system_events (
        guild_id TEXT NOT NULL,
        key TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        PRIMARY KEY (guild_id, key)
      );
    `);
  });

  afterEach(async () => {
    if (db) {
      await db.close();
    }
  });

  test('acquireJobLock respects ttl', async () => {
    const ttlMs = 10_000;
    const guildId = 'g1';
    const key = 'job1';

    const first = await acquireJobLock(db, { guildId, key, ttlMs });
    expect(first).toBe(true);

    const second = await acquireJobLock(db, { guildId, key, ttlMs });
    expect(second).toBe(false);

    await db.run(
      'UPDATE system_events SET timestamp = ? WHERE guild_id = ? AND key = ?',
      Date.now() - (ttlMs * 2),
      guildId,
      key
    );

    const third = await acquireJobLock(db, { guildId, key, ttlMs });
    expect(third).toBe(true);
  });

  test('defaults to fail-closed when lock storage errors', async () => {
    const failingDb = {
      run: jest.fn(async () => { throw new Error('database is locked'); }),
      get: jest.fn(async () => null)
    };
    const locked = await acquireJobLock(failingDb, {
      guildId: 'g1',
      key: 'job-fail',
      ttlMs: 10_000
    });
    expect(locked).toBe(false);
  });

  test('can fail-open explicitly when requested', async () => {
    const failingDb = {
      run: jest.fn(async () => { throw new Error('database is locked'); }),
      get: jest.fn(async () => null)
    };
    const locked = await acquireJobLock(failingDb, {
      guildId: 'g1',
      key: 'job-fail-open',
      ttlMs: 10_000,
      failOpen: true
    });
    expect(locked).toBe(true);
  });
});
