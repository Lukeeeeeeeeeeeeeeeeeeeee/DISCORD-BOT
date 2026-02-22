#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const args = {
    source: process.env.AECS_LOG_DIR || path.join(process.cwd(), 'data', 'aecs'),
    target: process.env.AECS_SYNC_TARGET || '',
    intervalMs: Number.parseInt(process.env.AECS_SYNC_INTERVAL_MS || '15000', 10),
    once: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--source' && argv[i + 1]) {
      args.source = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--target' && argv[i + 1]) {
      args.target = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--interval' && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) args.intervalMs = parsed;
      i += 1;
      continue;
    }
    if (token === '--once') {
      args.once = true;
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
  console.log('Usage: node utils/aecs-sync.js --source <logDir> --target <localDir|s3://bucket/prefix> [--interval 15000] [--once]');
}

function listAecsFiles(sourceDir) {
  if (!fs.existsSync(sourceDir)) return [];
  const names = fs.readdirSync(sourceDir);
  return names
    .filter((name) => name.startsWith('aecs-') && (name.endsWith('.jsonl') || name.endsWith('.idx')))
    .sort();
}

function isS3Target(target) {
  return String(target || '').toLowerCase().startsWith('s3://');
}

async function syncToS3(source, target) {
  return new Promise((resolve, reject) => {
    const args = ['s3', 'sync', source, target, '--exclude', '*', '--include', 'aecs-*.jsonl', '--include', 'aecs-*.idx'];
    const child = spawn('aws', args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`aws s3 sync exited with code ${code}`));
    });
  });
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function syncToLocal(source, target, state) {
  ensureDir(target);
  const files = listAecsFiles(source);
  let copied = 0;

  for (const name of files) {
    const srcPath = path.join(source, name);
    const destPath = path.join(target, name);
    const stat = fs.statSync(srcPath);
    const key = `${name}:${stat.size}:${stat.mtimeMs}`;
    if (state.lastFingerprint.get(name) === key) continue;

    fs.copyFileSync(srcPath, destPath);
    state.lastFingerprint.set(name, key);
    copied += 1;
  }

  return copied;
}

async function performSync(args, state) {
  const source = path.resolve(args.source);
  const target = args.target;

  if (!target) {
    throw new Error('Missing --target (or AECS_SYNC_TARGET).');
  }

  if (!fs.existsSync(source)) {
    throw new Error(`Source directory does not exist: ${source}`);
  }

  if (isS3Target(target)) {
    await syncToS3(source, target);
    console.log(`[aecs-sync] Synced ${source} -> ${target}`);
    return;
  }

  const targetDir = path.resolve(target);
  const copied = syncToLocal(source, targetDir, state);
  console.log(`[aecs-sync] Synced ${copied} file(s) ${source} -> ${targetDir}`);
}

async function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return 0;
  }

  const state = {
    lastFingerprint: new Map()
  };

  await performSync(args, state);

  if (args.once) return 0;

  setInterval(() => {
    performSync(args, state).catch((error) => {
      console.error('[aecs-sync] Sync failed:', error.message || error);
    });
  }, args.intervalMs);

  console.log(`[aecs-sync] Running every ${args.intervalMs}ms`);
  return 0;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => {
    process.exit(code);
  }).catch((error) => {
    console.error('[aecs-sync] Fatal:', error.message || error);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  listAecsFiles,
  syncToLocal,
  performSync
};
