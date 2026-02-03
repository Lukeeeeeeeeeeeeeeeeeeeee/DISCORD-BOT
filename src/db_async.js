const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DATABASE_PATH || './data/recruiter.db';

async function init() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  // Reduce "database is locked" errors under concurrent access.
  try { await db.exec('PRAGMA journal_mode = WAL'); } catch (e) { void e; }
  try { await db.exec('PRAGMA synchronous = NORMAL'); } catch (e) { void e; }
  try { await db.exec('PRAGMA busy_timeout = 5000'); } catch (e) { void e; }

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
    week_start INTEGER,
    recruits7d INTEGER DEFAULT 0,
    activity_rate REAL DEFAULT 0,
    verify_rate REAL DEFAULT 0,
    retention REAL DEFAULT 0,
    warnings INTEGER DEFAULT 0,
    absent INTEGER DEFAULT 0,
    previous_min_req INTEGER,
    calculated_min_req INTEGER NOT NULL,
    role_base INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recruited_id TEXT NOT NULL,
    recruiter_id TEXT,
    verified_at INTEGER NOT NULL,
    verified_by TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS uniq_verification_recruited ON verifications(recruited_id);

  CREATE TABLE IF NOT EXISTS rookie_points (
    member_id TEXT PRIMARY KEY,
    points REAL NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rookie_chat_activity (
    member_id TEXT NOT NULL,
    week_start INTEGER NOT NULL,
    message_count INTEGER DEFAULT 0,
    awarded_chunks INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (member_id, week_start)
  );

  CREATE TABLE IF NOT EXISTS rookie_war_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    type TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trial_fast_track (
    recruiter_id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    recruit1_id TEXT,
    recruit2_id TEXT,
    recruit3_id TEXT,
    count INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL
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

  CREATE TABLE IF NOT EXISTS system_events (
    key TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analytics_daily_channels (
    day TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_count INTEGER DEFAULT 0,
    unique_speakers INTEGER DEFAULT 0,
    last_message_at INTEGER,
    PRIMARY KEY (day, guild_id, channel_id)
  );

  CREATE TABLE IF NOT EXISTS analytics_daily_channel_speakers (
    day TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (day, guild_id, channel_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS analytics_daily_guild (
    day TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    message_count INTEGER DEFAULT 0,
    unique_speakers INTEGER DEFAULT 0,
    joins INTEGER DEFAULT 0,
    leaves INTEGER DEFAULT 0,
    invites_created INTEGER DEFAULT 0,
    invites_used INTEGER DEFAULT 0,
    PRIMARY KEY (day, guild_id)
  );

  CREATE TABLE IF NOT EXISTS analytics_daily_guild_speakers (
    day TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (day, guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS analytics_user_activity (
    user_id TEXT PRIMARY KEY,
    last_message_at INTEGER,
    last_voice_at INTEGER,
    last_active_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS analytics_members (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at INTEGER,
    left_at INTEGER,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS analytics_voice_daily (
    day TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    minutes INTEGER DEFAULT 0,
    PRIMARY KEY (day, guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS analytics_user_daily_messages (
    day TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    message_count INTEGER DEFAULT 0,
    PRIMARY KEY (day, guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS analytics_command_usage (
    day TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    command_name TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    PRIMARY KEY (day, guild_id, command_name)
  );

  CREATE TABLE IF NOT EXISTS analytics_role_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    role_name TEXT,
    action TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  `);

  try {
    await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_leaderboard_channel_region ON leaderboard_messages(channel_id, region)');
  } catch (e) {
    void e;
  }
  try {
    await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_rookie_war_message ON rookie_war_logs(message_id)');
  } catch (e) {
    void e;
  }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_rookie_war_member_time ON rookie_war_logs(member_id, created_at)');
  } catch (e) {
    void e;
  }

  // Add columns if missing (best-effort)
  try { await db.exec("ALTER TABLE recruiters ADD COLUMN promoted INTEGER DEFAULT 0"); } catch (e) { void e; }
  try { await db.exec("ALTER TABLE recruiters ADD COLUMN channel_base INTEGER DEFAULT 4"); } catch (e) { void e; }
  try { await db.exec("ALTER TABLE flags ADD COLUMN dismissed INTEGER DEFAULT 0"); } catch (e) { void e; }
  try { await db.exec("ALTER TABLE recruits ADD COLUMN points INTEGER DEFAULT 0"); } catch (e) { void e; }
  try { await db.exec("ALTER TABLE warnings ADD COLUMN expired_at INTEGER"); } catch (e) { void e; }
  try { await db.exec("ALTER TABLE warnings ADD COLUMN revoked INTEGER DEFAULT 0"); } catch (e) { void e; }
  try { await db.exec("ALTER TABLE weekly_calculations ADD COLUMN week_start INTEGER"); } catch (e) { void e; }
  try { await db.exec("ALTER TABLE weekly_calculations ADD COLUMN absent INTEGER DEFAULT 0"); } catch (e) { void e; }
  try { await db.exec("ALTER TABLE weekly_calculations ADD COLUMN verify_rate REAL DEFAULT 0"); } catch (e) { void e; }
  try { await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_weekly_calc_recruiter_week ON weekly_calculations(recruiter_id, week_start)'); } catch (e) { void e; }
  try { await db.exec("CREATE TABLE IF NOT EXISTS multipliers (id INTEGER PRIMARY KEY AUTOINCREMENT, recruiter_id TEXT NOT NULL, value REAL NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)"); } catch (e) { void e; }

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
