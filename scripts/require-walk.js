/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && p.endsWith('.js')) out.push(p);
  }
}

function main({ forceExit = false } = {}) {
  const os = require('os');
  process.env.NODE_ENV = process.env.NODE_ENV || 'test';
  // Always isolate require-walk DB/state from caller env so CI/prod paths cannot leak in.
  process.env.DATABASE_PATH = process.env.REQUIRE_WALK_DATABASE_PATH
    || path.join(os.tmpdir(), `require-walk-${Date.now()}.db`);
  process.env.ANTINUKE_DATA_FILE = process.env.REQUIRE_WALK_ANTINUKE_DATA_FILE
    || path.join(os.tmpdir(), `antinuke-state-${Date.now()}.json`);

  const root = path.join(process.cwd(), 'src');
  const skip = new Set([
    path.join(root, 'index.js'),
    path.join(root, 'check.js'),
    path.join(root, 'shard.js')
  ]);

  const files = [];
  walk(root, files);

  const failed = [];
  let ok = 0;

  for (const f of files) {
    if (skip.has(f)) continue;
    try {
      require(f);
      ok++;
    } catch (e) {
      failed.push({
        file: path.relative(process.cwd(), f),
        err: e && e.stack ? e.stack : String(e)
      });
    }
  }

  if (failed.length) {
    console.error(`Require-walk failures: ${failed.length}`);
    for (const x of failed) {
      console.error(`\n--- ${x.file} ---\n${x.err}`);
    }
    if (forceExit) process.exit(1);
    throw new Error(`Require-walk failures: ${failed.length}`);
  }

  console.log(`Require-walk OK: ${ok}`);
  if (forceExit) process.exit(0);
  return { ok, failedCount: 0 };
}

if (require.main === module) {
  main({ forceExit: true });
}

module.exports = { main };
