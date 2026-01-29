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

function main() {
  process.env.NODE_ENV = process.env.NODE_ENV || 'test';
  process.env.DATABASE_PATH = process.env.DATABASE_PATH || path.join(require('os').tmpdir(), `require-walk-${Date.now()}.db`);

  const root = path.join(process.cwd(), 'src');
  const skip = new Set([
    path.join(root, 'index.js'),
    path.join(root, 'check.js')
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
    process.exit(1);
  }

  console.log(`Require-walk OK: ${ok}`);
}

if (require.main === module) main();

module.exports = { main };
