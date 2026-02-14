#!/usr/bin/env node
const db = require('../src/db_async');

async function explain(sql, params = []) {
  return db.all(`EXPLAIN QUERY PLAN ${sql}`, ...params);
}

function getPlanDetails(rows) {
  return (rows || []).map((r) => String(r.detail || '')).filter(Boolean);
}

function usesAnyIndex(details, names) {
  const lowered = details.map(d => d.toLowerCase());
  return names.some(name => lowered.some(d => d.includes(name.toLowerCase())));
}

async function main() {
  const checks = [
    {
      label: 'recruiter+valid+created window',
      sql: 'SELECT COUNT(*) FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1 AND created_at >= ?',
      params: ['GLOBAL', 'R1', 0],
      expectedIndexes: ['idx_recruits_guild_recruiter_valid_created', 'idx_recruits_guild_valid_created']
    },
    {
      label: 'member validity lookup',
      sql: 'SELECT id FROM recruits WHERE recruited_id = ? AND valid = 1 LIMIT 1',
      params: ['U1'],
      expectedIndexes: ['idx_recruits_recruited_valid', 'uniq_recruit']
    },
    {
      label: 'guild valid range count',
      sql: 'SELECT COUNT(*) FROM recruits WHERE guild_id = ? AND valid = 1 AND created_at >= ?',
      params: ['GLOBAL', 0],
      expectedIndexes: ['idx_recruits_guild_valid_created', 'idx_recruits_guild_recruiter_valid_created']
    }
  ];

  let failures = 0;
  for (const check of checks) {
    const rows = await explain(check.sql, check.params);
    const details = getPlanDetails(rows);
    const ok = usesAnyIndex(details, check.expectedIndexes);
    const detailsText = details.length ? details.join(' | ') : '(no plan details)';
    if (ok) {
      console.log(`[OK] ${check.label}: ${detailsText}`);
    } else {
      failures += 1;
      console.error(`[FAIL] ${check.label}: ${detailsText}`);
      console.error(`       expected index: ${check.expectedIndexes.join(', ')}`);
    }
  }

  if (failures > 0) {
    process.exitCode = 1;
  } else {
    console.log('Recruit index verification passed.');
  }
}

main().catch((err) => {
  console.error('verify_recruit_indexes failed:', err);
  process.exit(1);
});
