const txQueueByDb = new WeakMap();

function isTransientTxError(err) {
  if (!err) return false;
  const msg = String(err.message || err).toLowerCase();
  return (
    msg.includes('sqlite_busy')
    || msg.includes('sqlite_locked')
    || msg.includes('database is locked')
    || msg.includes('cannot start a transaction within a transaction')
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function executeTransaction(db, fn, opts = {}) {
  const maxRetries = Number.isFinite(opts.maxRetries) ? opts.maxRetries : 3;
  const beginSql = opts.immediate === false ? 'BEGIN TRANSACTION' : 'BEGIN IMMEDIATE';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let began = false;
    try {
      await db.run(beginSql);
      began = true;
      const result = await fn(db);
      await db.run('COMMIT');
      return result;
    } catch (err) {
      if (began) {
        try {
          await db.run('ROLLBACK');
        } catch (rollbackErr) {
          console.error('Failed to rollback transaction', rollbackErr);
        }
      }
      if (attempt < maxRetries && isTransientTxError(err)) {
        const delayMs = 50 * (attempt + 1);
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }

  throw new Error('Transaction retry limit exceeded');
}

async function withTransaction(db, fn, opts = {}) {
  if (!db) throw new Error('Database handle is required');

  const prev = txQueueByDb.get(db) || Promise.resolve();
  const run = prev
    .catch((queueErr) => {
      console.error('Previous queued transaction failed', queueErr);
    })
    .then(() => executeTransaction(db, fn, opts));

  txQueueByDb.set(db, run);
  try {
    return await run;
  } finally {
    if (txQueueByDb.get(db) === run) {
      txQueueByDb.delete(db);
    }
  }
}

module.exports = { withTransaction };
