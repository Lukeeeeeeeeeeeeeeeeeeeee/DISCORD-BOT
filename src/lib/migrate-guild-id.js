/**
 * Migrate database from old guild ID to new guild ID
 * This runs automatically on startup if needed
 */

const { GUILD_ID } = require('../constants');

const OLD_GUILD_ID = '1331020304763453522';

async function migrateGuildIdIfNeeded(db) {
  const currentGuildId = GUILD_ID;
  
  if (!currentGuildId || currentGuildId === OLD_GUILD_ID) {
    console.log('⏭️  No guild migration needed');
    return;
  }

  try {
    // Check if old guild data exists
    const oldData = await db.get(
      'SELECT COUNT(*) as count FROM recruiters WHERE guild_id = ?',
      [OLD_GUILD_ID]
    );

    if (!oldData || oldData.count === 0) {
      console.log('✅ Guild data already migrated or no old data exists');
      return;
    }

    console.log(`🔄 Migrating ${oldData.count} records from old guild ${OLD_GUILD_ID} to ${currentGuildId}...`);

    // Get all table names
    const tables = await db.all(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    );

    let totalUpdated = 0;

    for (const { name: tableName } of tables) {
      // Check if table has guild_id column
      const columns = await db.all(`PRAGMA table_info(${tableName})`);
      const hasGuildId = columns.some(col => col.name === 'guild_id');

      if (hasGuildId) {
        try {
          const result = await db.run(
            `UPDATE ${tableName} SET guild_id = ? WHERE guild_id = ?`,
            [currentGuildId, OLD_GUILD_ID]
          );
          
          if (result.changes > 0) {
            console.log(`  ✓ ${tableName}: ${result.changes} rows`);
            totalUpdated += result.changes;
          }
        } catch (err) {
          // Some tables might be corrupted or have issues, skip them
          console.warn(`  ⚠️  ${tableName}: ${err.message}`);
        }
      }
    }

    if (totalUpdated > 0) {
      console.log(`✅ Guild migration complete! Updated ${totalUpdated} total rows`);
    } else {
      console.log('✅ No rows needed migration');
    }

  } catch (err) {
    console.error('❌ Guild migration failed:', err);
    // Don't throw - let the bot continue even if migration fails
  }
}

module.exports = { migrateGuildIdIfNeeded };
