const fs = require('fs/promises');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const DEFAULT_DB_PATH = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'recruiter.db'));
const DRILL_DIR = path.resolve(process.env.BACKUP_DRILL_DIR || path.join(__dirname, '..', 'data', 'drills'));

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function copyFileSafe(fromPath, toPath) {
  await ensureDir(path.dirname(toPath));
  await fs.copyFile(fromPath, toPath);
}

async function openDb(filePath) {
  return open({ filename: filePath, driver: sqlite3.Database });
}

async function tableCount(db, tableName) {
  try {
    const row = await db.get(`SELECT COUNT(*) AS c FROM ${tableName}`);
    return row && Number.isFinite(Number(row.c)) ? Number(row.c) : 0;
  } catch (e) {
    return 0;
  }
}

async function run() {
  const dbPath = DEFAULT_DB_PATH;
  const ts = Date.now();
  const runDir = path.join(DRILL_DIR, `backup-restore-${ts}`);
  const workingDbPath = path.join(runDir, 'working.db');
  const snapshotDbPath = path.join(runDir, 'snapshot.db');

  await ensureDir(runDir);
  await copyFileSafe(dbPath, workingDbPath);

  const beforeDb = await openDb(workingDbPath);
  const before = {
    recruits: await tableCount(beforeDb, 'recruits'),
    recruiters: await tableCount(beforeDb, 'recruiters'),
    warnings: await tableCount(beforeDb, 'warnings'),
    purchases: await tableCount(beforeDb, 'purchases')
  };
  await beforeDb.close();

  await copyFileSafe(workingDbPath, snapshotDbPath);

  const mutateDb = await openDb(workingDbPath);
  const probeKey = `backup_restore_drill_probe_${ts}`;
  const now = Date.now();
  await mutateDb.exec(`
    CREATE TABLE IF NOT EXISTS system_events (
      guild_id TEXT NOT NULL,
      key TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      PRIMARY KEY (guild_id, key)
    );
  `);
  await mutateDb.run(
    'INSERT OR REPLACE INTO system_events (guild_id, key, timestamp) VALUES (?, ?, ?)',
    'DRILL',
    probeKey,
    now
  );
  const probeBeforeRestore = await mutateDb.get(
    'SELECT key, timestamp FROM system_events WHERE guild_id = ? AND key = ?',
    'DRILL',
    probeKey
  );
  await mutateDb.close();

  if (!probeBeforeRestore || probeBeforeRestore.key !== probeKey) {
    throw new Error('Backup drill failed: mutation probe was not persisted in working copy.');
  }

  await copyFileSafe(snapshotDbPath, workingDbPath);

  const restoredDb = await openDb(workingDbPath);
  const probeAfterRestore = await restoredDb.get(
    'SELECT key FROM system_events WHERE guild_id = ? AND key = ?',
    'DRILL',
    probeKey
  );
  const after = {
    recruits: await tableCount(restoredDb, 'recruits'),
    recruiters: await tableCount(restoredDb, 'recruiters'),
    warnings: await tableCount(restoredDb, 'warnings'),
    purchases: await tableCount(restoredDb, 'purchases')
  };
  await restoredDb.close();

  if (probeAfterRestore) {
    throw new Error('Backup drill failed: restore did not revert probe mutation.');
  }

  const countsStable = (
    before.recruits === after.recruits
    && before.recruiters === after.recruiters
    && before.warnings === after.warnings
    && before.purchases === after.purchases
  );

  if (!countsStable) {
    throw new Error(
      `Backup drill failed: table counts changed after restore. before=${JSON.stringify(before)} after=${JSON.stringify(after)}`
    );
  }

  console.log('Backup restore drill completed successfully.');
  console.log(JSON.stringify({
    sourceDb: dbPath,
    runDir,
    before,
    after
  }, null, 2));
}

run().catch((error) => {
  console.error('Backup restore drill failed:', error);
  process.exit(1);
});

