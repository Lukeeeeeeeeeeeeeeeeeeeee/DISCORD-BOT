jest.setTimeout(10000);
const path = require('path');
const fs = require('fs');

function makeInteraction() {
  const reply = jest.fn();
  const options = { getSubcommand: () => 'buy', getString: (_k) => 'vip-role' };
  const member = {
    id: 'RBUY',
    roles: { add: jest.fn().mockResolvedValue(true) }
  };
  const guild = {
    id: 'GLOBAL',
    members: {
      fetch: jest.fn(async (id) => {
        if (id === 'BotId') return { permissions: { has: () => true }, roles: { highest: { position: 100 } } };
        return member;
      }),
      me: { permissions: { has: () => true }, roles: { highest: { position: 100 } } }
    },
    roles: { cache: { get: jest.fn((id) => ({ id, position: 0 })) } }
  };
  const interaction = { options, reply, user: { id: 'RBUY', tag: 'Buyer#0001' }, member: { permissions: { has: () => false } }, guild, client: { user: { id: 'BotId' } } };
  return { interaction, member };
}

describe('buy role items', () => {
  let dbPath, db;
  beforeEach(async () => {
    dbPath = path.join(require('os').tmpdir(), `recruiter-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.DATABASE_PATH = dbPath;
    const sqlite3 = require('sqlite3');
    const { open } = require('sqlite');
    db = await open({ filename: dbPath, driver: sqlite3.Database });
    await db.exec(`
      CREATE TABLE IF NOT EXISTS recruiters ( guild_id TEXT NOT NULL, id TEXT NOT NULL, points INTEGER DEFAULT 0, warnings INTEGER DEFAULT 0, promoted INTEGER DEFAULT 0, channel_base INTEGER DEFAULT 4, PRIMARY KEY (guild_id, id) );
      CREATE TABLE IF NOT EXISTS purchases ( id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, recruiter_id TEXT NOT NULL, item TEXT NOT NULL, cost INTEGER NOT NULL, created_at INTEGER NOT NULL );
    `);
    await db.run('INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, ?, ?, ?, ?)', 'GLOBAL', 'RBUY', 30, 0, 0, 4);
  });
  afterEach(async () => {
    try { await require('../src/db_async').close(); } catch (e) { void e; }
    try { delete require.cache[require.resolve('../src/db_async.js')]; } catch (e) { void e; }
    try { await db.close(); } catch (e) { void e; }
    try { fs.unlinkSync(dbPath); } catch (e) { void e; }
  });

  test('buy vip-role deducts points and assigns role', async () => {
    const { interaction, member } = makeInteraction();
    const cmd = require('../src/commands/recruiting/recruiter.js');
    await cmd.execute(interaction);
    expect(interaction.reply).toHaveBeenCalled();
    const rec = await require('../src/db_async').get('SELECT * FROM recruiters WHERE id = ?', 'RBUY');
    expect(rec.points).toBe(15); // 30 - 15
    expect(member.roles.add).toHaveBeenCalled();
  });
});
