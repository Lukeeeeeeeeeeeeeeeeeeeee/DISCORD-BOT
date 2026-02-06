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
  try { await db.exec('PRAGMA foreign_keys = ON'); } catch (e) { void e; }
  const disableWal = (process.env.SQLITE_DISABLE_WAL || '').toLowerCase() === 'true';
  const journalModeRaw = (process.env.SQLITE_JOURNAL_MODE || 'WAL').toUpperCase();
  const allowedModes = new Set(['WAL', 'DELETE', 'TRUNCATE', 'PERSIST', 'MEMORY', 'OFF']);
  if (!disableWal) {
    if (allowedModes.has(journalModeRaw)) {
      try { await db.exec(`PRAGMA journal_mode = ${journalModeRaw}`); } catch (e) { void e; }
    } else {
      console.warn(`Invalid SQLITE_JOURNAL_MODE "${journalModeRaw}" - skipping journal_mode PRAGMA.`);
    }
  }
  try { await db.exec('PRAGMA synchronous = NORMAL'); } catch (e) { void e; }
  try { await db.exec('PRAGMA busy_timeout = 5000'); } catch (e) { void e; }

  // Create schema if not exists
  await db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );

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
    day_ts INTEGER,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_count INTEGER DEFAULT 0,
    unique_speakers INTEGER DEFAULT 0,
    last_message_at INTEGER,
    PRIMARY KEY (day, guild_id, channel_id)
  );

  CREATE TABLE IF NOT EXISTS analytics_daily_channel_speakers (
    day TEXT NOT NULL,
    day_ts INTEGER,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (day, guild_id, channel_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS analytics_daily_guild (
    day TEXT NOT NULL,
    day_ts INTEGER,
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
    day_ts INTEGER,
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
    day_ts INTEGER,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    minutes INTEGER DEFAULT 0,
    PRIMARY KEY (day, guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS analytics_user_daily_messages (
    day TEXT NOT NULL,
    day_ts INTEGER,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    message_count INTEGER DEFAULT 0,
    PRIMARY KEY (day, guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS analytics_command_usage (
    day TEXT NOT NULL,
    day_ts INTEGER,
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

  const applyMigration = async (id, fn) => {
    try {
      const existing = await db.get('SELECT id FROM schema_migrations WHERE id = ?', id);
      if (existing) return;
      await db.exec('BEGIN');
      try {
        await fn();
        await db.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', id, Date.now());
        await db.exec('COMMIT');
      } catch (err) {
        await db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      console.error('Schema migration failed', { id, error: err });
    }
  };

  await applyMigration('2026-02-06-recruiter-triggers', async () => {
    await db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_recruits_recruiter_row
      AFTER INSERT ON recruits
      BEGIN
        INSERT OR IGNORE INTO recruiters (id, points, warnings, promoted, channel_base)
        VALUES (NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_warnings_recruiter_row
      AFTER INSERT ON warnings
      BEGIN
        INSERT OR IGNORE INTO recruiters (id, points, warnings, promoted, channel_base)
        VALUES (NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_flags_recruiter_row
      AFTER INSERT ON flags
      BEGIN
        INSERT OR IGNORE INTO recruiters (id, points, warnings, promoted, channel_base)
        VALUES (NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_multipliers_recruiter_row
      AFTER INSERT ON multipliers
      BEGIN
        INSERT OR IGNORE INTO recruiters (id, points, warnings, promoted, channel_base)
        VALUES (NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_purchases_recruiter_row
      AFTER INSERT ON purchases
      BEGIN
        INSERT OR IGNORE INTO recruiters (id, points, warnings, promoted, channel_base)
        VALUES (NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_absences_recruiter_row
      AFTER INSERT ON absences
      BEGIN
        INSERT OR IGNORE INTO recruiters (id, points, warnings, promoted, channel_base)
        VALUES (NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_weekly_calc_recruiter_row
      AFTER INSERT ON weekly_calculations
      BEGIN
        INSERT OR IGNORE INTO recruiters (id, points, warnings, promoted, channel_base)
        VALUES (NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_trial_fast_track_recruiter_row
      AFTER INSERT ON trial_fast_track
      BEGIN
        INSERT OR IGNORE INTO recruiters (id, points, warnings, promoted, channel_base)
        VALUES (NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_verifications_recruiter_row
      AFTER INSERT ON verifications
      WHEN NEW.recruiter_id IS NOT NULL
      BEGIN
        INSERT OR IGNORE INTO recruiters (id, points, warnings, promoted, channel_base)
        VALUES (NEW.recruiter_id, 0, 0, 0, 4);
      END;
    `);
  });

  await applyMigration('2026-02-06-analytics-speaker-triggers', async () => {
    await db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_analytics_channel_speaker_insert
      AFTER INSERT ON analytics_daily_channel_speakers
      BEGIN
        UPDATE analytics_daily_channels
        SET unique_speakers = unique_speakers + 1
        WHERE day = NEW.day AND guild_id = NEW.guild_id AND channel_id = NEW.channel_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_analytics_guild_speaker_insert
      AFTER INSERT ON analytics_daily_guild_speakers
      BEGIN
        UPDATE analytics_daily_guild
        SET unique_speakers = unique_speakers + 1
        WHERE day = NEW.day AND guild_id = NEW.guild_id;
      END;
    `);
  });

  await applyMigration('2026-02-06-analytics-day-ts', async () => {
    const alter = async (sql) => {
      try {
        await db.exec(sql);
      } catch (e) {
        void e;
      }
    };

    await alter('ALTER TABLE analytics_daily_channels ADD COLUMN day_ts INTEGER');
    await alter('ALTER TABLE analytics_daily_channel_speakers ADD COLUMN day_ts INTEGER');
    await alter('ALTER TABLE analytics_daily_guild ADD COLUMN day_ts INTEGER');
    await alter('ALTER TABLE analytics_daily_guild_speakers ADD COLUMN day_ts INTEGER');
    await alter('ALTER TABLE analytics_voice_daily ADD COLUMN day_ts INTEGER');
    await alter('ALTER TABLE analytics_user_daily_messages ADD COLUMN day_ts INTEGER');
    await alter('ALTER TABLE analytics_command_usage ADD COLUMN day_ts INTEGER');

    try {
      await db.exec(`
        UPDATE analytics_daily_channels
        SET day_ts = CAST(strftime('%s', day || 'T00:00:00Z') AS INTEGER) * 1000
        WHERE day_ts IS NULL;
        UPDATE analytics_daily_channel_speakers
        SET day_ts = CAST(strftime('%s', day || 'T00:00:00Z') AS INTEGER) * 1000
        WHERE day_ts IS NULL;
        UPDATE analytics_daily_guild
        SET day_ts = CAST(strftime('%s', day || 'T00:00:00Z') AS INTEGER) * 1000
        WHERE day_ts IS NULL;
        UPDATE analytics_daily_guild_speakers
        SET day_ts = CAST(strftime('%s', day || 'T00:00:00Z') AS INTEGER) * 1000
        WHERE day_ts IS NULL;
        UPDATE analytics_voice_daily
        SET day_ts = CAST(strftime('%s', day || 'T00:00:00Z') AS INTEGER) * 1000
        WHERE day_ts IS NULL;
        UPDATE analytics_user_daily_messages
        SET day_ts = CAST(strftime('%s', day || 'T00:00:00Z') AS INTEGER) * 1000
        WHERE day_ts IS NULL;
        UPDATE analytics_command_usage
        SET day_ts = CAST(strftime('%s', day || 'T00:00:00Z') AS INTEGER) * 1000
        WHERE day_ts IS NULL;
      `);
    } catch (e) {
      console.error('Failed to backfill analytics day_ts values', e);
    }
  });

  await applyMigration('2026-02-06-normalized-views', async () => {
    await db.exec(`
      CREATE VIEW IF NOT EXISTS recruits_normalized AS
      SELECT
        id,
        recruiter_id,
        recruited_id AS member_id,
        recruited_id AS user_id,
        region,
        ign,
        created_at,
        valid,
        points
      FROM recruits;

      CREATE VIEW IF NOT EXISTS verifications_normalized AS
      SELECT
        id,
        recruited_id AS member_id,
        recruited_id AS user_id,
        recruiter_id,
        verified_at,
        verified_by
      FROM verifications;

      CREATE VIEW IF NOT EXISTS rookie_points_normalized AS
      SELECT
        member_id AS user_id,
        points,
        updated_at
      FROM rookie_points;

      CREATE VIEW IF NOT EXISTS rookie_chat_activity_normalized AS
      SELECT
        member_id AS user_id,
        week_start,
        message_count,
        awarded_chunks,
        updated_at
      FROM rookie_chat_activity;

      CREATE VIEW IF NOT EXISTS rookie_war_logs_normalized AS
      SELECT
        member_id AS user_id,
        message_id,
        created_at,
        type
      FROM rookie_war_logs;
    `);
  });

  await applyMigration('2026-02-06-antinuke-state', async () => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS antinuke_state (
        key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  });

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
  try { await db.exec("ALTER TABLE analytics_daily_channels ADD COLUMN day_ts INTEGER"); } catch (e) { void e; }
  try { await db.exec("ALTER TABLE analytics_daily_channel_speakers ADD COLUMN day_ts INTEGER"); } catch (e) { void e; }
  try { await db.exec("ALTER TABLE analytics_daily_guild ADD COLUMN day_ts INTEGER"); } catch (e) { void e; }
  try { await db.exec("ALTER TABLE analytics_daily_guild_speakers ADD COLUMN day_ts INTEGER"); } catch (e) { void e; }
  try { await db.exec("ALTER TABLE analytics_voice_daily ADD COLUMN day_ts INTEGER"); } catch (e) { void e; }
  try { await db.exec("ALTER TABLE analytics_user_daily_messages ADD COLUMN day_ts INTEGER"); } catch (e) { void e; }
  try { await db.exec("ALTER TABLE analytics_command_usage ADD COLUMN day_ts INTEGER"); } catch (e) { void e; }

  return db;
}

let dbPromise = init();

module.exports = {
  DB_PATH,
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
