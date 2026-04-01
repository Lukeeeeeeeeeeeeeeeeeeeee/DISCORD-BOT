const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');
const path = require('path');
const { GUILD_ID } = require('./constants');

const DB_PATH = process.env.DATABASE_PATH || './data/recruiter.db';
const DEFAULT_GUILD_ID = process.env.GUILD_ID || GUILD_ID || 'GLOBAL';

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

// Synchronously ensure DB path exists and touch file (compatibility for tests)
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
try {
  fs.closeSync(fs.openSync(DB_PATH, 'a'));
} catch (e) {
  // ignore
}

async function init() {
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
  try { await db.exec('PRAGMA busy_timeout = 10000'); } catch (e) { void e; }

  // Hardening (v3.0): Coordinated Fleet Infrastructure
  await db.exec(`
    CREATE TABLE IF NOT EXISTS dm_global_backoff (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      backoff_until INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    
    -- Initialize the global clock if missing
    INSERT OR IGNORE INTO dm_global_backoff (id, backoff_until, updated_at) VALUES (1, 0, ?);
  `, Date.now());

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

  const hasCompositePk = async (table, columns) => {
    const info = await getTableInfo(table);
    const pkCols = info
      .filter(row => row && row.pk)
      .sort((a, b) => a.pk - b.pk)
      .map(row => row.name);
    return columns.length === pkCols.length && columns.every((col, idx) => pkCols[idx] === col);
  };

  const attemptCols = await getTableInfo('dm_delivery_attempts');
  if (!attemptCols.some(c => c.name === 'message_id')) {
    await db.exec('ALTER TABLE dm_delivery_attempts ADD COLUMN message_id TEXT');
  }

  // Create schema if not exists
  await db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
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

  CREATE TABLE IF NOT EXISTS weekly_recruit_overrides (
    guild_id TEXT NOT NULL,
    recruiter_id TEXT NOT NULL,
    week_start INTEGER NOT NULL,
    total INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL,
    note TEXT,
    PRIMARY KEY (guild_id, recruiter_id, week_start)
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

  CREATE TABLE IF NOT EXISTS dm_workers (
    worker_id TEXT PRIMARY KEY,
    display_name TEXT,
    enabled INTEGER DEFAULT 1,
    weight INTEGER DEFAULT 1,
    started_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    status TEXT DEFAULT 'online',
    meta_json TEXT
  );

  CREATE TABLE IF NOT EXISTS dm_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    message_type TEXT NOT NULL,
    message_body TEXT NOT NULL,
    target_mode TEXT NOT NULL,
    target_role_ids TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    report_channel_id TEXT,
    requested_channel_id TEXT,
    total_targets INTEGER DEFAULT 0,
    total_batches INTEGER DEFAULT 0,
    total_sent INTEGER DEFAULT 0,
    total_failed INTEGER DEFAULT 0,
    total_blocked INTEGER DEFAULT 0,
    total_undeliverable INTEGER DEFAULT 0,
    total_retries INTEGER DEFAULT 0,
    started_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    report_posted INTEGER DEFAULT 0,
    report_posted_at INTEGER,
    report_attempts INTEGER DEFAULT 0,
    message_hash TEXT,
    last_notified_percentage INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS dm_campaign_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    assigned_worker_id TEXT,
    claim_id TEXT,
    claim_expires_at INTEGER,
    batch_no INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    retries INTEGER DEFAULT 0,
    last_attempt_at INTEGER,
    next_attempt_at INTEGER,
    last_error_code TEXT,
    last_error_message TEXT,
    blocked_by_worker_id TEXT,
    message_type TEXT,
    last_worker_id TEXT,
    worker_switches INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (campaign_id) REFERENCES dm_campaigns(id) ON DELETE CASCADE,
    UNIQUE (campaign_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS dm_delivery_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    attempt_no INTEGER NOT NULL,
    result TEXT NOT NULL,
    error_code TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (campaign_id) REFERENCES dm_campaigns(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES dm_campaign_targets(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS dm_user_affinity (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    preferred_worker_id TEXT,
    preferred_worker_last_dm_at INTEGER,
    consecutive_misc_count INTEGER DEFAULT 0,
    war_worker_id TEXT,
    war_last_dm_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS dm_worker_user_blocks (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    reason TEXT,
    error_code TEXT,
    blocked_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id, worker_id)
  );

  `);

  try {
    await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_leaderboard_channel_region ON leaderboard_messages(guild_id, channel_id, region)');
  } catch (e) {
    void e;
  }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_invite_snapshots_guild ON invite_snapshots(guild_id)');
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
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_recruits_guild_recruiter_valid_created ON recruits(guild_id, recruiter_id, valid, created_at)');
  } catch (e) {
    void e;
  }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_recruits_guild_valid_created ON recruits(guild_id, valid, created_at)');
  } catch (e) {
    void e;
  }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_recruits_recruited_valid ON recruits(recruited_id, valid)');
  } catch (e) {
    void e;
  }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_weekly_recruit_overrides_guild_week ON weekly_recruit_overrides(guild_id, week_start)');
  } catch (e) {
    void e;
  }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_dm_campaigns_status ON dm_campaigns(status, report_posted, updated_at)');
  } catch (e) {
    void e;
  }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_dm_targets_claim ON dm_campaign_targets(status, assigned_worker_id, next_attempt_at, batch_no, id)');
  } catch (e) {
    void e;
  }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_dm_targets_campaign_status ON dm_campaign_targets(campaign_id, status)');
  } catch (e) {
    void e;
  }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_dm_attempts_campaign_created ON dm_delivery_attempts(campaign_id, created_at)');
  } catch (e) {
    void e;
  }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_dm_blocks_user_worker ON dm_worker_user_blocks(guild_id, user_id, worker_id)');
  } catch (e) {
    void e;
  }
  
  // Hardening: Added missing indices for batched performance (Phase 3)
  try {
    await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_weekly_calc_lookup ON weekly_calculations(guild_id, recruiter_id, week_start)');
  } catch (e) { void e; }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_warnings_recruiter_active ON warnings(guild_id, recruiter_id, revoked, expired_at)');
  } catch (e) { void e; }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_verifications_bulk ON verifications(guild_id, recruiter_id, recruited_id, verified_at)');
  } catch (e) { void e; }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_absences_active_lookup ON absences(guild_id, recruiter_id, active, end_date)');
  } catch (e) { void e; }
  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_role_changes_staff_lookup ON analytics_role_changes(guild_id, user_id, action, role_id, created_at)');
  } catch (e) { void e; }

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
      throw err;
    }
  };

  await applyMigration('2026-02-06-recruiter-triggers', async () => {
    await db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_recruits_recruiter_row
      AFTER INSERT ON recruits
      BEGIN
        INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base)
        VALUES (NEW.guild_id, NEW.recruiter_id, 0, 0, 0, 4);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_warnings_recruiter_row
      AFTER INSERT ON warnings
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

  await applyMigration('2026-02-07-guild-columns', async () => {
    const defaultGuild = DEFAULT_GUILD_ID;
    const addGuildColumn = async (table) => {
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
  });

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

      CREATE TRIGGER IF NOT EXISTS trg_warnings_recruiter_row
      AFTER INSERT ON warnings
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

  await applyMigration('2026-02-14-recruits-performance-indexes', async () => {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_recruits_guild_recruiter_valid_created ON recruits(guild_id, recruiter_id, valid, created_at)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_recruits_guild_valid_created ON recruits(guild_id, valid, created_at)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_recruits_recruited_valid ON recruits(recruited_id, valid)');
  });

  await applyMigration('2026-02-26-recruits-unique-index-scope', async () => {
    // Unify recruit uniqueness to guild scope and remove legacy index variants.
    await db.exec('DROP INDEX IF EXISTS uniq_recruit');
    await db.exec('DROP INDEX IF EXISTS uniq_recruit_guild');
    await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_recruit ON recruits(guild_id, recruited_id)');
  });

  await applyMigration('2026-03-02-dm-worker-queue', async () => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS dm_workers (
        worker_id TEXT PRIMARY KEY,
        display_name TEXT,
        enabled INTEGER DEFAULT 1,
        weight INTEGER DEFAULT 1,
        started_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        status TEXT DEFAULT 'online',
        meta_json TEXT
      );

      CREATE TABLE IF NOT EXISTS dm_campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        message_type TEXT NOT NULL,
        message_body TEXT NOT NULL,
        target_mode TEXT NOT NULL,
        target_role_ids TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        report_channel_id TEXT,
        requested_channel_id TEXT,
        total_targets INTEGER DEFAULT 0,
        total_batches INTEGER DEFAULT 0,
        total_sent INTEGER DEFAULT 0,
        total_failed INTEGER DEFAULT 0,
        total_blocked INTEGER DEFAULT 0,
        total_undeliverable INTEGER DEFAULT 0,
        total_retries INTEGER DEFAULT 0,
        started_at INTEGER,
        finished_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        report_posted INTEGER DEFAULT 0,
        report_posted_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS dm_campaign_targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        assigned_worker_id TEXT,
        batch_no INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        retries INTEGER DEFAULT 0,
        last_attempt_at INTEGER,
        next_attempt_at INTEGER,
        last_error_code TEXT,
        last_error_message TEXT,
        blocked_by_worker_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (campaign_id) REFERENCES dm_campaigns(id) ON DELETE CASCADE,
        UNIQUE (campaign_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS dm_delivery_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        result TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (campaign_id) REFERENCES dm_campaigns(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES dm_campaign_targets(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS dm_user_affinity (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        preferred_worker_id TEXT,
        preferred_worker_last_dm_at INTEGER,
        consecutive_misc_count INTEGER DEFAULT 0,
        war_worker_id TEXT,
        war_last_dm_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS dm_worker_user_blocks (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        reason TEXT,
        error_code TEXT,
        blocked_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id, worker_id)
      );
    `);

    await db.exec('CREATE INDEX IF NOT EXISTS idx_dm_campaigns_status ON dm_campaigns(status, report_posted, updated_at)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_dm_targets_claim ON dm_campaign_targets(status, assigned_worker_id, next_attempt_at, batch_no, id)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_dm_targets_campaign_status ON dm_campaign_targets(campaign_id, status)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_dm_attempts_campaign_created ON dm_delivery_attempts(campaign_id, created_at)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_dm_blocks_user_worker ON dm_worker_user_blocks(guild_id, user_id, worker_id)');
  });

  await applyMigration('2026-03-02-dm-queue-columns', async () => {
    const alter = async (sql) => { try { await db.exec(sql); } catch (e) { void e; } };

    // dm_campaign_targets: claim lease + worker tracking
    await alter('ALTER TABLE dm_campaign_targets ADD COLUMN message_type TEXT');
    await alter('ALTER TABLE dm_campaign_targets ADD COLUMN claim_expires_at INTEGER');
    await alter('ALTER TABLE dm_campaign_targets ADD COLUMN last_worker_id TEXT');
    await alter('ALTER TABLE dm_campaign_targets ADD COLUMN worker_switches INTEGER DEFAULT 0');

    // dm_user_affinity: extra tracking
    await alter('ALTER TABLE dm_user_affinity ADD COLUMN last_message_type TEXT');
    await alter('ALTER TABLE dm_user_affinity ADD COLUMN last_dm_at INTEGER');

    // dm_campaigns: config overrides
    await alter('ALTER TABLE dm_campaigns ADD COLUMN created_by_bot_id TEXT');
    await alter('ALTER TABLE dm_campaigns ADD COLUMN strict_war_sticky INTEGER DEFAULT 1');
    await alter('ALTER TABLE dm_campaigns ADD COLUMN max_misc_streak INTEGER DEFAULT 4');
    await alter('ALTER TABLE dm_campaigns ADD COLUMN sticky_window_hours INTEGER DEFAULT 24');

    // Optimized indexes
    await alter('CREATE INDEX IF NOT EXISTS idx_dm_targets_pending_claim ON dm_campaign_targets(status, next_attempt_at, claim_expires_at, id)');
    await alter('CREATE INDEX IF NOT EXISTS idx_dm_affinity_lookup ON dm_user_affinity(guild_id, user_id)');
  });

  await applyMigration('2026-03-31-dm-claim-id', async () => {
    const alter = async (sql) => { try { await db.exec(sql); } catch (e) { void e; } };
    // claim_id column used by dm-worker.js for atomic batch claiming
    await alter('ALTER TABLE dm_campaign_targets ADD COLUMN claim_id TEXT');
    await alter('CREATE INDEX IF NOT EXISTS idx_dm_targets_claim_id ON dm_campaign_targets(claim_id)');
  });

  // Component 10 — dm_queue defensive migration
  // The committed HEAD of recruit.js had 'INSERT INTO dm_queue' (scope: command.recruit.queueWelcomeDm)
  // which caused CMD-500 AECS errors on every /recruit invocation because the table was never created.
  // The working tree already sends welcome DMs directly via member.send() — this migration is defensive:
  // it ensures the table exists so any old-code-path deployments don't crash before the new code lands.
  await applyMigration('2026-04-01-dm-queue', async () => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS dm_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        processed_at INTEGER,
        error TEXT
      )
    `);
    await db.exec('CREATE INDEX IF NOT EXISTS idx_dm_queue_status ON dm_queue(status, created_at)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_dm_queue_guild_user ON dm_queue(guild_id, user_id)');
  });

  // R-02: Only retry on transient SQLite busy/lock errors. Any other error (table not found, syntax)
  // should rethrow immediately — retrying 10×1s delays startup and masks the real misconfiguration.
  async function ensureColumnWithRetry(table, colDef) {
    for (let i = 0; i < 3; i++) {
      try {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
        return;
      } catch (e) {
        if (e && e.message && e.message.includes('duplicate column name')) return; // already added, done
        const isTransient = e && e.message && (
          e.message.includes('database is locked') ||
          e.message.includes('SQLITE_BUSY')
        );
        if (!isTransient) {
          // Non-transient error — rethrow immediately instead of retrying 10×1s.
          console.error(`[ensureColumnWithRetry] Non-retryable error on ${table}.${colDef}:`, e.message);
          throw e;
        }
        if (i === 2) throw e; // exhausted retries
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  await ensureColumnWithRetry('recruiters', 'promoted INTEGER DEFAULT 0');
  await ensureColumnWithRetry('recruiters', 'channel_base INTEGER DEFAULT 4');
  await ensureColumnWithRetry('flags', 'dismissed INTEGER DEFAULT 0');
  await ensureColumnWithRetry('recruits', 'points INTEGER DEFAULT 0');
  await ensureColumnWithRetry('warnings', 'expired_at INTEGER');
  await ensureColumnWithRetry('warnings', 'revoked INTEGER DEFAULT 0');
  await ensureColumnWithRetry('weekly_calculations', 'week_start INTEGER');
  await ensureColumnWithRetry('weekly_calculations', 'absent INTEGER DEFAULT 0');
  await ensureColumnWithRetry('weekly_calculations', 'verify_rate REAL DEFAULT 0');
  await ensureColumnWithRetry('dm_campaigns', 'message_hash TEXT');
  await ensureColumnWithRetry('dm_campaigns', 'last_notified_percentage INTEGER DEFAULT 0');
  await ensureColumnWithRetry('dm_campaigns', 'report_attempts INTEGER DEFAULT 0');
  await ensureColumnWithRetry('dm_cancellations', 'campaign_id INTEGER');

  try { await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_weekly_calc_recruiter_week ON weekly_calculations(guild_id, recruiter_id, week_start)'); } catch (e) { void e; }
  try { await db.exec('CREATE TABLE IF NOT EXISTS weekly_recruit_overrides (guild_id TEXT NOT NULL, recruiter_id TEXT NOT NULL, week_start INTEGER NOT NULL, total INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, note TEXT, PRIMARY KEY (guild_id, recruiter_id, week_start))'); } catch (e) { void e; }
  try { await db.exec('CREATE INDEX IF NOT EXISTS idx_weekly_recruit_overrides_guild_week ON weekly_recruit_overrides(guild_id, week_start)'); } catch (e) { void e; }
  try { await db.exec("CREATE TABLE IF NOT EXISTS multipliers (id INTEGER PRIMARY KEY AUTOINCREMENT, recruiter_id TEXT NOT NULL, value REAL NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)"); } catch (e) { void e; }
  await ensureColumnWithRetry('analytics_daily_channels', 'day_ts INTEGER');
  await ensureColumnWithRetry('analytics_daily_channel_speakers', 'day_ts INTEGER');
  await ensureColumnWithRetry('analytics_daily_guild', 'day_ts INTEGER');
  await ensureColumnWithRetry('analytics_daily_guild_speakers', 'day_ts INTEGER');
  await ensureColumnWithRetry('analytics_voice_daily', 'day_ts INTEGER');
  await ensureColumnWithRetry('analytics_user_daily_messages', 'day_ts INTEGER');

  // Z-02: This migration has an empty body — it exists purely as a schema version marker.
  // It signals that the "protect points reset" migration was applied, preventing older code
  // from running a destructive data reset on startup. Do not remove this entry.
  await applyMigration('2026-03-03-protect-points-reset', async () => { });

  await runIntegrityChecks(db, 'startup');

  return db;
}

let dbPromise = null;
let dbInitError = null;

function ensureDbPromise() {
  if (!dbPromise) {
    dbPromise = init().catch((err) => {
      dbInitError = err instanceof Error ? err : new Error(String(err));
      console.error('Database initialization failed', { dbPath: DB_PATH, error: dbInitError });
      throw dbInitError;
    });
  }
  return dbPromise;
}

async function getDbOrThrow() {
  const db = await ensureDbPromise();
  if (db) return db;
  throw (dbInitError || new Error('Database initialization failed'));
}

module.exports = {
  DB_PATH,
  get: async (sql, ...params) => (await getDbOrThrow()).get(sql, ...params),
  all: async (sql, ...params) => (await getDbOrThrow()).all(sql, ...params),
  run: async (sql, ...params) => (await getDbOrThrow()).run(sql, ...params),
  exec: async (sql) => (await getDbOrThrow()).exec(sql),
  close: async () => {
    if (!dbPromise) return;
    const db = await dbPromise;
    if (db && typeof db.close === 'function') {
      await db.close();
    }
    dbPromise = null;
    dbInitError = null;
  },
  checkIntegrity: async (label) => runIntegrityChecks(await getDbOrThrow(), label || 'manual'),
  // prepare returns object with async helpers to ease migration
  prepare: (sql) => ({
    get: async (...params) => (await getDbOrThrow()).get(sql, ...params),
    all: async (...params) => (await getDbOrThrow()).all(sql, ...params),
    run: async (...params) => (await getDbOrThrow()).run(sql, ...params),
  })
};
