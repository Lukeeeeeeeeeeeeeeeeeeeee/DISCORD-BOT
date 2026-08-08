jest.setTimeout(10000);
const path = require('path');
const fs = require('fs');

function makeInteraction() {
  const reply = jest.fn();
  const member = { permissions: { has: () => true } };
  return { reply, member };
}

describe('/status command', () => {
  let dbPath;
  beforeEach(() => {
    dbPath = path.join(require('os').tmpdir(), `recruiter-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.DATABASE_PATH = dbPath;
    delete require.cache[require.resolve('../src/db_async.js')];
    require('../src/db_async.js');
  });
  afterEach(async () => {
    try { await require('../src/db_async.js').close(); } catch (e) { void e; }
    try { delete require.cache[require.resolve('../src/db_async.js')]; } catch (e) { void e; }
    try { fs.unlinkSync(dbPath); } catch (e) { void e; }
    try { const bdir = path.join(path.dirname(dbPath),'backups'); fs.rmdirSync(bdir,{recursive:true}); } catch (e) { void e; }
  });

  test('returns status embed with counts and backup info', async () => {
    const { reply, member } = makeInteraction();
    const interaction = { reply, member };

    // create a backup file to check detection
    const backupsDir = path.join(path.dirname(process.env.DATABASE_PATH), 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const bfile = path.join(backupsDir, 'recruiter-test-backup.db');
    fs.writeFileSync(bfile, 'ok');

    const cmd = require('../src/commands/recruiting/status.js');
    await cmd.execute(interaction);

    expect(reply).toHaveBeenCalled();
    const arg = reply.mock.calls[0][0];
    expect(arg.embeds).toBeDefined();
    expect(arg.embeds[0].data.fields.find(f => f.name === 'Recruits')).toBeDefined();
    expect(arg.embeds[0].data.fields.find(f => f.name === 'Last Backup').value).toMatch(/recruiter-test-backup.db/);
  });
});
