const fs = require('fs');
const path = require('path');

function ensureDatabaseFile(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try {
    fs.closeSync(fs.openSync(dbPath, 'a'));
  } catch (_error) {
    // File creation is best-effort; sqlite open will surface the hard failure.
  }
}

function readPragmaValues(rows) {
  if (!rows || !rows.length) return [];
  const values = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    values.push(Object.values(row)[0]);
  }
  return values;
}

async function applyConnectionPragmas(db, env = process.env) {
  try { await db.exec('PRAGMA foreign_keys = ON'); } catch (e) { void e; }

  const disableWal = String(env.SQLITE_DISABLE_WAL || '').toLowerCase() === 'true';
  const journalModeRaw = String(env.SQLITE_JOURNAL_MODE || 'WAL').toUpperCase();
  const allowedModes = new Set(['WAL', 'DELETE', 'TRUNCATE', 'PERSIST', 'MEMORY', 'OFF']);
  if (!disableWal) {
    if (allowedModes.has(journalModeRaw)) {
      try { await db.exec(`PRAGMA journal_mode = ${journalModeRaw}`); } catch (e) { void e; }
    } else {
      console.warn(`Invalid SQLITE_JOURNAL_MODE "${journalModeRaw}" - skipping journal_mode PRAGMA.`);
    }
  }

  try { await db.exec('PRAGMA synchronous = NORMAL'); } catch (e) { void e; }
  try { await db.exec('PRAGMA busy_timeout = 10000'); } catch (e) { void e; }
}

async function runIntegrityChecks(db, label = 'startup', env = process.env) {
  if (!db || typeof db.all !== 'function') return { ok: true, skipped: true };
  const enabled = String(env.DB_INTEGRITY_CHECK || 'true').toLowerCase() === 'true';
  if (!enabled) return { ok: true, skipped: true };

  const mode = String(env.DB_INTEGRITY_MODE || 'quick').toLowerCase();
  if (mode === 'off' || mode === 'none' || mode === 'skip') {
    return { ok: true, skipped: true };
  }

  let integrityValues = [];
  try {
    integrityValues = mode === 'full'
      ? readPragmaValues(await db.all('PRAGMA integrity_check'))
      : readPragmaValues(await db.all('PRAGMA quick_check'));
  } catch (error) {
    console.error('DB integrity check failed to run', { label, mode, error });
    if (String(env.DB_INTEGRITY_STRICT || '').toLowerCase() === 'true') throw error;
    return { ok: false, error };
  }

  const integrityOk = integrityValues.length === 0
    ? true
    : integrityValues.every((value) => String(value).toLowerCase() === 'ok');

  let fkRows = [];
  try {
    fkRows = await db.all('PRAGMA foreign_key_check');
  } catch (error) {
    console.error('DB foreign_key_check failed to run', { label, error });
    if (String(env.DB_INTEGRITY_STRICT || '').toLowerCase() === 'true') throw error;
    return { ok: false, error };
  }

  const fkOk = !fkRows || fkRows.length === 0;
  const ok = integrityOk && fkOk;

  if (!ok) {
    console.error('DB integrity check failed', {
      label,
      mode,
      integrity: integrityValues,
      foreignKeyViolations: fkRows
    });
    if (String(env.DB_INTEGRITY_STRICT || '').toLowerCase() === 'true') {
      throw new Error('Database integrity check failed');
    }
  } else if (String(env.DB_INTEGRITY_LOG_OK || '').toLowerCase() === 'true') {
    console.log('DB integrity check OK', { label, mode });
  }

  return { ok, integrityOk, fkOk, integrityValues, fkRows };
}

module.exports = {
  ensureDatabaseFile,
  applyConnectionPragmas,
  runIntegrityChecks
};
