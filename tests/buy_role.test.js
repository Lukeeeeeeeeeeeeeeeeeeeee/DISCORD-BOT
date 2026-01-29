jest.setTimeout(10000);
const path = require('path');
const fs = require('fs');

function makeInteraction(){
  const reply = jest.fn();
  const options = { getSubcommand: () => 'buy', getString: (_k) => 'vip-role' };
  const member = {
    id: 'RBUY',
    roles: { add: jest.fn().mockResolvedValue(true) }
  };
  const guild = { members: { fetch: jest.fn(async (_id)=> member) } };
  const interaction = { options, reply, user: { id: 'RBUY', tag: 'Buyer#0001' }, member: { permissions: { has: () => false } }, guild };
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
      CREATE TABLE IF NOT EXISTS recruiters ( id TEXT PRIMARY KEY, points INTEGER DEFAULT 0, warnings INTEGER DEFAULT 0, promoted INTEGER DEFAULT 0, channel_base INTEGER DEFAULT 4 );
      CREATE TABLE IF NOT EXISTS purchases ( id INTEGER PRIMARY KEY AUTOINCREMENT, recruiter_id TEXT NOT NULL, item TEXT NOT NULL, cost INTEGER NOT NULL, created_at INTEGER NOT NULL );
    `);
    await db.run('INSERT OR IGNORE INTO recruiters (id, points, warnings, promoted, channel_base) VALUES (?, ?, ?, ?, ?)', 'RBUY', 30, 0, 0, 4);
  });
  afterEach(async () => {
    try { await db.close(); } catch (e) { void e; }
    try { fs.unlinkSync(dbPath); } catch (e) { void e; }
  });

  test('buy vip-role deducts points and assigns role', async () => {
    const { interaction, member } = makeInteraction();
    const cmd = require('../src/commands/recruiter.js');
    await cmd.execute(interaction);
    expect(interaction.reply).toHaveBeenCalled();
    const rec = await require('../src/db_async').get('SELECT * FROM recruiters WHERE id = ?', 'RBUY');
    expect(rec.points).toBe(5); // 30 - 25
    expect(member.roles.add).toHaveBeenCalled();
  });
});
