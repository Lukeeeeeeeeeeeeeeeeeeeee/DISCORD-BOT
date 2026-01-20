const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'recruiter.db');
const backupsDir = path.join(path.dirname(DB_PATH), 'backups');
if (!fs.existsSync(DB_PATH)) {
  console.error('DB not found at', DB_PATH);
  process.exit(1);
}
if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
const now = new Date();
const ts = now.toISOString().replace(/[:.]/g, '-');
const dest = path.join(backupsDir, `recruiter-${ts}.db`);
fs.copyFileSync(DB_PATH, dest);
console.log('Backup created at', dest);
