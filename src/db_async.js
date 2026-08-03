const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');
const path = require('path');
const { GUILD_ID } = require('./constants');

const DEFAULT_GUILD_ID = process.env.GUILD_ID || GUILD_ID || 'GLOBAL';

function getConfiguredDbPath() {
  return process.env.DATABASE_PATH || './data/recruiter.db';
}

function ensureDbPath(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try {
    fs.closeSync(fs.openSync(dbPath, 'a'));
  } catch (e) {
    // ignore
  }
}

async function acquireSchemaLock(dbPath) {
  const lockPath = `${dbPath}.schema.lock`;
  const timeoutMs = Number.parseInt(process.env.SCHEMA_LOCK_TIMEOUT_MS || '60000', 10);
  const staleMs = Number.parseInt(process.env.SCHEMA_LOCK_STALE_MS || '120000', 10);
  const pollMs = Number.parseInt(process.env.SCHEMA_LOCK_POLL_MS || '250', 10);
  const startedAt = Date.now();

  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });

  let done = false;
  while (!done) {
    let handle = null;
    try {
      handle = await fs.promises.open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      done = true;
      return async () => {
        try { await handle.close(); } catch (e) { console.error(e); }
        try { await fs.promises.unlink(lockPath); } catch (e) { if (!e || e.code !== 'ENOENT') console.error('Failed to release schema lock:', e); }
      };
    } catch (e) {
      if (handle) {
        try { await handle.close(); } catch (closeErr) { console.error('Failed to close schema lock handle:', closeErr); }
      }
      if (!e || e.code !== 'EEXIST') throw e;

      try {
        const stat = await fs.promises.stat(lockPath);
        if ((Date.now() - stat.mtimeMs) > staleMs) {
          await fs.promises.unlink(lockPath);
          continue;
        }
      } catch (statErr) {
        if (!statErr || statErr.code !== 'ENOENT') {
          console.error('Failed checking schema lock file state:', statErr);
        }
      }

      if ((Date.now() - startedAt) >= timeoutMs) {
        throw new Error(`Timed out waiting for schema lock (${lockPath})`);
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }
}

function readPragmaValues(rows) {
  if (!rows || !rows.length) return [];
  const values = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const val = Object.values(row)[0];
    values.push(val);
  }
  return values;
}

async function runIntegrityChecks(db, label = 'startup') {
  if (!db || typeof db.all !== 'function') return { ok: true, skipped: true };
  const enabled = (process.env.DB_INTEGRITY_CHECK || 'true').toLowerCase() === 'true';
  if (!enabled) return { ok: true, skipped: true };
  const mode = (process.env.DB_INTEGRITY_MODE || 'quick').toLowerCase();
  if (mode === 'off' || mode === 'none' || mode === 'skip') {
    return { ok: true, skipped: true };
  }

  let integrityValues = [];
  try {
    if (mode === 'full') {
      integrityValues = readPragmaValues(await db.all('PRAGMA integrity_check'));
    } else {
      integrityValues = readPragmaValues(await db.all('PRAGMA quick_check'));
    }
  } catch (e) {
    console.error('DB integrity check failed to run', { label, mode, error: e });
    if ((process.env.DB_INTEGRITY_STRICT || '').toLowerCase() === 'true') throw e;
    return { ok: false, error: e };
  }

  const integrityOk = integrityValues.length === 0
    ? true
    : integrityValues.every(val => String(val).toLowerCase() === 'ok');

  let fkRows = [];
  try {
    fkRows = await db.all('PRAGMA foreign_key_check');
  } catch (e) {
    console.error('DB foreign_key_check failed to run', { label, error: e });
    if ((process.env.DB_INTEGRITY_STRICT || '').toLowerCase() === 'true') throw e;
    return { ok: false, error: e };
  }

  const fkOk = !fkRows || fkRows.length === 0;
  const ok = integrityOk && fkOk;

  if (!ok) {
    console.error('DB integrity check failed', {
      label,
      mode,
      integrity: integrityValues,
      foreignKeyViolations: fkRows
    });
    if ((process.env.DB_INTEGRITY_STRICT || '').toLowerCase() === 'true') {
      throw new Error('Database integrity check failed');
    }
  } else if ((process.env.DB_INTEGRITY_LOG_OK || '').toLowerCase() === 'true') {
    console.log('DB integrity check OK', { label, mode });
  }

  return { ok, integrityOk, fkOk, integrityValues, fkRows };
}

async function init(dbPath = getConfiguredDbPath()) {
  ensureDbPath(dbPath);
  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  // Reduce "database is locked" errors under concurrent access.
  try { await db.exec('PRAGMA foreign_keys = ON'); } catch (e) { console.error(e); }
  const disableWal = (process.env.SQLITE_DISABLE_WAL || '').toLowerCase() === 'true';
  const journalModeRaw = (process.env.SQLITE_JOURNAL_MODE || 'WAL').toUpperCase();
  const allowedModes = new Set(['WAL', 'DELETE', 'TRUNCATE', 'PERSIST', 'MEMORY', 'OFF']);
  if (!disableWal) {
    if (allowedModes.has(journalModeRaw)) {
      try { await db.exec(`PRAGMA journal_mode = ${journalModeRaw}`); } catch (e) { console.error(e); }
    } else {
      console.warn(`Invalid SQLITE_JOURNAL_MODE "${journalModeRaw}" - skipping journal_mode PRAGMA.`);
    }
  }
  const busyTimeoutRaw = Number.parseInt(process.env.SQLITE_BUSY_TIMEOUT_MS || '15000', 10);
  const busyTimeoutMs = Number.isFinite(busyTimeoutRaw) && busyTimeoutRaw > 0 ? busyTimeoutRaw : 15000;
  try { await db.exec('PRAGMA synchronous = NORMAL'); } catch (e) { console.error(e); }
  try { await db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`); } catch (e) { console.error(e); }

  const releaseSchemaLock = await acquireSchemaLock(dbPath);
  const strictMigrations = (() => {
    const configured = process.env.DB_MIGRATION_STRICT;
    if (configured === undefined || configured === null || String(configured).trim() === '') {
      return process.env.NODE_ENV !== 'test';
    }
    return String(configured).toLowerCase() === 'true';
  })();

  try {
    // Create schema if not exists
    await db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 0,
    migration_count INTEGER NOT NULL DEFAULT 0,
    last_migration_id TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recruits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    recruiter_id TEXT NOT NULL,
    recruited_id TEXT NOT NULL,
    region TEXT NOT NULL,
    ign TEXT,
    created_at INTEGER NOT NULL,
    valid INTEGER DEFAULT 1,
    points INTEGER DEFAULT 0
  );

  CREATE UNIQUE INDEX IF NOT EXISTS uniq_recruit ON recruits(guild_id, recruited_id);

  CREATE TABLE IF NOT EXISTS recruiters (
    guild_id TEXT NOT NULL,
    id TEXT NOT NULL,
    points INTEGER DEFAULT 0,
    warnings INTEGER DEFAULT 0,
    promoted INTEGER DEFAULT 0,
    channel_base INTEGER DEFAULT 4,
    PRIMARY KEY (guild_id, id)
  );

  CREATE TABLE IF NOT EXISTS flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    recruiter_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    dismissed INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    recruiter_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expired_at INTEGER,
    note TEXT,
    revoked INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS multipliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    recruiter_id TEXT NOT NULL,
    value REAL NOT NULL,
    type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    recruiter_id TEXT NOT NULL,
    item TEXT NOT NULL,
    cost INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS leaderboard_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    region TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS weekly_calculations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
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
    guild_id TEXT NOT NULL,
    recruited_id TEXT NOT NULL,
    recruiter_id TEXT,
    verified_at INTEGER NOT NULL,
    verified_by TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS uniq_verification_recruited ON verifications(guild_id, recruited_id);

  CREATE TABLE IF NOT EXISTS rookie_points (
    guild_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    points REAL NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, member_id)
  );

  CREATE TABLE IF NOT EXISTS rookie_chat_activity (
    guild_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    week_start INTEGER NOT NULL,
    message_count INTEGER DEFAULT 0,
    awarded_chunks INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, member_id, week_start)
  );

  CREATE TABLE IF NOT EXISTS rookie_war_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    type TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trial_fast_track (
    guild_id TEXT NOT NULL,
    recruiter_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    recruit1_id TEXT,
    recruit2_id TEXT,
    recruit3_id TEXT,
    count INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, recruiter_id)
  );

  CREATE TABLE IF NOT EXISTS absences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    recruiter_id TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS system_events (
    guild_id TEXT NOT NULL,
    key TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    PRIMARY KEY (guild_id, key)
  );

  CREATE TABLE IF NOT EXISTS invite_snapshots (
    guild_id TEXT NOT NULL,
    invite_code TEXT NOT NULL,
    uses INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, invite_code)
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
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    last_message_at INTEGER,
    last_voice_at INTEGER,
    last_active_at INTEGER,
    PRIMARY KEY (guild_id, user_id)
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

  CREATE TABLE IF NOT EXISTS invite_cooldowns (
    guild_id TEXT NOT NULL,
    recruiter_id TEXT NOT NULL,
    cooldown_until INTEGER NOT NULL,
    PRIMARY KEY (guild_id, recruiter_id)
  );

  CREATE TABLE IF NOT EXISTS recruiter_points_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    recruiter_id TEXT NOT NULL,
    delta REAL NOT NULL,
    reason TEXT NOT NULL,
    ref_type TEXT,
    ref_id TEXT,
    resulting_points REAL NOT NULL,
    created_at INTEGER NOT NULL
  );

    `);

  try {
    await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_leaderboard_channel_region ON leaderboard_messages(guild_id, channel_id, region)');
  } catch (e) {
    console.error(e);
  }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_recruits_guild_recruiter_created_valid ON recruits(guild_id, recruiter_id, created_at, valid)');
  } catch (e) {
    console.error(e);
  }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_recruits_guild_region_created_valid ON recruits(guild_id, region, created_at, valid)');
  } catch (e) {
    console.error(e);
  }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_warnings_guild_recruiter_active ON warnings(guild_id, recruiter_id, revoked, expired_at)');
  } catch (e) {
    console.error(e);
  }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_absences_guild_recruiter_active_end ON absences(guild_id, recruiter_id, active, end_date)');
  } catch (e) {
    console.error(e);
  }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_weekly_calcs_guild_week ON weekly_calculations(guild_id, week_start)');
  } catch (e) {
    console.error(e);
  }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_purchases_guild_recruiter_created ON purchases(guild_id, recruiter_id, created_at)');
  } catch (e) {
    console.error(e);
  }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_multipliers_guild_recruiter_expires ON multipliers(guild_id, recruiter_id, expires_at)');
  } catch (e) {
    console.error(e);
  }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_recruiter_points_ledger_guild_user_time ON recruiter_points_ledger(guild_id, recruiter_id, created_at DESC)');
  } catch (e) {
    console.error(e);
  }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_invite_snapshots_guild ON invite_snapshots(guild_id)');
  } catch (e) {
    console.error(e);
  }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_analytics_daily_channels_guild_channel_dayts ON analytics_daily_channels(guild_id, channel_id, day_ts)');
  } catch (e) {
    console.error(e);
  }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_analytics_daily_guild_guild_dayts ON analytics_daily_guild(guild_id, day_ts)');
  } catch (e) {
    console.error(e);
  }
  try {
    await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_rookie_war_message ON rookie_war_logs(message_id)');
  } catch (e) {
    console.error(e);
  }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_rookie_war_member_time ON rookie_war_logs(member_id, created_at)');
  } catch (e) {
    console.error(e);
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
      if (strictMigrations) throw err;
    }
  };

  const getTableInfo = async (table) => {
    try {
      return await db.all(`PRAGMA table_info(${table})`);
    } catch (e) {
      return [];
    }
  };

  const hasColumn = async (table, column) => {
    const info = await getTableInfo(table);
    return info.some(row => row && row.name === column);
  };

  const hasTable = async (table) => {
    try {
      const row = await db.get('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', 'table', table);
      return !!row;
    } catch (e) {
      return false;
    }
  };

  const hasCompositePk = async (table, columns) => {
    const info = await getTableInfo(table);
    const pkCols = info
      .filter(row => row && row.pk)
      .sort((a, b) => a.pk - b.pk)
      .map(row => row.name);
    return columns.length === pkCols.length && columns.every((col, idx) => pkCols[idx] === col);
  };

  await applyMigration('2026-02-06-recruiter-triggers', async () => {
    await db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_recruits_recruiter_row
      AFTER INSERT ON recruits
      BEGIN
        INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
        VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_flags_recruiter_row
      AFTER INSERT ON flags
      BEGIN
        INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
        VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_multipliers_recruiter_row
      AFTER INSERT ON multipliers
      BEGIN
        INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
        VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_purchases_recruiter_row
      AFTER INSERT ON purchases
      BEGIN
        INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
        VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_absences_recruiter_row
      AFTER INSERT ON absences
      BEGIN
        INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
        VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_weekly_calc_recruiter_row
      AFTER INSERT ON weekly_calculations
      BEGIN
        INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
        VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_trial_fast_track_recruiter_row
      AFTER INSERT ON trial_fast_track
      BEGIN
        INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
        VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_verifications_recruiter_row
      AFTER INSERT ON verifications
      WHEN NEW.recruiter_id IS NOT NULL
      BEGIN
        INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
        VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
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
        if (e && String(e.message || '').includes('duplicate column name')) return;
        console.warn('Migration alter failed', { sql, error: e && e.message ? e.message : String(e) });
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
        guild_id,
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
        guild_id,
        id,
        recruited_id AS member_id,
        recruited_id AS user_id,
        recruiter_id,
        verified_at,
        verified_by
      FROM verifications;

      CREATE VIEW IF NOT EXISTS rookie_points_normalized AS
      SELECT
        guild_id,
        member_id AS user_id,
        points,
        updated_at
      FROM rookie_points;

      CREATE VIEW IF NOT EXISTS rookie_chat_activity_normalized AS
      SELECT
        guild_id,
        member_id AS user_id,
        week_start,
        message_count,
        awarded_chunks,
        updated_at
      FROM rookie_chat_activity;

      CREATE VIEW IF NOT EXISTS rookie_war_logs_normalized AS
      SELECT
        guild_id,
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

  await applyMigration('2026-02-07-guild-columns', async () => {
    // Drop normalized views to avoid schema validation errors while rebuilding tables.
    await db.exec(`
      DROP VIEW IF EXISTS recruits_normalized;
      DROP VIEW IF EXISTS verifications_normalized;
      DROP VIEW IF EXISTS rookie_points_normalized;
      DROP VIEW IF EXISTS rookie_chat_activity_normalized;
      DROP VIEW IF EXISTS rookie_war_logs_normalized;
    `);

    // Drop triggers that depend on recruiters before we drop/rename it
    await db.exec(`
      DROP TRIGGER IF EXISTS trg_recruits_recruiter_row;
      DROP TRIGGER IF EXISTS trg_warnings_recruiter_row;
      DROP TRIGGER IF EXISTS trg_flags_recruiter_row;
      DROP TRIGGER IF EXISTS trg_multipliers_recruiter_row;
      DROP TRIGGER IF EXISTS trg_purchases_recruiter_row;
      DROP TRIGGER IF EXISTS trg_absences_recruiter_row;
      DROP TRIGGER IF EXISTS trg_weekly_calc_recruiter_row;
      DROP TRIGGER IF EXISTS trg_trial_fast_track_recruiter_row;
      DROP TRIGGER IF EXISTS trg_verifications_recruiter_row;
    `);

    const defaultGuild = DEFAULT_GUILD_ID;
    const addGuildColumn = async (table) => {
      if (!(await hasTable(table))) return;
      if (!(await hasColumn(table, 'guild_id'))) {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN guild_id TEXT`);
      }
      await db.run(`UPDATE ${table} SET guild_id = ? WHERE guild_id IS NULL`, defaultGuild);
    };

    await addGuildColumn('recruits');
    await addGuildColumn('flags');
    await addGuildColumn('warnings');
    await addGuildColumn('multipliers');
    await addGuildColumn('purchases');
    await addGuildColumn('recruiter_invites');
    await addGuildColumn('invite_snapshots');
    await addGuildColumn('leaderboard_messages');
    await addGuildColumn('weekly_calculations');
    await addGuildColumn('verifications');
    await addGuildColumn('rookie_war_logs');
    await addGuildColumn('absences');
    await addGuildColumn('system_events');

    if (!(await hasCompositePk('recruiters', ['guild_id', 'id']))) {
      const hasGuild = await hasColumn('recruiters', 'guild_id');
      await db.exec(`
        CREATE TABLE IF NOT EXISTS recruiters_new (
          guild_id TEXT NOT NULL,
          id TEXT NOT NULL,
          points INTEGER DEFAULT 0,
          warnings INTEGER DEFAULT 0,
          promoted INTEGER DEFAULT 0,
          channel_base INTEGER DEFAULT 4,
          PRIMARY KEY (guild_id, id)
        );
      `);
      const guildExpr = hasGuild ? 'COALESCE(guild_id, ?)' : '?';
      await db.run(
        `INSERT OR IGNORE INTO recruiters_new (guild_id, id, points, warnings, promoted, channel_base)
         SELECT ${guildExpr}, id, points, warnings, promoted, channel_base FROM recruiters`,
        defaultGuild
      );
      await db.exec('DROP TABLE recruiters');
      await db.exec('ALTER TABLE recruiters_new RENAME TO recruiters');
    }

    if (!(await hasCompositePk('rookie_points', ['guild_id', 'member_id']))) {
      const hasGuild = await hasColumn('rookie_points', 'guild_id');
      await db.exec(`
        CREATE TABLE IF NOT EXISTS rookie_points_new (
          guild_id TEXT NOT NULL,
          member_id TEXT NOT NULL,
          points REAL NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (guild_id, member_id)
        );
      `);
      const guildExpr = hasGuild ? 'COALESCE(guild_id, ?)' : '?';
      await db.run(
        `INSERT OR IGNORE INTO rookie_points_new (guild_id, member_id, points, updated_at)
         SELECT ${guildExpr}, member_id, points, updated_at FROM rookie_points`,
        defaultGuild
      );
      await db.exec('DROP TABLE rookie_points');
      await db.exec('ALTER TABLE rookie_points_new RENAME TO rookie_points');
    }

    if (!(await hasCompositePk('trial_fast_track', ['guild_id', 'recruiter_id']))) {
      const hasGuild = await hasColumn('trial_fast_track', 'guild_id');
      await db.exec(`
        CREATE TABLE IF NOT EXISTS trial_fast_track_new (
          guild_id TEXT NOT NULL,
          recruiter_id TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          recruit1_id TEXT,
          recruit2_id TEXT,
          recruit3_id TEXT,
          count INTEGER DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (guild_id, recruiter_id)
        );
      `);
      const guildExpr = hasGuild ? 'COALESCE(guild_id, ?)' : '?';
      await db.run(
        `INSERT OR IGNORE INTO trial_fast_track_new (guild_id, recruiter_id, started_at, recruit1_id, recruit2_id, recruit3_id, count, updated_at)
         SELECT ${guildExpr}, recruiter_id, started_at, recruit1_id, recruit2_id, recruit3_id, count, updated_at FROM trial_fast_track`,
        defaultGuild
      );
      await db.exec('DROP TABLE trial_fast_track');
      await db.exec('ALTER TABLE trial_fast_track_new RENAME TO trial_fast_track');
    }

    if (!(await hasCompositePk('rookie_chat_activity', ['guild_id', 'member_id', 'week_start']))) {
      const hasGuild = await hasColumn('rookie_chat_activity', 'guild_id');
      await db.exec(`
        CREATE TABLE IF NOT EXISTS rookie_chat_activity_new (
          guild_id TEXT NOT NULL,
          member_id TEXT NOT NULL,
          week_start INTEGER NOT NULL,
          message_count INTEGER DEFAULT 0,
          awarded_chunks INTEGER DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (guild_id, member_id, week_start)
        );
      `);
      const guildExpr = hasGuild ? 'COALESCE(guild_id, ?)' : '?';
      await db.run(
        `INSERT OR IGNORE INTO rookie_chat_activity_new (guild_id, member_id, week_start, message_count, awarded_chunks, updated_at)
         SELECT ${guildExpr}, member_id, week_start, message_count, awarded_chunks, updated_at FROM rookie_chat_activity`,
        defaultGuild
      );
      await db.exec('DROP TABLE rookie_chat_activity');
      await db.exec('ALTER TABLE rookie_chat_activity_new RENAME TO rookie_chat_activity');
    }

    if (!(await hasCompositePk('analytics_user_activity', ['guild_id', 'user_id']))) {
      const hasGuild = await hasColumn('analytics_user_activity', 'guild_id');
      await db.exec(`
        CREATE TABLE IF NOT EXISTS analytics_user_activity_new (
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          last_message_at INTEGER,
          last_voice_at INTEGER,
          last_active_at INTEGER,
          PRIMARY KEY (guild_id, user_id)
        );
      `);
      const guildExpr = hasGuild ? 'COALESCE(guild_id, ?)' : '?';
      await db.run(
        `INSERT OR IGNORE INTO analytics_user_activity_new (guild_id, user_id, last_message_at, last_voice_at, last_active_at)
         SELECT ${guildExpr}, user_id, last_message_at, last_voice_at, last_active_at FROM analytics_user_activity`,
        defaultGuild
      );
      await db.exec('DROP TABLE analytics_user_activity');
      await db.exec('ALTER TABLE analytics_user_activity_new RENAME TO analytics_user_activity');
    }

    if (!(await hasCompositePk('system_events', ['guild_id', 'key']))) {
      const hasGuild = await hasColumn('system_events', 'guild_id');
      await db.exec(`
        CREATE TABLE IF NOT EXISTS system_events_new (
          guild_id TEXT NOT NULL,
          key TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          PRIMARY KEY (guild_id, key)
        );
      `);
      const guildExpr = hasGuild ? 'COALESCE(guild_id, ?)' : '?';
      await db.run(
        `INSERT OR IGNORE INTO system_events_new (guild_id, key, timestamp)
         SELECT ${guildExpr}, key, timestamp FROM system_events`,
        defaultGuild
      );
      await db.exec('DROP TABLE system_events');
      await db.exec('ALTER TABLE system_events_new RENAME TO system_events');
    }

    await db.exec(`
      CREATE VIEW IF NOT EXISTS recruits_normalized AS
      SELECT
        guild_id,
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
        guild_id,
        id,
        recruited_id AS member_id,
        recruited_id AS user_id,
        recruiter_id,
        verified_at,
        verified_by
      FROM verifications;

      CREATE VIEW IF NOT EXISTS rookie_points_normalized AS
      SELECT
        guild_id,
        member_id AS user_id,
        points,
        updated_at
      FROM rookie_points;

      CREATE VIEW IF NOT EXISTS rookie_chat_activity_normalized AS
      SELECT
        guild_id,
        member_id AS user_id,
        week_start,
        message_count,
        awarded_chunks,
        updated_at
      FROM rookie_chat_activity;

      CREATE VIEW IF NOT EXISTS rookie_war_logs_normalized AS
      SELECT
        guild_id,
        member_id AS user_id,
        message_id,
        created_at,
        type
      FROM rookie_war_logs;
    `);
  });

  await applyMigration('2026-02-12-normalized-views-guild', async () => {
    await db.exec(`
      DROP VIEW IF EXISTS recruits_normalized;
      DROP VIEW IF EXISTS verifications_normalized;
      DROP VIEW IF EXISTS rookie_points_normalized;
      DROP VIEW IF EXISTS rookie_chat_activity_normalized;
      DROP VIEW IF EXISTS rookie_war_logs_normalized;

      CREATE VIEW IF NOT EXISTS recruits_normalized AS
      SELECT
        guild_id,
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
        guild_id,
        id,
        recruited_id AS member_id,
        recruited_id AS user_id,
        recruiter_id,
        verified_at,
        verified_by
      FROM verifications;

      CREATE VIEW IF NOT EXISTS rookie_points_normalized AS
      SELECT
        guild_id,
        member_id AS user_id,
        points,
        updated_at
      FROM rookie_points;

      CREATE VIEW IF NOT EXISTS rookie_chat_activity_normalized AS
      SELECT
        guild_id,
        member_id AS user_id,
        week_start,
        message_count,
        awarded_chunks,
        updated_at
      FROM rookie_chat_activity;

      CREATE VIEW IF NOT EXISTS rookie_war_logs_normalized AS
      SELECT
        guild_id,
        member_id AS user_id,
        message_id,
        created_at,
        type
      FROM rookie_war_logs;
    `);
  });

  const ensureNormalizedViews = async () => {
    const viewSql = async (name) => {
      try {
        const row = await db.get('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?', 'view', name);
        return row && row.sql ? String(row.sql).toLowerCase() : '';
      } catch (e) {
        return '';
      }
    };
    const views = [
      'recruits_normalized',
      'verifications_normalized',
      'rookie_points_normalized',
      'rookie_chat_activity_normalized',
      'rookie_war_logs_normalized'
    ];
    let needsRebuild = false;
    for (const v of views) {
      const sql = await viewSql(v);
      if (!sql || !sql.includes('guild_id')) {
        needsRebuild = true;
        break;
      }
    }
    if (!needsRebuild) return;
    try {
      await db.exec(`
        DROP VIEW IF EXISTS recruits_normalized;
        DROP VIEW IF EXISTS verifications_normalized;
        DROP VIEW IF EXISTS rookie_points_normalized;
        DROP VIEW IF EXISTS rookie_chat_activity_normalized;
        DROP VIEW IF EXISTS rookie_war_logs_normalized;

        CREATE VIEW IF NOT EXISTS recruits_normalized AS
        SELECT
          guild_id,
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
          guild_id,
          id,
          recruited_id AS member_id,
          recruited_id AS user_id,
          recruiter_id,
          verified_at,
          verified_by
        FROM verifications;

        CREATE VIEW IF NOT EXISTS rookie_points_normalized AS
        SELECT
          guild_id,
          member_id AS user_id,
          points,
          updated_at
        FROM rookie_points;

        CREATE VIEW IF NOT EXISTS rookie_chat_activity_normalized AS
        SELECT
          guild_id,
          member_id AS user_id,
          week_start,
          message_count,
          awarded_chunks,
          updated_at
        FROM rookie_chat_activity;

        CREATE VIEW IF NOT EXISTS rookie_war_logs_normalized AS
        SELECT
          guild_id,
          member_id AS user_id,
          message_id,
          created_at,
          type
        FROM rookie_war_logs;
      `);
    } catch (e) {
      console.error('Failed to ensure normalized views:', e);
    }
  };

  const ensureRecruiterInsertTriggers = async () => {
    try {
      await db.exec(`
        DROP TRIGGER IF EXISTS trg_recruits_recruiter_row;
        DROP TRIGGER IF EXISTS trg_warnings_recruiter_row;
        DROP TRIGGER IF EXISTS trg_flags_recruiter_row;
        DROP TRIGGER IF EXISTS trg_multipliers_recruiter_row;
        DROP TRIGGER IF EXISTS trg_purchases_recruiter_row;
        DROP TRIGGER IF EXISTS trg_absences_recruiter_row;
        DROP TRIGGER IF EXISTS trg_weekly_calc_recruiter_row;
        DROP TRIGGER IF EXISTS trg_trial_fast_track_recruiter_row;
        DROP TRIGGER IF EXISTS trg_verifications_recruiter_row;

        CREATE TRIGGER IF NOT EXISTS trg_recruits_recruiter_row
        AFTER INSERT ON recruits
        BEGIN
          INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
          VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
        END;

        CREATE TRIGGER IF NOT EXISTS trg_flags_recruiter_row
        AFTER INSERT ON flags
        BEGIN
          INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
          VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
        END;

        CREATE TRIGGER IF NOT EXISTS trg_multipliers_recruiter_row
        AFTER INSERT ON multipliers
        BEGIN
          INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
          VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
        END;

        CREATE TRIGGER IF NOT EXISTS trg_purchases_recruiter_row
        AFTER INSERT ON purchases
        BEGIN
          INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
          VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
        END;

        CREATE TRIGGER IF NOT EXISTS trg_absences_recruiter_row
        AFTER INSERT ON absences
        BEGIN
          INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
          VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
        END;

        CREATE TRIGGER IF NOT EXISTS trg_weekly_calc_recruiter_row
        AFTER INSERT ON weekly_calculations
        BEGIN
          INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
          VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
        END;

        CREATE TRIGGER IF NOT EXISTS trg_trial_fast_track_recruiter_row
        AFTER INSERT ON trial_fast_track
        BEGIN
          INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
          VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
        END;

        CREATE TRIGGER IF NOT EXISTS trg_verifications_recruiter_row
        AFTER INSERT ON verifications
        WHEN NEW.recruiter_id IS NOT NULL
        BEGIN
          INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
          VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
        END;
      `);
    } catch (e) {
      console.error('Failed to ensure recruiter insert triggers:', e);
    }
  };

  await applyMigration('2026-02-07-recruiter-triggers-guild', async () => {
    await db.exec(`
      DROP TRIGGER IF EXISTS trg_recruits_recruiter_row;
      DROP TRIGGER IF EXISTS trg_warnings_recruiter_row;
      DROP TRIGGER IF EXISTS trg_flags_recruiter_row;
      DROP TRIGGER IF EXISTS trg_multipliers_recruiter_row;
      DROP TRIGGER IF EXISTS trg_purchases_recruiter_row;
      DROP TRIGGER IF EXISTS trg_absences_recruiter_row;
      DROP TRIGGER IF EXISTS trg_weekly_calc_recruiter_row;
      DROP TRIGGER IF EXISTS trg_trial_fast_track_recruiter_row;
      DROP TRIGGER IF EXISTS trg_verifications_recruiter_row;

      CREATE TRIGGER IF NOT EXISTS trg_recruits_recruiter_row
      AFTER INSERT ON recruits
      BEGIN
        INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
        VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_flags_recruiter_row
      AFTER INSERT ON flags
      BEGIN
        INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
        VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_multipliers_recruiter_row
      AFTER INSERT ON multipliers
      BEGIN
        INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
        VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_purchases_recruiter_row
      AFTER INSERT ON purchases
      BEGIN
        INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
        VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_absences_recruiter_row
      AFTER INSERT ON absences
      BEGIN
        INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
        VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_weekly_calc_recruiter_row
      AFTER INSERT ON weekly_calculations
      BEGIN
        INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
        VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_trial_fast_track_recruiter_row
      AFTER INSERT ON trial_fast_track
      BEGIN
        INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
        VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_verifications_recruiter_row
      AFTER INSERT ON verifications
      WHEN NEW.recruiter_id IS NOT NULL
      BEGIN
        INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
        VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
      END;
    `);
  });

  // Add columns if missing (best-effort)
  try { await db.exec("ALTER TABLE recruiters ADD COLUMN promoted INTEGER DEFAULT 0"); } catch (e) { console.error(e); }
  try { await db.exec("ALTER TABLE recruiters ADD COLUMN channel_base INTEGER DEFAULT 4"); } catch (e) { console.error(e); }
  try { await db.exec("ALTER TABLE flags ADD COLUMN dismissed INTEGER DEFAULT 0"); } catch (e) { console.error(e); }
  try { await db.exec("ALTER TABLE recruits ADD COLUMN points INTEGER DEFAULT 0"); } catch (e) { console.error(e); }
  try { await db.exec("ALTER TABLE warnings ADD COLUMN expired_at INTEGER"); } catch (e) { console.error(e); }
  try { await db.exec("ALTER TABLE warnings ADD COLUMN revoked INTEGER DEFAULT 0"); } catch (e) { console.error(e); }
  try { await db.exec("ALTER TABLE weekly_calculations ADD COLUMN week_start INTEGER"); } catch (e) { console.error(e); }
  try { await db.exec("ALTER TABLE weekly_calculations ADD COLUMN absent INTEGER DEFAULT 0"); } catch (e) { console.error(e); }
  try { await db.exec("ALTER TABLE weekly_calculations ADD COLUMN verify_rate REAL DEFAULT 0"); } catch (e) { console.error(e); }
  try { await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_weekly_calc_recruiter_week ON weekly_calculations(guild_id, recruiter_id, week_start)'); } catch (e) { console.error(e); }
  try { await db.exec("CREATE TABLE IF NOT EXISTS multipliers (id INTEGER PRIMARY KEY AUTOINCREMENT, recruiter_id TEXT NOT NULL, value REAL NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)"); } catch (e) { console.error(e); }
  try { await db.exec("ALTER TABLE analytics_daily_channels ADD COLUMN day_ts INTEGER"); } catch (e) { console.error(e); }
  try { await db.exec("ALTER TABLE analytics_daily_channel_speakers ADD COLUMN day_ts INTEGER"); } catch (e) { console.error(e); }
  try { await db.exec("ALTER TABLE analytics_daily_guild ADD COLUMN day_ts INTEGER"); } catch (e) { console.error(e); }
  try { await db.exec("ALTER TABLE analytics_daily_guild_speakers ADD COLUMN day_ts INTEGER"); } catch (e) { console.error(e); }
  try { await db.exec("ALTER TABLE analytics_voice_daily ADD COLUMN day_ts INTEGER"); } catch (e) { console.error(e); }
  try { await db.exec("ALTER TABLE analytics_user_daily_messages ADD COLUMN day_ts INTEGER"); } catch (e) { console.error(e); }
  try { await db.exec("ALTER TABLE analytics_command_usage ADD COLUMN day_ts INTEGER"); } catch (e) { console.error(e); }

  await ensureNormalizedViews();
  await ensureRecruiterInsertTriggers();

  const refreshSchemaVersion = async () => {
    try {
      const countRow = await db.get('SELECT COUNT(*) AS c FROM schema_migrations');
      const lastRow = await db.get('SELECT id FROM schema_migrations ORDER BY applied_at DESC, id DESC LIMIT 1');
      const migrationCount = countRow && Number.isFinite(Number(countRow.c)) ? Number(countRow.c) : 0;
      const version = migrationCount;
      const lastMigrationId = lastRow && lastRow.id ? String(lastRow.id) : null;
      await db.run(
        `INSERT INTO schema_version (id, version, migration_count, last_migration_id, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           version = excluded.version,
           migration_count = excluded.migration_count,
           last_migration_id = excluded.last_migration_id,
           updated_at = excluded.updated_at`,
        version,
        migrationCount,
        lastMigrationId,
        Date.now()
      );
    } catch (e) {
      console.error('Failed to refresh schema_version metadata', e);
    }
  };

    await refreshSchemaVersion();
    await runIntegrityChecks(db, 'startup');
  } finally {
    await releaseSchemaLock();
  }

  return db;
}

let currentDbPath = getConfiguredDbPath();
let dbPromise = init(currentDbPath);

async function getDb() {
  const desiredPath = getConfiguredDbPath();
  if (desiredPath !== currentDbPath) {
    const previousPromise = dbPromise;
    currentDbPath = desiredPath;
    dbPromise = init(currentDbPath);
    try {
      const previousDb = await previousPromise;
      await previousDb.close();
    } catch (e) {
      console.error(e);
    }
  }
  return dbPromise;
}

module.exports = {
  get DB_PATH() {
    return currentDbPath;
  },
  get: async (sql, ...params) => (await getDb()).get(sql, ...params),
  all: async (sql, ...params) => (await getDb()).all(sql, ...params),
  run: async (sql, ...params) => (await getDb()).run(sql, ...params),
  exec: async (sql) => (await getDb()).exec(sql),
  close: async () => { const d = await getDb(); return d.close(); },
  checkIntegrity: async (label) => runIntegrityChecks(await getDb(), label || 'manual'),
  // prepare returns object with async helpers to ease migration
  prepare: (sql) => ({
    get: async (...params) => (await getDb()).get(sql, ...params),
    all: async (...params) => (await getDb()).all(sql, ...params),
    run: async (...params) => (await getDb()).run(sql, ...params),
  })
};

