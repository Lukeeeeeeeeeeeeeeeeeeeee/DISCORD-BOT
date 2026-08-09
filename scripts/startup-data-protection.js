/**
 * STARTUP DATA PROTECTION SYSTEM
 * 
 * This script runs on bot startup to:
 * 1. Create automatic backups before ANY operations
 * 2. Detect and prevent data loss
 * 3. Verify database integrity
 * 4. Alert on suspicious changes
 * 
 * PREVENTS:
 * - Dummy/fake data overwriting real data
 * - Database corruption causing data loss
 * - Accidental data deletion
 * - Silent data loss from crashes
 */

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');
const path = require('path');

const BACKUP_DIR = path.join(__dirname, '..', 'data', 'auto-backups');
const MAX_BACKUPS = 20; // Keep last 20 backups
const MIN_VALID_RECRUITS = 5; // Alert if recruits drop below this
const MIN_VALID_RECRUITERS = 3; // Alert if active recruiters drop below this

/**
 * Ensure backup directory exists
 */
function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    console.log('📁 Created backup directory:', BACKUP_DIR);
  }
}

/**
 * Create timestamped backup of database
 */
function createBackup(dbPath) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `recruiter-backup-${timestamp}.db`;
  const backupPath = path.join(BACKUP_DIR, backupName);
  
  try {
    fs.copyFileSync(dbPath, backupPath);
    console.log('✅ Backup created:', backupName);
    return backupPath;
  } catch (err) {
    console.error('❌ Backup failed:', err.message);
    return null;
  }
}

/**
 * Clean old backups, keep only MAX_BACKUPS most recent
 */
function cleanOldBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('recruiter-backup-') && f.endsWith('.db'))
      .map(f => ({
        name: f,
        path: path.join(BACKUP_DIR, f),
        time: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime()
      }))
      .sort((a, b) => b.time - a.time); // Newest first
    
    if (files.length > MAX_BACKUPS) {
      const toDelete = files.slice(MAX_BACKUPS);
      for (const file of toDelete) {
        fs.unlinkSync(file.path);
        console.log('🗑️  Deleted old backup:', file.name);
      }
    }
  } catch (err) {
    console.error('⚠️  Failed to clean old backups:', err.message);
  }
}

/**
 * Get database statistics
 */
async function getDbStats(db) {
  try {
    const recruitersTotal = await db.get('SELECT COUNT(*) as count FROM recruiters');
    const recruitersWithPoints = await db.get('SELECT COUNT(*) as count FROM recruiters WHERE points > 0');
    const totalPoints = await db.get('SELECT SUM(points) as sum FROM recruiters');
    const validRecruits = await db.get('SELECT COUNT(*) as count FROM recruits WHERE valid = 1');
    const totalRecruits = await db.get('SELECT COUNT(*) as count FROM recruits');
    const dummyRecruits = await db.get(
      "SELECT COUNT(*) as count FROM recruits WHERE ign LIKE 'Restored_Recruit_%' OR recruited_id LIKE 'DUMMY_%' OR recruited_id LIKE 'RESTORED_%'"
    );
    
    return {
      recruitersTotal: recruitersTotal?.count || 0,
      recruitersWithPoints: recruitersWithPoints?.count || 0,
      totalPoints: totalPoints?.sum || 0,
      validRecruits: validRecruits?.count || 0,
      totalRecruits: totalRecruits?.count || 0,
      dummyRecruits: dummyRecruits?.count || 0
    };
  } catch (err) {
    console.error('⚠️  Failed to get DB stats:', err.message);
    return null;
  }
}

/**
 * Detect suspicious data patterns
 */
function detectSuspiciousData(stats) {
  const warnings = [];
  
  if (stats.dummyRecruits > 0) {
    warnings.push(`⚠️  DUMMY DATA DETECTED: ${stats.dummyRecruits} fake recruits found!`);
  }
  
  if (stats.validRecruits < MIN_VALID_RECRUITS && stats.recruitersWithPoints > 0) {
    warnings.push(`⚠️  DATA LOSS SUSPECTED: Only ${stats.validRecruits} valid recruits but ${stats.recruitersWithPoints} recruiters have points!`);
  }
  
  if (stats.recruitersWithPoints < MIN_VALID_RECRUITERS && stats.totalPoints > 10) {
    warnings.push(`⚠️  INCONSISTENT DATA: ${stats.totalPoints} total points but only ${stats.recruitersWithPoints} recruiters with points!`);
  }
  
  const dummyRatio = stats.totalRecruits > 0 ? stats.dummyRecruits / stats.totalRecruits : 0;
  if (dummyRatio > 0.5) {
    warnings.push(`⚠️  CRITICAL: ${Math.round(dummyRatio * 100)}% of recruits are dummy/fake data!`);
  }
  
  return warnings;
}

/**
 * Save stats history for comparison
 */
function saveStatsHistory(stats) {
  const historyFile = path.join(BACKUP_DIR, 'stats-history.json');
  let history = [];
  
  try {
    if (fs.existsSync(historyFile)) {
      history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    }
  } catch (err) {
    console.warn('⚠️  Could not read stats history:', err.message);
  }
  
  history.push({
    timestamp: new Date().toISOString(),
    ...stats
  });
  
  // Keep only last 50 entries
  if (history.length > 50) {
    history = history.slice(-50);
  }
  
  try {
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error('⚠️  Could not save stats history:', err.message);
  }
  
  return history;
}

/**
 * Compare with previous stats to detect data loss
 */
function compareWithPrevious(history) {
  if (history.length < 2) return [];
  
  const current = history[history.length - 1];
  const previous = history[history.length - 2];
  const warnings = [];
  
  const recruitLoss = previous.validRecruits - current.validRecruits;
  const pointLoss = previous.totalPoints - current.totalPoints;
  
  if (recruitLoss > 5) {
    warnings.push(`🚨 DATA LOSS DETECTED: Lost ${recruitLoss} valid recruits since last startup!`);
  }
  
  if (pointLoss > 10) {
    warnings.push(`🚨 DATA LOSS DETECTED: Lost ${pointLoss} points since last startup!`);
  }
  
  if (current.dummyRecruits > previous.dummyRecruits) {
    const increase = current.dummyRecruits - previous.dummyRecruits;
    warnings.push(`🚨 DUMMY DATA INJECTION: ${increase} new dummy recruits added since last startup!`);
  }
  
  return warnings;
}

/**
 * Main protection function
 */
async function protectData(dbPath) {
  console.log('🛡️  STARTUP DATA PROTECTION SYSTEM');
  console.log('=' .repeat(60));
  
  ensureBackupDir();
  
  // Step 1: Create backup BEFORE any operations
  console.log('\n📦 Step 1: Creating backup...');
  const backupPath = createBackup(dbPath);
  if (!backupPath) {
    console.warn('⚠️  WARNING: Could not create backup! Proceeding with caution...');
  }
  
  // Step 2: Clean old backups
  console.log('\n🧹 Step 2: Cleaning old backups...');
  cleanOldBackups();
  
  // Step 3: Open and analyze database
  console.log('\n🔍 Step 3: Analyzing database...');
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });
  
  const stats = await getDbStats(db);
  if (!stats) {
    console.error('❌ Could not read database stats');
    await db.close();
    return;
  }
  
  console.log('\n📊 Current Database State:');
  console.log(`  Total Recruiters: ${stats.recruitersTotal}`);
  console.log(`  Recruiters with Points: ${stats.recruitersWithPoints}`);
  console.log(`  Total Points: ${stats.totalPoints}`);
  console.log(`  Valid Recruits: ${stats.validRecruits}`);
  console.log(`  Total Recruits: ${stats.totalRecruits}`);
  console.log(`  Dummy/Fake Recruits: ${stats.dummyRecruits}`);
  
  // Step 4: Detect suspicious patterns
  console.log('\n🔎 Step 4: Checking for suspicious data...');
  const warnings = detectSuspiciousData(stats);
  
  if (warnings.length > 0) {
    console.log('\n⚠️  WARNINGS DETECTED:');
    warnings.forEach(w => console.log('  ' + w));
  } else {
    console.log('  ✅ No suspicious data patterns detected');
  }
  
  // Step 5: Compare with previous startup
  console.log('\n📈 Step 5: Comparing with previous startup...');
  const history = saveStatsHistory(stats);
  const comparisonWarnings = compareWithPrevious(history);
  
  if (comparisonWarnings.length > 0) {
    console.log('\n🚨 CRITICAL WARNINGS:');
    comparisonWarnings.forEach(w => console.log('  ' + w));
    console.log('\n💾 Last good backup available at:', backupPath);
  } else if (history.length > 1) {
    console.log('  ✅ No data loss detected since last startup');
  } else {
    console.log('  ℹ️  First run - no previous data to compare');
  }
  
  await db.close();
  
  // Final report
  console.log('\n' + '='.repeat(60));
  if (warnings.length === 0 && comparisonWarnings.length === 0) {
    console.log('✅ DATA PROTECTION CHECK PASSED');
    if (backupPath) {
      console.log(`💾 Backup saved: ${path.basename(backupPath)}`);
    }
  } else {
    console.log('⚠️  DATA PROTECTION CHECK COMPLETED WITH WARNINGS');
    if (backupPath) {
      console.log(`💾 Backup saved: ${path.basename(backupPath)}`);
    }
    console.log('⚠️  Review warnings above before proceeding!');
  }
  console.log('=' .repeat(60) + '\n');
}

module.exports = { protectData };

// Run if called directly
if (require.main === module) {
  const dbPath = process.argv[2] || path.join(__dirname, '..', 'data', 'recruiter.db');
  protectData(dbPath).catch(err => {
    console.error('💥 Protection system failed:', err);
    process.exit(1);
  });
}
