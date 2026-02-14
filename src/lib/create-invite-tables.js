const db = require('../db_async');
const { resolveGuildId } = require('./guild');

async function hasColumn(table, column) {
  try {
    const info = await db.all(`PRAGMA table_info(${table})`);
    return (info || []).some(row => row && row.name === column);
  } catch (e) {
    return false;
  }
}

async function createInviteTables() {
  try {
    console.log('?? Creating recruiter invite tables...');

    await db.exec('BEGIN IMMEDIATE');
    try {
      await db.run(`
        CREATE TABLE IF NOT EXISTS recruiter_invites (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          recruiter_id TEXT NOT NULL,
          invite_code TEXT NOT NULL UNIQUE,
          invite_url TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          used INTEGER DEFAULT 0,
          used_at INTEGER NULL,
          used_by TEXT NULL
        )
      `);

      // Backfill guild_id if this table existed before we added it.
      if (!(await hasColumn('recruiter_invites', 'guild_id'))) {
        try {
          await db.exec('ALTER TABLE recruiter_invites ADD COLUMN guild_id TEXT');
        } catch (alterErr) {
          const msg = String((alterErr && alterErr.message) || '').toLowerCase();
          if (!msg.includes('duplicate column name')) throw alterErr;
        }
      }
      const defaultGuildId = resolveGuildId() || 'GLOBAL';
      await db.run('UPDATE recruiter_invites SET guild_id = ? WHERE guild_id IS NULL', defaultGuildId);

      await db.run('CREATE INDEX IF NOT EXISTS idx_recruiter_invites_guild ON recruiter_invites (guild_id)');
      await db.run('CREATE INDEX IF NOT EXISTS idx_recruiter_invites_recruiter ON recruiter_invites (guild_id, recruiter_id)');
      await db.run('CREATE INDEX IF NOT EXISTS idx_recruiter_id ON recruiter_invites (recruiter_id)');
      await db.run('CREATE INDEX IF NOT EXISTS idx_invite_code ON recruiter_invites (invite_code)');
      await db.run('CREATE INDEX IF NOT EXISTS idx_expires_at ON recruiter_invites (expires_at)');
      await db.run('CREATE INDEX IF NOT EXISTS idx_used ON recruiter_invites (used)');
      await db.exec('COMMIT');
    } catch (innerError) {
      try { await db.exec('ROLLBACK'); } catch (rollbackErr) { void rollbackErr; }
      throw innerError;
    }

    console.log('? Recruiter invite tables created successfully');

  } catch (error) {
    console.error('? Error creating invite tables:', error);
    throw error;
  }
}

module.exports = { createInviteTables };
