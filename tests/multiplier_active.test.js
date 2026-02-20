jest.setTimeout(10000);
const path = require('path');
const fs = require('fs');

function makeInteraction(sub = 'multiplier-active') {
  const reply = jest.fn();
  const options = { getSubcommand: () => sub, getUser: (_k) => null };
  const interaction = { options, reply, user: { id: 'R1', tag: 'Recruiter#0001' }, member: { permissions: { has: () => true } } };
  return { interaction, reply };
}

describe('multiplier-active admin', () => {
  let dbPath, db;
  beforeEach(async () => {
    dbPath = path.join(require('os').tmpdir(), `recruiter-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.DATABASE_PATH = dbPath;
    const sqlite3 = require('sqlite3');
    const { open } = require('sqlite');
    db = await open({ filename: dbPath, driver: sqlite3.Database });
    await db.exec(`
      CREATE TABLE IF NOT EXISTS multipliers ( id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, recruiter_id TEXT NOT NULL, value REAL NOT NULL, type TEXT, created_at INTEGER, expires_at INTEGER );
    `);
    // seed an active multiplier
    await db.run('INSERT INTO multipliers (guild_id, recruiter_id, value, type, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', 'GLOBAL', 'A', 1.75, 'm1.75_14d', Date.now(), Date.now() + (14 * 24 * 60 * 60 * 1000));
  });
  afterEach(async () => {
    try { await require('../src/db_async').close(); } catch (e) { void e; }
    try { delete require.cache[require.resolve('../src/db_async.js')]; } catch (e) { void e; }
    try { await db.close(); } catch (e) { void e; }
    try { fs.unlinkSync(dbPath); } catch (e) { void e; }
  });
  test('multiplier-active returns embed with list', async () => {
    const { interaction } = makeInteraction('multiplier-active');
    const cmd = require('../src/commands/recruiting/recruiter.js');
    await cmd.execute(interaction);
    expect(interaction.reply).toHaveBeenCalled();
    const arg = interaction.reply.mock.calls[0][0];
    expect(arg.embeds[0].data.title).toMatch(/Active Multipliers/);
  });
});
