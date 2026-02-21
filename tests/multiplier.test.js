jest.setTimeout(10000);
const path = require('path');
const fs = require('fs');

function makeTempDbPath() {
  const tmp = require('os').tmpdir();
  return path.join(tmp, `recruiter-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

async function makeDb(dbPath) {
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS recruiters ( guild_id TEXT NOT NULL, id TEXT NOT NULL, points INTEGER DEFAULT 0, warnings INTEGER DEFAULT 0, promoted INTEGER DEFAULT 0, channel_base INTEGER DEFAULT 4, PRIMARY KEY (guild_id, id) );
    CREATE TABLE IF NOT EXISTS multipliers ( id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, recruiter_id TEXT NOT NULL, value REAL NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL );
    CREATE TABLE IF NOT EXISTS purchases ( id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, recruiter_id TEXT NOT NULL, item TEXT NOT NULL, cost INTEGER NOT NULL, created_at INTEGER NOT NULL );
  `);
  return db;
}

describe('multiplier purchase and admin application', () => {
  let dbPath;
  beforeEach(() => {
    jest.resetModules();
    dbPath = makeTempDbPath();
    process.env.DATABASE_PATH = dbPath;
  });
  afterEach(async () => {
    try { await require('../src/db_async').close(); } catch (e) { void e; }
    try { fs.unlinkSync(dbPath); } catch (e) { void e; }
  });

  test('recruiter can buy a multiplier when they have enough points', async () => {
    // prepare DB
    const db = await makeDb(dbPath);
    await db.run('INSERT INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, ?, 0, 0, 4)', 'GLOBAL', 'R1', 50);

    // mock interaction for buy
    const reply = jest.fn();
    const options = {
      getSubcommand: () => 'buy',
      getString: (_k) => 'm1.5_14d'
    };
    const interaction = { options, user: { id: 'R1' }, reply, member: { permissions: { has: () => true } }, guild: { id: 'GLOBAL' } };

    // execute
    const cmd = require('../src/commands/recruiting/recruiter.js');
    await cmd.execute(interaction);

    const row = await db.get('SELECT * FROM multipliers WHERE recruiter_id = ?', 'R1');
    expect(row).toBeDefined();
    expect(row.type).toBe('m1.5_14d');

    const rec = await db.get('SELECT * FROM recruiters WHERE id = ?', 'R1');
    expect(rec.points).toBe(44); // cost 6

    await db.close();
  });

  test('econ.applyMultiplier works directly on DB', async () => {
    const db = await makeDb(dbPath);
    await db.run('INSERT INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, ?, 0, 0, 4)', 'GLOBAL', 'R2', 0);
    const econ = require('../src/lib/economy');
    await econ.applyMultiplier(db, 'R2', 'm1.5_7d');
    const row = await db.get('SELECT * FROM multipliers WHERE recruiter_id = ?', 'R2');
    expect(row).toBeDefined();
    expect(row.type).toBe('m1.5_7d');
    await db.close();
  });

  test('admin can apply and reset multipliers', async () => {
    const db = await makeDb(dbPath);
    await db.run('INSERT INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, ?, 0, 0, 4)', 'GLOBAL', 'R2', 0);

    const reply = jest.fn();
    const optionsApply = {
      getSubcommand: () => 'multiplier-apply',
      getUser: () => ({ id: 'R2', tag: 'User#0002' }),
      getString: (_k) => 'm1.5_7d'
    };

    const interactionApply = { options: optionsApply, user: { id: 'Admin' }, member: { permissions: { has: () => true } }, guild: { channels: { cache: new Map() } }, reply };
    const cmd = require('../src/commands/recruiting/recruiter.js');
    await cmd.execute(interactionApply);
    // Use a fresh DB connection to ensure visibility across connections
    const sqlite3 = require('sqlite3');
    const { open } = require('sqlite');
    const checkDb = await open({ filename: process.env.DATABASE_PATH, driver: sqlite3.Database });
    let row = await checkDb.get('SELECT * FROM multipliers WHERE recruiter_id = ?', 'R2');
    expect(row).toBeDefined();
    expect(row.type).toBe('m1.5_7d');
    await checkDb.close();

    // reset
    const optionsReset = { getSubcommand: () => 'multiplier-reset', getUser: () => ({ id: 'R2', tag: 'User#0002' }) };
    const interactionReset = { options: optionsReset, user: { id: 'Admin' }, member: { permissions: { has: () => true } }, guild: { channels: { cache: new Map() } }, reply };
    await cmd.execute(interactionReset);
    row = await db.get('SELECT * FROM multipliers WHERE recruiter_id = ?', 'R2');
    expect(row).toBeUndefined();

    await db.close();
  });

  test('recruiter cannot buy the same multiplier while it is active', async () => {
    const db = await makeDb(dbPath);
    await db.run(
      'INSERT INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, ?, 0, 0, 4)',
      'GLOBAL',
      'R1',
      50
    );

    const reply = jest.fn();
    const options = {
      getSubcommand: () => 'buy',
      getString: (_k) => 'm1.5_7d'
    };
    const interaction = {
      options,
      user: { id: 'R1' },
      reply,
      member: { permissions: { has: () => true } },
      guild: { id: 'GLOBAL' }
    };

    const cmd = require('../src/commands/recruiting/recruiter.js');
    await cmd.execute(interaction);
    await cmd.execute(interaction);

    const multiplierRows = await db.all('SELECT * FROM multipliers WHERE guild_id = ? AND recruiter_id = ?', 'GLOBAL', 'R1');
    expect(multiplierRows.length).toBe(1);

    const purchaseRows = await db.all('SELECT * FROM purchases WHERE guild_id = ? AND recruiter_id = ?', 'GLOBAL', 'R1');
    expect(purchaseRows.length).toBe(1);

    const rec = await db.get('SELECT * FROM recruiters WHERE guild_id = ? AND id = ?', 'GLOBAL', 'R1');
    expect(rec.points).toBe(48);

    expect(reply).toHaveBeenCalledTimes(2);
    const secondReply = reply.mock.calls[1][0];
    expect(secondReply.embeds[0].data.description).toContain('already active');

    await db.close();
  });

  test('admin can create an event multiplier with custom expiry and cost', async () => {
    const db = await makeDb(dbPath);
    await db.run('INSERT INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, ?, 0, 0, 4)', 'GLOBAL', 'R3', 20);
    await db.close();

    const reply = jest.fn();
    const optionsEvent = {
      getSubcommand: () => 'multiplier-event',
      getUser: (key) => (key === 'member' ? { id: 'R3', tag: 'User#0003' } : null),
      getNumber: (key) => {
        if (key === 'value') return 1.75;
        if (key === 'cost') return 6;
        return null;
      },
      getInteger: (key) => (key === 'duration_days' ? 14 : null),
      getString: (key) => (key === 'label' ? 'summer_event' : null)
    };
    const interactionEvent = {
      options: optionsEvent,
      user: { id: 'Admin' },
      member: { permissions: { has: () => true } },
      guild: { id: 'GLOBAL', channels: { cache: new Map() } },
      reply
    };

    const cmd = require('../src/commands/recruiting/recruiter.js');
    await cmd.execute(interactionEvent);

    const sqlite3 = require('sqlite3');
    const { open } = require('sqlite');
    const checkDb = await open({ filename: process.env.DATABASE_PATH, driver: sqlite3.Database });
    const multiplierRow = await checkDb.get('SELECT * FROM multipliers WHERE recruiter_id = ? ORDER BY id DESC LIMIT 1', 'R3');
    expect(multiplierRow).toBeDefined();
    expect(multiplierRow.value).toBeCloseTo(1.75, 5);
    expect(multiplierRow.type).toBe('event_summer_event');

    const rec = await checkDb.get('SELECT * FROM recruiters WHERE guild_id = ? AND id = ?', 'GLOBAL', 'R3');
    expect(rec.points).toBe(14);

    const purchase = await checkDb.get('SELECT * FROM purchases WHERE guild_id = ? AND recruiter_id = ? ORDER BY id DESC LIMIT 1', 'GLOBAL', 'R3');
    expect(purchase).toBeDefined();
    expect(purchase.cost).toBe(6);
    expect(String(purchase.item)).toContain('event:event_summer_event');

    await checkDb.close();
  });
});
