const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'recruiter.db');

async function main() {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  // Preload multipliers to allow per-recruit lookup
  const multipliers = await db.all('SELECT recruiter_id, value, created_at, expires_at FROM multipliers ORDER BY recruiter_id, created_at');
  const multByRecruiter = new Map();
  for (const m of multipliers) {
    if (!multByRecruiter.has(m.recruiter_id)) multByRecruiter.set(m.recruiter_id, []);
    multByRecruiter.get(m.recruiter_id).push(m);
  }

  const recruits = await db.all('SELECT id, recruiter_id, created_at, valid FROM recruits');

  const earnedByRecruiter = new Map();

  await db.run('BEGIN TRANSACTION');
  try {
    // Reset all recruit points; we recompute valid ones below
    await db.run('UPDATE recruits SET points = 0');

    for (const r of recruits) {
      if (!r.valid) continue;

      const ms = r.created_at;
      const mults = multByRecruiter.get(r.recruiter_id) || [];
      let multiplierValue = 1.0;

      // choose the highest active multiplier at the time of this recruit
      for (const m of mults) {
        if (m.created_at <= ms && ms < m.expires_at) {
          if (typeof m.value === 'number' && m.value > multiplierValue) multiplierValue = m.value;
        }
      }

      const points = Math.floor(1 * (multiplierValue || 1.0));
      await db.run('UPDATE recruits SET points = ? WHERE id = ?', points, r.id);

      earnedByRecruiter.set(r.recruiter_id, (earnedByRecruiter.get(r.recruiter_id) || 0) + points);
    }

    // Subtract recorded purchases to keep balances consistent with "earned - spent"
    const purchases = await db.all('SELECT recruiter_id, SUM(cost) AS spent FROM purchases GROUP BY recruiter_id');
    const spentByRecruiter = new Map();
    for (const p of purchases) {
      spentByRecruiter.set(p.recruiter_id, p.spent || 0);
    }

    // Rebuild recruiters.points from scratch
    await db.run('UPDATE recruiters SET points = 0');
    for (const [recruiterId, earned] of earnedByRecruiter.entries()) {
      const spent = spentByRecruiter.get(recruiterId) || 0;
      const newBalance = Math.max(0, Math.floor((earned || 0) - (spent || 0)));
      await db.run('INSERT OR IGNORE INTO recruiters (id, points, warnings, promoted, channel_base) VALUES (?, 0, 0, 0, 4)', recruiterId);
      await db.run('UPDATE recruiters SET points = ? WHERE id = ?', newBalance, recruiterId);
    }

    await db.run('COMMIT');
  } catch (e) {
    await db.run('ROLLBACK');
    throw e;
  } finally {
    await db.close();
  }

  console.log('Done. Recalculated recruits.points and recruiters.points using 1 point per valid recruit (multiplier-only), minus purchases.');
}

main().catch((e) => {
  console.error('Failed to recalculate points:', e);
  process.exit(1);
});
