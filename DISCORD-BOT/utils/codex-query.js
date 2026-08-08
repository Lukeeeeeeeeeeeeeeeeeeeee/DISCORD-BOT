#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

function printUsage() {
  console.log('Usage: node utils/codex-query.js [--log-dir <path>] [--federated <dirA,dirB>] [--recent <24h>] [--trace <traceId>] [--blast-radius <CODE>] [--v-trace] [--sql "SELECT ..."] [--limit <n>] [--keep-db]');
}

function parseDurationMs(input) {
  const text = String(input || '').trim().toLowerCase();
  if (!text) return null;

  let numberPart = '';
  let unitPart = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const code = ch.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    if (isDigit) {
      if (unitPart) return null;
      numberPart += ch;
    } else {
      unitPart += ch;
    }
  }

  const amount = Number.parseInt(numberPart || '0', 10);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  if (!unitPart || unitPart === 'ms') return amount;
  if (unitPart === 's' || unitPart === 'sec' || unitPart === 'secs') return amount * 1000;
  if (unitPart === 'm' || unitPart === 'min' || unitPart === 'mins') return amount * 60 * 1000;
  if (unitPart === 'h' || unitPart === 'hr' || unitPart === 'hrs') return amount * 60 * 60 * 1000;
  if (unitPart === 'd' || unitPart === 'day' || unitPart === 'days') return amount * 24 * 60 * 60 * 1000;
  return null;
}

function parseArgs(argv) {
  const envFederated = process.env.AECS_FEDERATED_LOG_DIRS || '';
  const args = {
    logDir: process.env.AECS_LOG_DIR || path.join(process.cwd(), 'data', 'aecs'),
    federatedDirs: parseDirectoryList(envFederated),
    recent: null,
    trace: null,
    blastRadius: null,
    vTrace: false,
    sql: null,
    limit: 200,
    keepDb: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--log-dir' && argv[i + 1]) {
      args.logDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--recent' && argv[i + 1]) {
      args.recent = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--federated' && argv[i + 1]) {
      args.federatedDirs = parseDirectoryList(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === '--trace' && argv[i + 1]) {
      args.trace = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--blast-radius' && argv[i + 1]) {
      args.blastRadius = String(argv[i + 1]).toUpperCase();
      i += 1;
      continue;
    }
    if (token === '--v-trace') {
      args.vTrace = true;
      continue;
    }
    if (token === '--sql' && argv[i + 1]) {
      args.sql = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--limit' && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(n) && n > 0) args.limit = n;
      i += 1;
      continue;
    }
    if (token === '--keep-db') {
      args.keepDb = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
  }

  return args;
}

function getJsonlFiles(logDir) {
  if (!fs.existsSync(logDir)) return [];
  const names = fs.readdirSync(logDir);
  return names
    .filter((name) => name.startsWith('aecs-') && name.endsWith('.jsonl'))
    .sort()
    .map((name) => path.join(logDir, name));
}

function parseDirectoryList(value) {
  const text = String(value || '');
  if (!text) return [];

  const parts = [];
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === ',' || ch === ';') {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function gatherLogFiles(directories) {
  const uniqueDirs = [];
  for (const directory of directories || []) {
    if (!directory) continue;
    const resolved = path.resolve(directory);
    if (!uniqueDirs.includes(resolved)) uniqueDirs.push(resolved);
  }

  const files = [];
  for (const directory of uniqueDirs) {
    files.push(...getJsonlFiles(directory));
  }
  return files.sort();
}

function idxPathFromJsonl(jsonlPath) {
  if (jsonlPath.endsWith('.jsonl')) {
    return `${jsonlPath.slice(0, -6)}.idx`;
  }
  return `${jsonlPath}.idx`;
}

function computeHashId(entry) {
  if (entry && Number.isFinite(Number(entry.hashId))) {
    return Number(entry.hashId) >>> 0;
  }
  const hash = entry && entry.hash ? String(entry.hash) : null;
  if (hash && hash.length >= 8) {
    const parsed = Number.parseInt(hash.slice(0, 8), 16);
    if (Number.isFinite(parsed)) return parsed >>> 0;
  }
  const code = entry && entry.code ? String(entry.code) : 'SYS-001';
  const scope = entry && entry.scope ? String(entry.scope) : 'runtime';
  const digest = crypto.createHash('md5').update(`${scope}|${code}`).digest('hex');
  return Number.parseInt(digest.slice(0, 8), 16) >>> 0;
}

async function rebuildIdxForFile(jsonlPath, idxPath = idxPathFromJsonl(jsonlPath)) {
  const tempPath = `${idxPath}.tmp`;
  const writeStream = fs.createWriteStream(tempPath, { flags: 'w' });

  let offset = 0;
  const input = fs.createReadStream(jsonlPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    const lineBytes = Buffer.byteLength(`${line}\n`, 'utf8');
    if (!line || line.trim().length === 0) {
      offset += lineBytes;
      continue;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch (_error) {
      parsed = null;
    }

    const timestamp = Number(parsed && parsed.timestamp ? parsed.timestamp : Date.now());
    const hashId = computeHashId(parsed || {});

    const entry = Buffer.allocUnsafe(16);
    entry.writeBigUInt64BE(BigInt(Math.max(0, timestamp)), 0);
    entry.writeUInt32BE(hashId >>> 0, 8);
    entry.writeUInt32BE((offset >>> 0), 12);

    writeStream.write(entry);
    offset += lineBytes;
  }

  await new Promise((resolve) => writeStream.end(() => resolve()));
  fs.renameSync(tempPath, idxPath);
  return idxPath;
}

function readIdxEntry(fd, index) {
  const buf = Buffer.allocUnsafe(16);
  const position = index * 16;
  const bytesRead = fs.readSync(fd, buf, 0, 16, position);
  if (bytesRead !== 16) return null;
  return {
    timestamp: Number(buf.readBigUInt64BE(0)),
    hashId: buf.readUInt32BE(8),
    offset: buf.readUInt32BE(12)
  };
}

function verifyIdxAlignment(jsonlPath, idxPath) {
  if (!fs.existsSync(idxPath)) return false;
  const idxStat = fs.statSync(idxPath);
  if (idxStat.size === 0) return true;
  if (idxStat.size % 16 !== 0) return false;

  const totalEntries = Math.floor(idxStat.size / 16);
  if (totalEntries <= 0) return true;

  const idxFd = fs.openSync(idxPath, 'r');
  const jsonFd = fs.openSync(jsonlPath, 'r');

  try {
    const sampleIndexes = [0, Math.floor(totalEntries / 2), totalEntries - 1]
      .filter((value, index, arr) => arr.indexOf(value) === index);

    for (const sampleIndex of sampleIndexes) {
      const entry = readIdxEntry(idxFd, sampleIndex);
      if (!entry) return false;

      const marker = Buffer.allocUnsafe(1);
      const bytesRead = fs.readSync(jsonFd, marker, 0, 1, entry.offset);
      if (bytesRead !== 1) return false;
      if (marker[0] !== 123) return false;
    }

    return true;
  } finally {
    fs.closeSync(idxFd);
    fs.closeSync(jsonFd);
  }
}

async function ensureIdxIntegrity(jsonlPath) {
  const idxPath = idxPathFromJsonl(jsonlPath);
  if (!verifyIdxAlignment(jsonlPath, idxPath)) {
    await rebuildIdxForFile(jsonlPath, idxPath);
    return { file: jsonlPath, idxPath, rebuilt: true };
  }
  return { file: jsonlPath, idxPath, rebuilt: false };
}

async function createSessionDb() {
  const dbPath = path.join(os.tmpdir(), `aecs-query-session-${process.pid}-${Date.now()}.db`);
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  await db.exec('PRAGMA journal_mode = WAL;');
  await db.exec('PRAGMA synchronous = NORMAL;');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER,
      trace_id TEXT,
      support_id TEXT,
      code TEXT,
      severity TEXT,
      impact INTEGER,
      scope TEXT,
      domain TEXT,
      message TEXT,
      hash TEXT,
      hash_id INTEGER,
      user_id TEXT,
      guild_id TEXT,
      command TEXT,
      meta_json TEXT,
      raw_json TEXT,
      source_file TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_logs_trace ON logs(trace_id);
    CREATE INDEX IF NOT EXISTS idx_logs_code ON logs(code);
    CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(user_id);
  `);

  return { db, dbPath };
}

function normalizeRecord(record) {
  const meta = record && record.meta && typeof record.meta === 'object' ? record.meta : {};
  const userId = record.userId || meta.userId || null;
  const guildId = record.guildId || meta.guildId || null;
  const command = record.command || meta.command || null;

  return {
    timestamp: Number(record.timestamp || Date.now()),
    traceId: record.traceId || null,
    supportId: record.supportId || null,
    code: record.code || null,
    severity: record.severity || null,
    impact: Number(record.impact || 0),
    scope: record.scope || null,
    domain: record.domain || null,
    message: record.message || null,
    hash: record.hash || null,
    hashId: computeHashId(record),
    userId: userId ? String(userId) : null,
    guildId: guildId ? String(guildId) : null,
    command: command ? String(command) : null,
    metaJson: JSON.stringify(meta || {}),
    rawJson: JSON.stringify(record),
    sourceFile: record.sourceFile || null
  };
}

async function ingestLogsToSqlite(db, files, options = {}) {
  const minTimestamp = Number(options.minTimestamp || 0);
  await db.exec('BEGIN');
  const stmt = await db.prepare(`
    INSERT INTO logs (
      timestamp, trace_id, support_id, code, severity, impact, scope, domain, message, hash, hash_id,
      user_id, guild_id, command, meta_json, raw_json, source_file
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  try {
    for (const file of files) {
      const input = fs.createReadStream(file, { encoding: 'utf8' });
      const rl = readline.createInterface({ input, crlfDelay: Infinity });

      for await (const line of rl) {
        if (!line || line.trim().length === 0) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch (_error) {
          continue;
        }

        if (!parsed || typeof parsed !== 'object') continue;
        if (minTimestamp && Number(parsed.timestamp || 0) < minTimestamp) continue;

        const normalized = normalizeRecord({ ...parsed, sourceFile: path.basename(file) });
        await stmt.run(
          normalized.timestamp,
          normalized.traceId,
          normalized.supportId,
          normalized.code,
          normalized.severity,
          normalized.impact,
          normalized.scope,
          normalized.domain,
          normalized.message,
          normalized.hash,
          normalized.hashId,
          normalized.userId,
          normalized.guildId,
          normalized.command,
          normalized.metaJson,
          normalized.rawJson,
          normalized.sourceFile
        );
      }
    }

    await stmt.finalize();
    await db.exec('COMMIT');
  } catch (error) {
    try {
      await stmt.finalize();
    } catch (_finalizeError) {
      void _finalizeError;
    }
    await db.exec('ROLLBACK');
    throw error;
  }
}

function collapseRows(rows) {
  const collapsed = [];
  for (const row of rows) {
    const last = collapsed.length ? collapsed[collapsed.length - 1] : null;
    if (last && last.code === row.code && last.scope === row.scope && last.severity === row.severity) {
      last.count += 1;
      last.lastTimestamp = row.timestamp;
      continue;
    }
    collapsed.push({
      ...row,
      count: 1,
      lastTimestamp: row.timestamp
    });
  }
  return collapsed;
}

function generateVTraceMermaid(rows) {
  const lines = ['sequenceDiagram', 'participant BOT as DiscordBot'];

  if (!rows || rows.length === 0) {
    lines.push('Note over BOT: No events found for trace');
    return lines.join('\n');
  }

  const collapsed = collapseRows(rows);
  for (const row of collapsed) {
    const severity = row.severity || 'ERROR';
    const base = `${row.code || 'UNKNOWN'} ${severity}`;
    const detail = row.count > 1 ? `[Loop ${row.count}x: ${base}]` : base;
    lines.push(`BOT->>BOT: ${detail}`);
  }

  return lines.join('\n');
}

async function queryRecent(db, minTimestamp, limit) {
  return db.all(
    `SELECT timestamp, code, severity, scope, trace_id as traceId, support_id as supportId, message, user_id as userId
     FROM logs
     WHERE timestamp >= ?
     ORDER BY timestamp DESC
     LIMIT ?`,
    minTimestamp,
    limit
  );
}

async function queryTrace(db, traceId, limit) {
  return db.all(
    `SELECT timestamp, code, severity, scope, domain, message, support_id as supportId, command
     FROM logs
     WHERE trace_id = ?
     ORDER BY timestamp ASC
     LIMIT ?`,
    traceId,
    limit
  );
}

async function queryBlastRadius(db, code, limit) {
  return db.all(
    `SELECT DISTINCT user_id as userId
     FROM logs
     WHERE code = ? AND user_id IS NOT NULL AND user_id != ''
     ORDER BY user_id ASC
     LIMIT ?`,
    code,
    limit
  );
}

async function run(args) {
  if (args.help) {
    printUsage();
    return 0;
  }

  const hasAction = Boolean(args.recent || args.trace || args.blastRadius || args.sql);
  if (!hasAction) {
    printUsage();
    return 1;
  }

  const sourceDirectories = [args.logDir, ...(args.federatedDirs || [])];
  const files = gatherLogFiles(sourceDirectories);
  if (files.length === 0) {
    console.error(`No AECS log files found in ${sourceDirectories.join(', ')}`);
    return 1;
  }

  const idxChecks = [];
  for (const file of files) {
    idxChecks.push(await ensureIdxIntegrity(file));
  }

  const { db, dbPath } = await createSessionDb();
  let exitCode = 0;

  try {
    const recentDurationMs = args.recent ? parseDurationMs(args.recent) : null;
    const minTimestamp = recentDurationMs ? Date.now() - recentDurationMs : 0;
    await ingestLogsToSqlite(db, files, { minTimestamp });

    if (args.sql) {
      const rows = await db.all(args.sql);
      console.log(JSON.stringify({ rows, idxChecks, sessionDb: dbPath }, null, 2));
      return 0;
    }

    if (args.trace) {
      const rows = await queryTrace(db, args.trace, args.limit);
      if (args.vTrace) {
        console.log(generateVTraceMermaid(rows));
      } else {
        console.log(JSON.stringify({ traceId: args.trace, rows, idxChecks, sessionDb: dbPath }, null, 2));
      }
      return 0;
    }

    if (args.blastRadius) {
      const rows = await queryBlastRadius(db, args.blastRadius, args.limit);
      const userIds = rows.map((row) => row.userId).filter(Boolean);
      console.log(JSON.stringify({ code: args.blastRadius, userIds, idxChecks, sessionDb: dbPath }, null, 2));
      return 0;
    }

    if (args.recent) {
      const duration = parseDurationMs(args.recent);
      if (!duration) {
        console.error(`Invalid --recent value: ${args.recent}`);
        return 1;
      }
      const rows = await queryRecent(db, Date.now() - duration, args.limit);
      console.log(JSON.stringify({ recent: args.recent, rows, idxChecks, sessionDb: dbPath }, null, 2));
      return 0;
    }

    return 0;
  } catch (error) {
    exitCode = 1;
    console.error('codex-query failed:', error);
    return exitCode;
  } finally {
    await db.close();
    if (!args.keepDb) {
      try {
        fs.rmSync(dbPath, { force: true });
        const wal = `${dbPath}-wal`;
        const shm = `${dbPath}-shm`;
        if (fs.existsSync(wal)) fs.rmSync(wal, { force: true });
        if (fs.existsSync(shm)) fs.rmSync(shm, { force: true });
      } catch (_error) {
        void _error;
      }
    }
  }
}

if (require.main === module) {
  run(parseArgs(process.argv.slice(2))).then((code) => {
    process.exit(code);
  }).catch((error) => {
    console.error('codex-query crashed:', error);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  parseDurationMs,
  parseDirectoryList,
  getJsonlFiles,
  gatherLogFiles,
  idxPathFromJsonl,
  rebuildIdxForFile,
  ensureIdxIntegrity,
  createSessionDb,
  ingestLogsToSqlite,
  generateVTraceMermaid,
  run
};
