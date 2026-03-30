const db = require('../db_async');
const { GUILD_ID } = require('../constants');

async function tableHasColumn(tableName, columnName) {
  try {
    const rows = await db.all(`PRAGMA table_info(${tableName})`);
    return (rows || []).some(row => row && row.name === columnName);
  } catch (_error) {
    return false;
  }
}

async function createInviteTables() {
  try {
    console.log('Creating recruiter invite tables...');
    const defaultGuildId = process.env.GUILD_ID || GUILD_ID || 'GLOBAL';
    const escapedDefaultGuildId = String(defaultGuildId).replace(/'/g, "''");

    await db.run(`
      CREATE TABLE IF NOT EXISTS recruiter_invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        recruiter_id TEXT NOT NULL,
        invite_code TEXT NOT NULL,
        invite_url TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used INTEGER DEFAULT 0,
        used_at INTEGER NULL,
        used_by TEXT NULL,
        UNIQUE(guild_id, invite_code)
      )
    `);

    if (!(await tableHasColumn('recruiter_invites', 'guild_id'))) {
      await db.run('ALTER TABLE recruiter_invites ADD COLUMN guild_id TEXT');
    }
    await db.run(
      'UPDATE recruiter_invites SET guild_id = ? WHERE guild_id IS NULL OR TRIM(COALESCE(guild_id, "")) = ""',
      defaultGuildId
    );
    await db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_recruiter_invites_default_guild
      AFTER INSERT ON recruiter_invites
      WHEN NEW.guild_id IS NULL OR TRIM(COALESCE(NEW.guild_id, '')) = ''
      BEGIN
        UPDATE recruiter_invites
        SET guild_id = '${escapedDefaultGuildId}'
        WHERE id = NEW.id;
      END
    `);

    await db.run('CREATE INDEX IF NOT EXISTS idx_recruiter_invites_guild_recruiter ON recruiter_invites (guild_id, recruiter_id)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_recruiter_invites_guild_code ON recruiter_invites (guild_id, invite_code)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_recruiter_invites_expires_at ON recruiter_invites (expires_at)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_recruiter_invites_used ON recruiter_invites (used)');
    await db.run('CREATE UNIQUE INDEX IF NOT EXISTS uniq_recruiter_invites_guild_code ON recruiter_invites (guild_id, invite_code)');

    // --- DM Worker Fleet Tables ---
    await db.run(`
      CREATE TABLE IF NOT EXISTS dm_workers (
        worker_id TEXT PRIMARY KEY,
        display_name TEXT,
        enabled INTEGER DEFAULT 1,
        weight INTEGER DEFAULT 1,
        started_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        status TEXT DEFAULT 'online',
        meta_json TEXT
      )
    `);

    await db.run(`
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
      )
    `);

    await db.run(`
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
      )
    `);

    await db.run(`
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
      )
    `);

    await db.run('CREATE INDEX IF NOT EXISTS idx_dm_campaigns_status ON dm_campaigns(status, report_posted, updated_at)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_dm_targets_claim ON dm_campaign_targets(status, assigned_worker_id, next_attempt_at, batch_no, id)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_dm_targets_campaign_status ON dm_campaign_targets(campaign_id, status)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_dm_attempts_campaign_created ON dm_delivery_attempts(campaign_id, created_at)');

    console.log('Recruiter invite tables created successfully');
  } catch (error) {
    console.error('Error creating invite tables:', error);
    throw error;
  }
}

module.exports = { createInviteTables };
