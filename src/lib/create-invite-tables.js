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
        used_by TEXT NULL,
        INDEX idx_recruiter_id (recruiter_id),
        INDEX idx_invite_code (invite_code),
        INDEX idx_expires_at (expires_at),
        INDEX idx_used (used)
      )
    `);

    console.log('✅ Recruiter invite tables created successfully');
    
  } catch (error) {
    console.error('❌ Error creating invite tables:', error);
    throw error;
  }
}

module.exports = { createInviteTables };
