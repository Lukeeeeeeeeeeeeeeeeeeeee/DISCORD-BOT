const fs = require('fs');
const path = require('path');
const os = require('os');

function parseArgs(argv) {
  const args = { dbPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db' && argv[i + 1]) {
      args.dbPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--db=')) {
      args.dbPath = arg.slice('--db='.length);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourcePath = args.dbPath || process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'recruiter.db');

  if (!fs.existsSync(sourcePath)) {
    console.error(`Migration dry-run failed: source DB not found at ${sourcePath}`);
    process.exit(1);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recruiter-migrate-'));
  const tempPath = path.join(tempDir, path.basename(sourcePath));
  fs.copyFileSync(sourcePath, tempPath);

  process.env.DATABASE_PATH = tempPath;
  process.env.DB_INTEGRITY_LOG_OK = 'true';

  let db;
  try {
    db = require('../src/db_async');
    const result = await db.checkIntegrity('migration-dry-run');
    const ok = result && result.ok !== false;
    console.log('Migration dry-run complete', { ok, dbPath: tempPath });
    await db.close();
    try {
      fs.rmSync(tempPath, { force: true });
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      void e;
    }
    process.exit(ok ? 0 : 2);
  } catch (err) {
    console.error('Migration dry-run failed', err);
    try {
      if (db && typeof db.close === 'function') await db.close();
    } catch (e) {
      void e;
    }
    try {
      fs.rmSync(tempPath, { force: true });
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      void e;
    }
    process.exit(1);
  }
}

main();
