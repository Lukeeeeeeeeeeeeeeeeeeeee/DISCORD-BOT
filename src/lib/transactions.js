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
  // Validate database exists (but don't check .open as it might be undefined initially)
  if (!db) {
    throw new Error('Database handle is required');
  }
  
  // Only check if explicitly closed (open === false), not if undefined
  if (db.open === false) {
    throw new Error('Database is closed');
  }
  
  const maxRetries = Number.isFinite(opts.maxRetries) ? opts.maxRetries : 3;
  const beginSql = opts.immediate === false ? 'BEGIN TRANSACTION' : 'BEGIN IMMEDIATE';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let began = false;
    try {
      // Check database is not explicitly closed before each operation
      if (db.open === false) {
        throw new Error('Database was closed during transaction');
      }
      
      await db.run(beginSql);
      began = true;
      const result = await fn(db);
      
      // Check database is not explicitly closed before commit
      if (db.open === false) {
        throw new Error('Database was closed before commit');
      }
      
      await db.run('COMMIT');
      return result;
    } catch (err) {
      // Only attempt rollback if database is not explicitly closed
      if (began && db.open !== false) {
        try {
          await db.run('ROLLBACK');
        } catch (rollbackErr) {
          // Only log if it's not a "database closed" error
          if (!String(rollbackErr.message || '').includes('closed')) {
            console.error('Failed to rollback transaction', rollbackErr);
          }
        }
      }
      if (attempt < maxRetries && isTransientTxError(err) && db.open !== false) {
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
  
  // Check if database has an open property and if it's false (sqlite library specific)
  if (db.open === false) throw new Error('Database is not open');

  const prev = txQueueByDb.get(db) || Promise.resolve();
  const run = prev
    .catch((queueErr) => {
      // Only log non-closed errors
      if (!String(queueErr.message || '').includes('closed')) {
        console.error('Previous queued transaction failed', queueErr);
      }
    })
    .then(() => {
      // Re-check database is open before executing (only if property exists)
      if (db.open === false) {
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
