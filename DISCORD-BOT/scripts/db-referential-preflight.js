const db = require('../src/db_async');
const { runReferentialPreflight } = require('../src/lib/db-referential-preflight');

function parseArgs(argv) {
  const opts = { fix: true };
  for (const arg of argv) {
    if (arg === '--check') opts.fix = false;
    if (arg === '--fix') opts.fix = true;
  }
  return opts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const summary = await runReferentialPreflight(db, { fix: args.fix, log: true });
    const unresolved = Array.isArray(summary.unresolved) ? summary.unresolved.length : 0;
    await db.close();
    if (unresolved > 0) process.exit(2);
    process.exit(0);
  } catch (error) {
    console.error('Referential preflight failed', error);
    try {
      await db.close();
    } catch (e) {
      void e;
    }
    process.exit(1);
  }
}

main();
