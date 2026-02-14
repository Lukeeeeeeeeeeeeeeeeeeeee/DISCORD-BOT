const RECRUITER_RELATIONS = [
  { table: 'recruits', column: 'recruiter_id', required: true },
  { table: 'warnings', column: 'recruiter_id', required: true },
  { table: 'multipliers', column: 'recruiter_id', required: true },
  { table: 'purchases', column: 'recruiter_id', required: true },
  { table: 'weekly_calculations', column: 'recruiter_id', required: true },
  { table: 'trial_fast_track', column: 'recruiter_id', required: true },
  { table: 'absences', column: 'recruiter_id', required: true },
  { table: 'verifications', column: 'recruiter_id', required: false }
];

async function tableExists(db, table) {
  const row = await db.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    table
  );
  return !!row;
}

async function tableColumns(db, table) {
  const rows = await db.all(`PRAGMA table_info(${table})`);
  return new Set((rows || []).map(row => String(row.name || '')));
}

async function countMissingRecruiterRefs(db, table, column) {
  const sql = `
    SELECT COUNT(1) AS c
    FROM ${table} t
    LEFT JOIN recruiters r
      ON r.guild_id = t.guild_id
      AND r.id = t.${column}
    WHERE t.${column} IS NOT NULL
      AND TRIM(t.${column}) <> ''
      AND r.id IS NULL
  `;
  const row = await db.get(sql);
  return row && Number.isFinite(Number(row.c)) ? Number(row.c) : 0;
}

async function collectMissingRecruiters(db, table, column) {
  const sql = `
    SELECT t.guild_id AS guild_id, t.${column} AS recruiter_id
    FROM ${table} t
    LEFT JOIN recruiters r
      ON r.guild_id = t.guild_id
      AND r.id = t.${column}
    WHERE t.${column} IS NOT NULL
      AND TRIM(t.${column}) <> ''
      AND t.guild_id IS NOT NULL
      AND TRIM(t.guild_id) <> ''
      AND r.id IS NULL
    GROUP BY t.guild_id, t.${column}
  `;
  return db.all(sql);
}

async function insertMissingRecruiters(db, rows) {
  if (!rows || !rows.length) return 0;
  let inserted = 0;
  for (const row of rows) {
    const guildId = row && row.guild_id ? String(row.guild_id) : '';
    const recruiterId = row && row.recruiter_id ? String(row.recruiter_id) : '';
    if (!guildId || !recruiterId) continue;
    await db.run(
      'INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, 0, 0, 0, 4)',
      guildId,
      recruiterId
    );
    inserted += 1;
  }
  return inserted;
}

async function removeMalformedRows(db, table, column) {
  const result = await db.run(
    `DELETE FROM ${table}
     WHERE ${column} IS NULL
        OR TRIM(${column}) = ''
        OR guild_id IS NULL
        OR TRIM(guild_id) = ''`
  );
  if (!result || typeof result.changes !== 'number') return 0;
  return result.changes;
}

async function runReferentialPreflight(db, opts = {}) {
  const fix = opts.fix !== false;
  const log = opts.log !== false;
  const summary = {
    fix,
    checked: [],
    insertedRecruiters: 0,
    removedMalformedRows: 0,
    unresolved: []
  };

  for (const relation of RECRUITER_RELATIONS) {
    const { table, column, required } = relation;
    if (!(await tableExists(db, table))) continue;
    const cols = await tableColumns(db, table);
    if (!cols.has('guild_id') || !cols.has(column)) continue;

    let missingBefore = await countMissingRecruiterRefs(db, table, column);
    let removedRows = 0;
    let insertedRows = 0;

    if (fix) {
      if (required) {
        removedRows = await removeMalformedRows(db, table, column);
        summary.removedMalformedRows += removedRows;
      }

      const missingRows = await collectMissingRecruiters(db, table, column);
      insertedRows = await insertMissingRecruiters(db, missingRows);
      summary.insertedRecruiters += insertedRows;
    }

    const missingAfter = await countMissingRecruiterRefs(db, table, column);
    if (missingAfter > 0) {
      summary.unresolved.push({ table, column, count: missingAfter });
    }

    summary.checked.push({
      table,
      column,
      required,
      missingBefore,
      missingAfter,
      insertedRows,
      removedRows
    });
  }

  if (log) {
    console.log('Referential preflight summary', summary);
  }

  return summary;
}

module.exports = { runReferentialPreflight };
