const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DATABASE_PATH || './data/recruiter.db';

function prepareDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(DB_PATH);

  // Tables
  db.exec(`
  CREATE TABLE IF NOT EXISTS recruits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recruiter_id TEXT NOT NULL,
    recruited_id TEXT NOT NULL,
    region TEXT NOT NULL,
    ign TEXT,
    created_at INTEGER NOT NULL,
    valid INTEGER DEFAULT 1
  );

  CREATE UNIQUE INDEX IF NOT EXISTS uniq_recruit ON recruits(recruited_id);

  CREATE TABLE IF NOT EXISTS recruiters (
    id TEXT PRIMARY KEY,
    points INTEGER DEFAULT 0,
    warnings INTEGER DEFAULT 0,
    promoted INTEGER DEFAULT 0
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
    note TEXT
  );

  -- ensure dismissed column exists for older DBs
  

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
  `);

  // Ensure promoted column exists for older DBs
  try {
    db.exec("ALTER TABLE recruiters ADD COLUMN promoted INTEGER DEFAULT 0");
  } catch (e) {
    // likely column already exists, ignore
  }

  // Ensure dismissed column exists on flags for older DBs
  try {
    db.exec("ALTER TABLE flags ADD COLUMN dismissed INTEGER DEFAULT 0");
  } catch (e) {
    // likely column already exists, ignore
  }

  return db;
}

module.exports = prepareDb();