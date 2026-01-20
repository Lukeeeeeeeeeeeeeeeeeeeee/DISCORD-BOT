// Backwards-compatible alias for the async DB implementation
// Synchronously ensure DB path exists (so tests that require this module see the file immediately)
const fs = require('fs');
const path = require('path');
const DB_PATH = process.env.DATABASE_PATH || './data/recruiter.db';
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
try {
  // touch file (create if missing)
  fs.closeSync(fs.openSync(DB_PATH, 'a'));
} catch (e) {
  // ignore
}

// NOTE: For actual DB operations use the async API
module.exports = require('./db_async');