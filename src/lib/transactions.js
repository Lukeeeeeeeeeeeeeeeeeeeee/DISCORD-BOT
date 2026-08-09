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
  // Validate database is open and ready
  if (!db || !db.open) {
    throw new Error('Database is not open');
  }
  
  const maxRetries = Number.isFinite(opts.maxRetries) ? opts.maxRetries : 3;
  const beginSql = opts.immediate === false ? 'BEGIN TRANSACTION' : 'BEGIN IMMEDIATE';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let began = false;
    try {
      // Check database is still open before each operation
      if (!db.open) {
        throw new Error('Database was closed during transaction');
      }
      
      await db.run(beginSql);
      began = true;
      const result = await fn(db);
      
      // Check database is still open before commit
      if (!db.open) {
        throw new Error('Database was closed before commit');
      }
      
      await db.run('COMMIT');
      return result;
    } catch (err) {
      // Only attempt rollback if database is still open
      if (began && db.open) {
        try {
          await db.run('ROLLBACK');
        } catch (rollbackErr) {
          // Only log if it's not a "database closed" error
          if (!String(rollbackErr.message || '').includes('closed')) {
            console.error('Failed to rollback transaction', rollbackErr);
          }
        }
      }
      if (attempt < maxRetries && isTransientTxError(err) && db.open) {
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
  if (!db.open) throw new Error('Database is not open');

  const prev = txQueueByDb.get(db) || Promise.resolve();
  const run = prev
    .catch((queueErr) => {
      // Only log non-closed errors
      if (!String(queueErr.message || '').includes('closed')) {
        console.error('Previous queued transaction failed', queueErr);
      }
    })
    .then(() => {
      // Re-check database is open before executing
      if (!db.open) {
        throw new Error('Database closed before transaction could start');
      }
      return executeTransaction(db, fn, opts);
    });

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
