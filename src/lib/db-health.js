/**
 * Database health monitoring and auto-recovery
 */

const fs = require('fs');
const path = require('path');

let lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL = 60000; // Check every 60 seconds
const MAX_RETRIES = 3;

async function checkDatabaseIntegrity(db) {
  try {
    const result = await db.get('PRAGMA integrity_check');
    return result && result.integrity_check === 'ok';
  } catch (err) {
    console.error('Database integrity check failed:', err);
    return false;
  }
}

async function enableWalMode(db) {
  try {
    await db.exec('PRAGMA journal_mode=WAL');
    await db.exec('PRAGMA synchronous=NORMAL');
    console.log('✅ Enabled WAL mode for better concurrency and crash recovery');
    return true;
  } catch (err) {
    console.error('Failed to enable WAL mode:', err);
    return false;
  }
}

async function createBackup(dbPath) {
  const timestamp = Date.now();
  const backupPath = `${dbPath}.backup-${timestamp}`;
  try {
    fs.copyFileSync(dbPath, backupPath);
    console.log(`✅ Created backup: ${backupPath}`);
    return backupPath;
  } catch (err) {
    console.error('Failed to create backup:', err);
    return null;
  }
}

async function healthCheck(db, dbPath) {
  const now = Date.now();
  if (now - lastHealthCheck < HEALTH_CHECK_INTERVAL) {
    return true; // Too soon, skip check
  }
  
  lastHealthCheck = now;
  
  try {
    const isHealthy = await checkDatabaseIntegrity(db);
    if (!isHealthy) {
      console.error('⚠️  DATABASE CORRUPTION DETECTED!');
      console.error('⚠️  Analytics and other operations may fail.');
      console.error('⚠️  Please run: node scripts/fix-corrupted-db.js');
      
      // Create emergency backup
      if (dbPath) {
        await createBackup(dbPath);
      }
      
      return false;
    }
    return true;
  } catch (err) {
    console.error('Health check failed:', err);
    return false;
  }
}

function wrapDbOperation(operation, operationName = 'DB operation') {
  return async function wrapped(...args) {
    let retries = 0;
    while (retries < MAX_RETRIES) {
      try {
        return await operation(...args);
      } catch (err) {
        const isCorruption = err && (
          err.code === 'SQLITE_CORRUPT' ||
          (err.message && err.message.includes('malformed'))
        );
        
        const isLocked = err && (
          err.code === 'SQLITE_BUSY' ||
          err.code === 'SQLITE_LOCKED' ||
          (err.message && err.message.includes('locked'))
        );
        
        if (isCorruption) {
          console.error(`❌ Database corruption during ${operationName}`);
          console.error('   Run: node scripts/fix-corrupted-db.js');
          throw err; // Don't retry corruption
        }
        
        if (isLocked && retries < MAX_RETRIES - 1) {
          retries++;
          const delay = 100 * Math.pow(2, retries); // Exponential backoff
          console.warn(`⚠️  Database locked during ${operationName}, retry ${retries}/${MAX_RETRIES} after ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        throw err;
      }
    }
  };
}

function isSqliteCorruptionError(err) {
  return err && (
    err.code === 'SQLITE_CORRUPT' ||
    (err.message && (
      err.message.includes('malformed') ||
      err.message.includes('SQLITE_CORRUPT')
    ))
  );
}

module.exports = {
  checkDatabaseIntegrity,
  enableWalMode,
  createBackup,
  healthCheck,
  wrapDbOperation,
  isSqliteCorruptionError
};
