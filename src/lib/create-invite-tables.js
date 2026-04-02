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

    console.log('Recruiter invite tables created successfully');
  } catch (error) {
    console.error('Error creating invite tables:', error);
    throw error;
  }
}

module.exports = { createInviteTables };
