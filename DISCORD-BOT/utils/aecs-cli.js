#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

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
  const args = {
    logDir: process.env.AECS_LOG_DIR || path.join(process.cwd(), 'data', 'aecs'),
    code: null,
    severity: null,
    trace: null,
    recent: null,
    limit: 50,
    json: false,
    follow: false,
    summary: false,
    search: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if ((token === '--log-dir' || token === '-d') && argv[i + 1]) {
      args.logDir = argv[i + 1];
      i += 1;
      continue;
    }
    if ((token === '--code' || token === '-c') && argv[i + 1]) {
      args.code = argv[i + 1].toUpperCase();
      i += 1;
      continue;
    }
    if ((token === '--severity' || token === '-s') && argv[i + 1]) {
      args.severity = argv[i + 1].toUpperCase();
      i += 1;
      continue;
    }
    if ((token === '--trace' || token === '-t') && argv[i + 1]) {
      args.trace = argv[i + 1];
      i += 1;
      continue;
    }
    if ((token === '--recent' || token === '-r') && argv[i + 1]) {
      args.recent = argv[i + 1];
      i += 1;
      continue;
    }
    if ((token === '--limit' || token === '-n') && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(n) && n > 0) args.limit = n;
      i += 1;
      continue;
    }
    if (token === '--json' || token === '-j') {
      args.json = true;
      continue;
    }
    if (token === '--follow' || token === '-f') {
      args.follow = true;
      continue;
    }
    if (token === '--summary' || token === '-S') {
      args.summary = true;
      continue;
    }
    if ((token === '--search' || token === '-q') && argv[i + 1]) {
      args.search = argv[i + 1].toLowerCase();
      i += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
  }

  return args;
}

function printUsage() {
  console.log(`Usage: node utils/aecs-cli.js [options]

Options:
  -d, --log-dir <path>    AECS log directory (default: data/aecs)
  -c, --code <CODE>       Filter by error code (e.g. RECRUIT-500, DB-502)
  -s, --severity <LEVEL>  Filter by severity (INFO, WARN, ERROR, FATAL)
  -t, --trace <id>        Filter by trace ID (partial match)
  -r, --recent <durtion>  Show records from the last duration (e.g. 24h, 5m, 1h)
  -n, --limit <n>         Maximum records to show (default: 50)
  -q, --search <text>     Search message/scope for substring (case-insensitive)
  -j, --json              Output as JSON (default: false)
  -f, --follow            Follow log file (tail -f behavior)
  -S, --summary           Show summary statistics only
  -h, --help              Show this help message

Examples:
  node utils/aecs-cli.js --code RECRUIT-500 --limit 10
  node utils/aecs-cli.js --severity FATAL --recent 1h --json
  node utils/aecs-cli.js --trace tx-123 --summary
  node utils/aecs-cli.js --search "anti-nuke" --limit 20
`);
}

function listJsonlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => path.join(dir, name));
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch (_e) {
    return null;
  }
}

function filterRecords(records, args) {
  return records.filter((rec) => {
    if (args.code && String(rec.code || '').toUpperCase() !== args.code) return false;
    if (args.severity && String(rec.severity || '').toUpperCase() !== args.severity) return false;
    if (args.trace && !String(rec.traceId || '').toLowerCase().includes(args.trace.toLowerCase())) return false;
    if (args.search) {
      const haystack = `${rec.scope || ''} ${rec.message || ''} ${rec.code || ''}`.toLowerCase();
      if (!haystack.includes(args.search)) return false;
    }
    if (args.recent) {
      const duration = parseDurationMs(args.recent);
      if (duration) {
        const cutoff = Date.now() - duration;
        if (Number(rec.timestamp || 0) < cutoff) return false;
      }
    }
    return true;
  });
}

function formatRecord(rec, json) {
  if (json) {
    return JSON.stringify(rec);
  }
  const timestamp = new Date(rec.timestamp || 0).toISOString();
  const impact = String(rec.impact || 0).padStart(3, ' ');
  const sev = String(rec.severity || 'INFO').padEnd(5);
  const code = String(rec.code || 'SYS-???').padEnd(14);
  return `[${timestamp}] ${impact} ${sev} ${code} ${rec.scope || '<no-scope>'} ${rec.message || ''}`;
}

function printSummary(records) {
  const bySeverity = { INFO: 0, WARN: 0, ERROR: 0, FATAL: 0 };
  const byCode = {};

  records.forEach((rec) => {
    const sev = rec.severity || 'ERROR';
    if (bySeverity[sev] !== undefined) bySeverity[sev] += 1;
    const code = rec.code || 'UNKNOWN';
    byCode[code] = (byCode[code] || 0) + 1;
  });

  console.log('\n=== AECS Vault Summary ===\n');
  console.log('By Severity:');
  console.log(`  INFO:   ${bySeverity.INFO}`);
  console.log(`  WARN:   ${bySeverity.WARN}`);
  console.log(`  ERROR:  ${bySeverity.ERROR}`);
  console.log(`  FATAL:  ${bySeverity.FATAL}`);
  console.log(`  Total:  ${records.length}\n`);

  console.log('Top Error Codes:');
  const sorted = Object.entries(byCode)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);
  sorted.forEach(([code, count]) => {
    console.log(`  ${code.padEnd(16)} ${count}`);
  });

  if (sorted.length < Object.keys(byCode).length) {
    const remaining = Object.keys(byCode).length - sorted.length;
    console.log(`  ... and ${remaining} more`);
  }
  console.log('');
}

function readRecordsFromFiles(files) {
  const records = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const rec = parseLine(line);
        if (rec) records.push(rec);
      }
    } catch (e) {
      console.error(`[aecs-cli] Error reading ${file}:`, e.message);
    }
  }
  return records;
}

async function followFile(filePath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
    terminal: false
  });
  for await (const line of rl) {
    const rec = parseLine(line.trim());
    if (rec) console.log(formatRecord(rec, false));
  }
}

async function run(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    printUsage();
    return 0;
  }

  const files = listJsonlFiles(args.logDir);
  if (files.length === 0) {
    console.error(`[aecs-cli] No AECS log files found in: ${args.logDir}`);
    console.error('[aecs-cli] Set AECS_LOG_DIR or use --log-dir <path>');
    return 1;
  }

  if (args.follow) {
    console.log(`[aecs-cli] Following: ${files[files.length - 1]}`);
    await followFile(files[files.length - 1]);
    return 0;
  }

  const allRecords = readRecordsFromFiles(files);
  const filtered = filterRecords(allRecords, args);
  const records = filtered.slice(-args.limit);

  if (args.summary) {
    printSummary(filtered);
    return 0;
  }

  records.forEach((rec) => console.log(formatRecord(rec, args.json)));
  return 0;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => {
    process.exit(code);
  }).catch((error) => {
    console.error('[aecs-cli] Fatal:', error.message || error);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  parseDurationMs,
  filterRecords,
  formatRecord,
  readRecordsFromFiles,
  printSummary,
  listJsonlFiles
};
