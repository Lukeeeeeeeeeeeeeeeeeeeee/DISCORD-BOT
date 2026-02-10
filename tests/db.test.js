const fs = require('fs');
const path = require('path');

test('db is created at DATABASE_PATH when required', () => {
  const tmpDir = require('os').tmpdir();
  const dbPath = path.join(tmpDir, `recruiter-test-${Date.now()}.db`);
  process.env.DATABASE_PATH = dbPath;

  // Clear cached module so it re-initializes with our env var
  delete require.cache[require.resolve('../src/db_async.js')];
  const db = require('../src/db_async.js');

  expect(fs.existsSync(dbPath)).toBe(true);

  // Clean up
  try {
    if (db && typeof db.close === 'function') db.close();
  } catch (e) { void e; }
  try { fs.unlinkSync(dbPath); } catch (e) { void e; }
});
