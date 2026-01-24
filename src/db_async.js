const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DATABASE_PATH || './data/recruiter.db';

async function init() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  // Create schema if not exists
  await db.exec(`
  CREATE TABLE IF NOT EXISTS recruits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recruiter_id TEXT NOT NULL,
    recruited_id TEXT NOT NULL,
    region TEXT NOT NULL,
    ign TEXT,
    created_at INTEGER NOT NULL,
    valid INTEGER DEFAULT 1,
    points INTEGER DEFAULT 0
  );

  CREATE UNIQUE INDEX IF NOT EXISTS uniq_recruit ON recruits(recruited_id);

  CREATE TABLE IF NOT EXISTS recruiters (
    id TEXT PRIMARY KEY,
    points INTEGER DEFAULT 0,
    warnings INTEGER DEFAULT 0,
    promoted INTEGER DEFAULT 0,
    channel_base INTEGER DEFAULT 4
  );

  CREATE TABLE IF NOT EXISTS flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recruiter_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    dismissed INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recruiter_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expired_at INTEGER,
    note TEXT,
    revoked INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS multipliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recruiter_id TEXT NOT NULL,
    value REAL NOT NULL,
    type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recruiter_id TEXT NOT NULL,
    item TEXT NOT NULL,
    cost INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS leaderboard_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    region TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS weekly_calculations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recruiter_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    recruits7d INTEGER DEFAULT 0,
    activity_rate REAL DEFAULT 0,
    retention REAL DEFAULT 0,
    warnings INTEGER DEFAULT 0,
    previous_min_req INTEGER,
    calculated_min_req INTEGER NOT NULL,
    role_base INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS absences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recruiter_id TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    active INTEGER DEFAULT 1
  );
  `);

  try {
    await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_leaderboard_channel_region ON leaderboard_messages(channel_id, region)');
  } catch (e) {
    // ignore
  }

  // Add columns if missing (best-effort)
  try { await db.exec("ALTER TABLE recruiters ADD COLUMN promoted INTEGER DEFAULT 0"); } catch (e) {}
  try { await db.exec("ALTER TABLE recruiters ADD COLUMN channel_base INTEGER DEFAULT 4"); } catch (e) {}
  try { await db.exec("ALTER TABLE flags ADD COLUMN dismissed INTEGER DEFAULT 0"); } catch (e) {}
  try { await db.exec("ALTER TABLE recruits ADD COLUMN points INTEGER DEFAULT 0"); } catch (e) {}
  try { await db.exec("ALTER TABLE warnings ADD COLUMN expired_at INTEGER"); } catch (e) {}
  try { await db.exec("ALTER TABLE warnings ADD COLUMN revoked INTEGER DEFAULT 0"); } catch (e) {}
  try { await db.exec("CREATE TABLE IF NOT EXISTS multipliers (id INTEGER PRIMARY KEY AUTOINCREMENT, recruiter_id TEXT NOT NULL, value REAL NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)"); } catch (e) {}

  return db;
}

let dbPromise = init();

module.exports = {
  get: async (sql, ...params) => (await dbPromise).get(sql, ...params),
  all: async (sql, ...params) => (await dbPromise).all(sql, ...params),
  run: async (sql, ...params) => (await dbPromise).run(sql, ...params),
  exec: async (sql) => (await dbPromise).exec(sql),
  close: async () => { const d = await dbPromise; return d.close(); },
  // prepare returns object with async helpers to ease migration
  prepare: (sql) => ({
    get: async (...params) => (await dbPromise).get(sql, ...params),
    all: async (...params) => (await dbPromise).all(sql, ...params),
    run: async (...params) => (await dbPromise).run(sql, ...params),
  })
};
