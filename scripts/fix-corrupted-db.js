#!/usr/bin/env node
/**
 * Database corruption recovery script
 * 
 * This script attempts to recover a corrupted SQLite database by:
 * 1. Creating a backup of the corrupted database
 * 2. Attempting to dump recoverable data
 * 3. Creating a new clean database
 * 4. Restoring data from the dump
 */

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'recruiter.db');
const BACKUP_PATH = path.join(__dirname, '..', 'data', `recruiter.db.corrupted-${Date.now()}`);
const DUMP_PATH = path.join(__dirname, '..', 'data', `dump-${Date.now()}.sql`);
const RECOVERY_PATH = path.join(__dirname, '..', 'data', `recruiter.db.recovered-${Date.now()}`);

async function main() {
  console.log('🔍 Database Corruption Recovery Script');
  console.log('======================================\n');

  // Step 1: Check if database exists
  if (!fs.existsSync(DB_PATH)) {
    console.error('❌ Database file not found:', DB_PATH);
    process.exit(1);
  }

  console.log('✅ Found database:', DB_PATH);

  // Step 2: Create backup
  console.log('\n📦 Creating backup...');
  try {
    fs.copyFileSync(DB_PATH, BACKUP_PATH);
    console.log('✅ Backup created:', BACKUP_PATH);
  } catch (err) {
    console.error('❌ Failed to create backup:', err.message);
    process.exit(1);
  }

  // Step 3: Try to open database and check integrity
  console.log('\n🔍 Checking database integrity...');
  let db;
  try {
    db = await open({
      filename: DB_PATH,
      driver: sqlite3.Database
    });
    
    const integrityCheck = await db.get('PRAGMA integrity_check');
    console.log('Integrity check result:', integrityCheck);
    
    if (integrityCheck.integrity_check === 'ok') {
      console.log('✅ Database is not corrupted! No recovery needed.');
      await db.close();
      process.exit(0);
    }
    
    console.log('⚠️  Database corruption detected');
  } catch (err) {
    console.error('❌ Cannot open database:', err.message);
    // Try to continue anyway
  }

  // Step 4: Attempt recovery by dumping and recreating
  console.log('\n🔧 Attempting recovery...');
  try {
    if (!db) {
      db = await open({
        filename: DB_PATH,
        driver: sqlite3.Database
      });
    }
    
    console.log('📝 Extracting schema...');
    let schema;
    try {
      schema = await db.all("SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL");
    } catch (err) {
      console.warn('⚠️  Could not extract full schema:', err.message);
      schema = [];
    }
    
    console.log('📝 Extracting data from recoverable tables...');
    let sqlDump = '-- Database Recovery Dump\n';
    sqlDump += '-- Generated: ' + new Date().toISOString() + '\n\n';
    
    // Add schema
    for (const table of schema) {
      sqlDump += table.sql + ';\n\n';
    }
    
    // Try to export data from each table
    let tables = [];
    try {
      tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    } catch (err) {
      console.warn('⚠️  Could not list tables:', err.message);
    }
    
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
    
    // Save dump
    fs.writeFileSync(DUMP_PATH, sqlDump);
    console.log('✅ Data dump created:', DUMP_PATH);
    
    await db.close();
    
    // Create new database from dump
    console.log('\n🔨 Creating new database...');
    const newDb = await open({
      filename: RECOVERY_PATH,
      driver: sqlite3.Database
    });
    
    // Execute the dump
    const statements = sqlDump.split(';').filter(s => s.trim() && !s.trim().startsWith('--'));
    let success = 0;
    let failed = 0;
    
    for (const stmt of statements) {
      try {
        await newDb.exec(stmt);
        success++;
      } catch (err) {
        failed++;
        console.warn('  ⚠️  Failed statement:', err.message);
      }
    }
    
    console.log(`✅ Executed ${success} statements (${failed} failed)`);
    
    // Verify new database
    const newIntegrityCheck = await newDb.get('PRAGMA integrity_check');
    if (newIntegrityCheck.integrity_check === 'ok') {
      console.log('✅ New database integrity: OK');
      
      // Replace old database with new one
      await newDb.close();
      const oldPath = DB_PATH + '.old-' + Date.now();
      fs.renameSync(DB_PATH, oldPath);
      fs.copyFileSync(RECOVERY_PATH, DB_PATH);
      
      console.log('\n✅ Recovery complete!');
      console.log('   Original corrupted DB:', oldPath);
      console.log('   Backup:', BACKUP_PATH);
      console.log('   SQL dump:', DUMP_PATH);
      console.log('   Recovered DB:', RECOVERY_PATH);
      console.log('   Active DB:', DB_PATH);
      console.log('\n⚠️  IMPORTANT: Test the recovered database thoroughly before restarting the bot!');
    } else {
      console.error('❌ New database is also corrupted');
      await newDb.close();
      process.exit(1);
    }
    
  } catch (err) {
    console.error('❌ Recovery failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
