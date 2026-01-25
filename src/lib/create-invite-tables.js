const db = require('../db_async');

async function createInviteTables() {
  try {
    console.log('🔗 Creating recruiter invite tables...');
    
    // Create recruiter_invites table
    await db.run(`
      CREATE TABLE IF NOT EXISTS recruiter_invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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

    // Create indexes separately
    await db.run('CREATE INDEX IF NOT EXISTS idx_recruiter_id ON recruiter_invites (recruiter_id)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_invite_code ON recruiter_invites (invite_code)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_expires_at ON recruiter_invites (expires_at)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_used ON recruiter_invites (used)');

    console.log('✅ Recruiter invite tables created successfully');
    
  } catch (error) {
    console.error('❌ Error creating invite tables:', error);
    throw error;
  }
}

module.exports = { createInviteTables };
