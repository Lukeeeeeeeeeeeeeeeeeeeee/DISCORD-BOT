const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'recruiter.db');
const DB_PATH = path.resolve(process.env.DATABASE_PATH || DEFAULT_DB_PATH);
const TARGET_GUILD_ID = process.env.GUILD_ID || process.env.TARGET_GUILD_ID || null;
const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = Number.parseInt(process.env.RECALCULATE_BATCH_SIZE || '200', 10);

function isTruthy(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

async function tableHasColumn(db, tableName, columnName) {
  const rows = await db.all(`PRAGMA table_info(${tableName})`);
  return (rows || []).some(row => row && row.name === columnName);
}

function chunkArray(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function applyRecruitPointBatches(db, rows, hasGuildId) {
  if (!rows.length) return;
  const chunks = chunkArray(rows, Math.max(25, BATCH_SIZE));
  for (const chunk of chunks) {
    const caseParts = [];
    const inParts = [];
    const params = [];
    for (const row of chunk) {
      caseParts.push('WHEN ? THEN ?');
      params.push(row.id, row.points);
      inParts.push('?');
    }
    const whereParams = chunk.map(row => row.id);
    const sql = hasGuildId
      ? `UPDATE recruits
         SET points = CASE id ${caseParts.join(' ')} ELSE points END
         WHERE guild_id = ? AND id IN (${inParts.join(', ')})`
      : `UPDATE recruits
         SET points = CASE id ${caseParts.join(' ')} ELSE points END
         WHERE id IN (${inParts.join(', ')})`;

    if (hasGuildId) {
      await db.run(sql, ...params, TARGET_GUILD_ID, ...whereParams);
    } else {
      await db.run(sql, ...params, ...whereParams);
    }
  }
}

async function seedRecruitersIfMissing(db, recruiterIds, hasGuildId) {
  if (!recruiterIds.length) return;
  const chunks = chunkArray(recruiterIds, Math.max(25, BATCH_SIZE));
  for (const chunk of chunks) {
    if (hasGuildId) {
      const values = chunk.map(() => '(?, ?, 0, 0, 0, 4)').join(', ');
      const params = [];
      for (const recruiterId of chunk) {
        params.push(TARGET_GUILD_ID, recruiterId);
      }
      await db.run(
        `INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES ${values}`,
        ...params
      );
      continue;
    }

    const values = chunk.map(() => '(?, 0, 0, 0, 4)').join(', ');
    await db.run(
      `INSERT OR IGNORE INTO recruiters (id, points, warnings, promoted, channel_base) VALUES ${values}`,
      ...chunk
    );
  }
}

async function applyRecruiterBalanceBatches(db, balances, hasGuildId) {
  if (!balances.length) return;
  const chunks = chunkArray(balances, Math.max(25, BATCH_SIZE));
  for (const chunk of chunks) {
    const caseParts = [];
    const inParts = [];
    const params = [];
    for (const row of chunk) {
      caseParts.push('WHEN ? THEN ?');
      params.push(row.recruiterId, row.balance);
      inParts.push('?');
    }
    const whereParams = chunk.map(row => row.recruiterId);
    const sql = hasGuildId
      ? `UPDATE recruiters
         SET points = CASE id ${caseParts.join(' ')} ELSE points END
         WHERE guild_id = ? AND id IN (${inParts.join(', ')})`
      : `UPDATE recruiters
         SET points = CASE id ${caseParts.join(' ')} ELSE points END
         WHERE id IN (${inParts.join(', ')})`;

    if (hasGuildId) {
      await db.run(sql, ...params, TARGET_GUILD_ID, ...whereParams);
    } else {
      await db.run(sql, ...params, ...whereParams);
    }
  }
}

async function main() {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });

  try {
    const recruitsHasGuildId = await tableHasColumn(db, 'recruits', 'guild_id');
    const recruitersHasGuildId = await tableHasColumn(db, 'recruiters', 'guild_id');
    const purchasesHasGuildId = await tableHasColumn(db, 'purchases', 'guild_id');

    if ((recruitsHasGuildId || recruitersHasGuildId || purchasesHasGuildId) && !TARGET_GUILD_ID) {
      throw new Error('GUILD_ID (or TARGET_GUILD_ID) is required for guild-scoped schemas.');
    }

    const multiplierWhere = recruitsHasGuildId ? 'WHERE guild_id = ?' : '';
    const recruitWhere = recruitsHasGuildId ? 'WHERE guild_id = ?' : '';
    const purchaseWhere = purchasesHasGuildId ? 'WHERE guild_id = ?' : '';

    const multipliers = recruitsHasGuildId
      ? await db.all(
        `SELECT recruiter_id, value, created_at, expires_at
         FROM multipliers ${multiplierWhere}
         ORDER BY recruiter_id, created_at`,
        TARGET_GUILD_ID
      )
      : await db.all(
        `SELECT recruiter_id, value, created_at, expires_at
         FROM multipliers ${multiplierWhere}
         ORDER BY recruiter_id, created_at`
      );

    const multByRecruiter = new Map();
    for (const m of multipliers || []) {
      if (!m || !m.recruiter_id) continue;
      if (!multByRecruiter.has(m.recruiter_id)) multByRecruiter.set(m.recruiter_id, []);
      multByRecruiter.get(m.recruiter_id).push(m);
    }

    const recruits = recruitsHasGuildId
      ? await db.all(
        `SELECT id, recruiter_id, created_at, valid
         FROM recruits ${recruitWhere}`,
        TARGET_GUILD_ID
      )
      : await db.all(
        `SELECT id, recruiter_id, created_at, valid
         FROM recruits ${recruitWhere}`
      );

    const earnedByRecruiter = new Map();
    const recruitPointRows = [];

    for (const r of recruits || []) {
      if (!r || !r.id || !isTruthy(r.valid)) continue;
      const mults = multByRecruiter.get(r.recruiter_id) || [];
      const createdAt = Number(r.created_at || 0);
      let multiplierValue = 1.0;

      for (const m of mults) {
        const start = Number(m.created_at || 0);
        const end = Number(m.expires_at || 0);
        const value = Number(m.value || 1);
        if (start <= createdAt && createdAt < end && Number.isFinite(value) && value > multiplierValue) {
          multiplierValue = value;
        }
      }

      const points = Math.max(0, Math.floor(1 * multiplierValue));
      recruitPointRows.push({ id: r.id, points });
      earnedByRecruiter.set(r.recruiter_id, (earnedByRecruiter.get(r.recruiter_id) || 0) + points);
    }

    const purchases = purchasesHasGuildId
      ? await db.all(
        `SELECT recruiter_id, SUM(cost) AS spent FROM purchases ${purchaseWhere} GROUP BY recruiter_id`,
        TARGET_GUILD_ID
      )
      : await db.all(
        `SELECT recruiter_id, SUM(cost) AS spent FROM purchases ${purchaseWhere} GROUP BY recruiter_id`
      );

    const spentByRecruiter = new Map();
    for (const p of purchases || []) {
      if (!p || !p.recruiter_id) continue;
      spentByRecruiter.set(p.recruiter_id, Number(p.spent || 0));
    }

    const recruiterBalances = [];
    for (const [recruiterId, earned] of earnedByRecruiter.entries()) {
      const spent = spentByRecruiter.get(recruiterId) || 0;
      recruiterBalances.push({
        recruiterId,
        balance: Math.max(0, Math.floor((earned || 0) - (spent || 0)))
      });
    }

    if (DRY_RUN) {
      console.log('Dry run complete.');
      console.log(JSON.stringify({
        dbPath: DB_PATH,
        guildId: TARGET_GUILD_ID || null,
        recruitsScanned: recruits.length,
        recruitPointUpdates: recruitPointRows.length,
        recruiterBalances: recruiterBalances.length
      }, null, 2));
      return;
    }

    await db.run('BEGIN IMMEDIATE');
    try {
      if (recruitsHasGuildId) {
        await db.run('UPDATE recruits SET points = 0 WHERE guild_id = ?', TARGET_GUILD_ID);
      } else {
        await db.run('UPDATE recruits SET points = 0');
      }
      await applyRecruitPointBatches(db, recruitPointRows, recruitsHasGuildId);

      if (recruitersHasGuildId) {
        await db.run('UPDATE recruiters SET points = 0 WHERE guild_id = ?', TARGET_GUILD_ID);
      } else {
        await db.run('UPDATE recruiters SET points = 0');
      }

      await seedRecruitersIfMissing(db, recruiterBalances.map(r => r.recruiterId), recruitersHasGuildId);
      await applyRecruiterBalanceBatches(db, recruiterBalances, recruitersHasGuildId);

      await db.run('COMMIT');
    } catch (error) {
      await db.run('ROLLBACK');
      throw error;
    }

    console.log('Done. Recalculated recruits.points and recruiters.points (earned from valid recruits minus purchases).');
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error('Failed to recalculate points:', e);
  process.exit(1);
});
