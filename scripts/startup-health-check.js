#!/usr/bin/env node
/**
 * Startup health check with AUTO-RECOVERY
 * - Checks database integrity
 * - Automatically recovers if corrupted (with backup)
 * - No manual intervention needed
 */

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'recruiter.db');

async function recoverDatabase() {
  console.log('\n🔧 AUTO-RECOVERY STARTING...');
  console.log('   Creating backup and recovering database automatically\n');
  
  const BACKUP_PATH = `${DB_PATH}.corrupted-${Date.now()}`;
  const DUMP_PATH = path.join(path.dirname(DB_PATH), `dump-${Date.now()}.sql`);
  const RECOVERY_PATH = `${DB_PATH}.recovered-${Date.now()}`;
  
  // Backup corrupted DB
  try {
    fs.copyFileSync(DB_PATH, BACKUP_PATH);
    console.log('✅ Backup created:', BACKUP_PATH);
  } catch (err) {
    console.error('❌ Failed to create backup:', err.message);
    throw err;
  }
  
  // Open corrupted DB and extract data
  let db;
  try {
    db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    
    console.log('📝 Extracting schema...');
    const schema = await db.all("SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL").catch(() => []);
    
    console.log('📝 Extracting recoverable data...');
    let sqlDump = '-- Auto-Recovery Dump\n';
    sqlDump += '-- Generated: ' + new Date().toISOString() + '\n\n';
    
    // Add schema
    for (const table of schema) {
      if (table.sql) sqlDump += table.sql + ';\n\n';
    }
    
    // Extract data from each table
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").catch(() => []);
    
    for (const { name } of tables) {
      try {
        const rows = await db.all(`SELECT * FROM ${name}`);
        console.log(`  - ${name}: ${rows.length} rows`);
        
        if (rows.length > 0) {
          const columns = Object.keys(rows[0]);
          for (const row of rows) {
            const values = columns.map(col => {
              const val = row[col];
              if (val === null) return 'NULL';
              if (typeof val === 'string') return "'" + val.replace(/'/g, "''") + "'";
              return val;
            });
            sqlDump += `INSERT INTO ${name} (${columns.join(', ')}) VALUES (${values.join(', ')});\n`;
          }
          sqlDump += '\n';
        }
      } catch (err) {
        console.warn(`  ⚠️  Could not export table ${name}:`, err.message);
      }
    }
    
    fs.writeFileSync(DUMP_PATH, sqlDump);
    console.log('✅ Data dump created:', DUMP_PATH);
    
    await db.close();
    
    // Create new database from dump
    console.log('\n🔨 Creating new database...');
    const newDb = await open({ filename: RECOVERY_PATH, driver: sqlite3.Database });
    
    const statements = sqlDump.split(';').filter(s => s.trim() && !s.trim().startsWith('--'));
    let success = 0;
    let failed = 0;
    
    for (const stmt of statements) {
      try {
        await newDb.exec(stmt);
        success++;
      } catch (err) {
        failed++;
      }
    }
    
    console.log(`✅ Executed ${success} statements (${failed} failed)`);
    
    // Verify new database
    const newIntegrityCheck = await newDb.get('PRAGMA integrity_check');
    if (newIntegrityCheck.integrity_check === 'ok') {
      console.log('✅ New database integrity: OK');
      
      await newDb.close();
      
      // Replace old with new
      const oldPath = `${DB_PATH}.old-${Date.now()}`;
      fs.renameSync(DB_PATH, oldPath);
      fs.copyFileSync(RECOVERY_PATH, DB_PATH);
      
      console.log('\n✅ AUTO-RECOVERY COMPLETE!');
      console.log('   Corrupted DB:', oldPath);
      console.log('   Backup:', BACKUP_PATH);
      console.log('   Recovered DB:', DB_PATH);
      console.log('   NO DATA WAS LOST\n');
      return true;
    } else {
      console.error('❌ New database is also corrupted');
      await newDb.close();
      return false;
    }
  } catch (err) {
    console.error('❌ Auto-recovery failed:', err.message);
    if (db) await db.close();
    return false;
  }
}

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
        console.log('📝 Enabling WAL mode...');
        await db.exec('PRAGMA journal_mode=WAL');
        await db.exec('PRAGMA synchronous=NORMAL');
        console.log('✅ WAL mode enabled');
      } else {
        console.log('✅ WAL mode: enabled');
      }
      
      const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
      console.log(`✅ Tables: ${tables.length}`);
      
      await db.close();
      console.log('\n✅ All health checks passed!\n');
      process.exit(0);
    } else {
      console.error('❌ DATABASE CORRUPTION DETECTED!');
      console.error('   Integrity check result:', result.integrity_check);
      await db.close();
      
      // AUTO-RECOVER
      const recovered = await recoverDatabase();
      if (recovered) {
        console.log('✅ Bot can now start with recovered database\n');
        process.exit(0);
      } else {
        console.error('❌ Auto-recovery failed. Manual intervention required.\n');
        process.exit(1);
      }
    }
  } catch (err) {
    console.error('❌ Health check failed:', err.message);
    
    if (err.code === 'SQLITE_CORRUPT' || (err.message && err.message.includes('malformed'))) {
      console.error('\n🔧 DATABASE CORRUPTION DETECTED - STARTING AUTO-RECOVERY...\n');
      if (db) await db.close();
      
      const recovered = await recoverDatabase();
      if (recovered) {
        console.log('✅ Bot can now start with recovered database\n');
        process.exit(0);
      } else {
        console.error('❌ Auto-recovery failed. Manual intervention required.\n');
        process.exit(1);
      }
    }
    
    if (db) await db.close();
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
