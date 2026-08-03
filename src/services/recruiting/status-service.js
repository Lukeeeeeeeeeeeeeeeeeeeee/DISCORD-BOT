const fs = require('fs/promises');
const path = require('path');
const recruitsRepo = require('../../repos/recruits-repo');
const recruitersRepo = require('../../repos/recruiters-repo');

async function getStatusData({ db, guildId }) {
  const DB_PATH = process.env.DATABASE_PATH || './data/recruiter.db';
  let dbSize = 'N/A';
  try {
    const s = await fs.stat(DB_PATH);
    dbSize = `${Math.round(s.size / 1024)} KB`;
  } catch (e) { console.error(e); }

  const backupsDir = path.join(path.dirname(DB_PATH), 'backups');
  let lastBackup = 'None';
  try {
    const dbExt = path.extname(DB_PATH) || '.db';
    const files = await fs.readdir(backupsDir);
    const candidates = files.filter(f => f.endsWith(dbExt));
    if (candidates.length) {
      const stats = await Promise.all(
        candidates.map(async f => ({ f, t: (await fs.stat(path.join(backupsDir, f))).mtime.getTime() }))
      );
      stats.sort((a, b) => b.t - a.t);
      lastBackup = stats[0].f;
    }
  } catch (e) { console.error(e); }

  const recruits = await recruitsRepo.countAll(db, guildId);
  const recruiters = await recruitersRepo.countAll(db, guildId);
  const uptime = `${Math.round(process.uptime())}s`;

  return { dbSize, lastBackup, recruits, recruiters, uptime };
}

module.exports = { getStatusData };

