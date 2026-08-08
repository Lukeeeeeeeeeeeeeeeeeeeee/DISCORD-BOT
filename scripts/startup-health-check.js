#!/usr/bin/env node
/**
 * Startup health check - runs before bot starts
 * Checks database integrity and provides recovery instructions if corrupted
 */

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'recruiter.db');

async function main() {
  console.log('🔍 Running startup health check...\n');
  
  let db;
  try {
    db = await open({
      filename: DB_PATH,
      driver: sqlite3.Database
    });
    
    // Check integrity
    const result = await db.get('PRAGMA integrity_check');
    
    if (result.integrity_check === 'ok') {
      console.log('✅ Database integrity: OK');
      
      // Enable WAL mode if not already
      const journalMode = await db.get('PRAGMA journal_mode');
      if (journalMode.journal_mode !== 'wal') {
        console.log('📝 Enabling WAL mode for better crash recovery...');
        await db.exec('PRAGMA journal_mode=WAL');
        await db.exec('PRAGMA synchronous=NORMAL');
        console.log('✅ WAL mode enabled');
      } else {
        console.log('✅ WAL mode: enabled');
      }
      
      // Check table count
      const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
      console.log(`✅ Tables: ${tables.length}`);
      
      await db.close();
      console.log('\n✅ All health checks passed! Bot can start safely.\n');
      process.exit(0);
    } else {
      console.error('❌ DATABASE CORRUPTION DETECTED!');
      console.error('   Integrity check result:', result.integrity_check);
      console.error('\n🔧 RECOVERY REQUIRED:');
      console.error('   1. Stop the bot if it\'s running');
      console.error('   2. Run: node scripts/fix-corrupted-db.js');
      console.error('   3. Restart the bot after recovery completes\n');
      
      await db.close();
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Health check failed:', err.message);
    
    if (err.code === 'SQLITE_CORRUPT' || (err.message && err.message.includes('malformed'))) {
      console.error('\n🔧 DATABASE IS CORRUPTED!');
      console.error('   Run: node scripts/fix-corrupted-db.js\n');
    }
    
    if (db) await db.close();
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
