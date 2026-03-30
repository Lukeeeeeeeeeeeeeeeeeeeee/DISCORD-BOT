const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');

async function runStressAudit() {
  const tmp = require('os').tmpdir();
  const dbPath = path.join(tmp, `stress-audit-${Date.now()}.db`);
  process.env.DATABASE_PATH = dbPath;
  process.env.ANALYTICS_FLUSH_MS = '100'; // Aggressive flush for testing

  console.log('--- Adversarial Stress Audit Starting ---');
  console.log(`Temp DB: ${dbPath}`);

  // Re-init DB and Analytics
  delete require.cache[require.resolve('../src/db_async.js')];
  delete require.cache[require.resolve('../src/lib/analytics.js')];
  delete require.cache[require.resolve('../src/lib/transactions.js')];

  const db = require('../src/db_async');
  const analytics = require('../src/lib/analytics');

  // 1. Concurrent Joins (Transaction Stress)
  console.log('Simulating 50 concurrent joins...');
  const joinPromises = [];
  for (let i = 0; i < 50; i++) {
    joinPromises.push(analytics.recordJoin({
      guildId: 'G1',
      userId: `U${i}`,
      joinedAt: Date.now()
    }));
  }
  await Promise.all(joinPromises);

  // 2. High Volume Messages (Buffer/Flush Stress)
  console.log('Simulating 1000 message events across 10 channels...');
  for (let i = 0; i < 1000; i++) {
    analytics.recordMessage({
      guildId: 'G1',
      channelId: `C${i % 10}`,
      userId: `U${i % 50}`,
      timestamp: Date.now()
    });
  }

  // Force flush
  console.log('Forcing analytics flush...');
  await analytics.flushAll();

  // 3. Verification
  console.log('Verifying results...');
  const guildStats = await db.get('SELECT joins, message_count FROM analytics_daily_guild WHERE guild_id = ?', 'G1');
  const memberCount = await db.get('SELECT COUNT(*) as cnt FROM analytics_members WHERE guild_id = ?', 'G1');
  const totalMessages = await db.get('SELECT SUM(message_count) as cnt FROM analytics_daily_channels WHERE guild_id = ?', 'G1');

  let failed = false;
  if (guildStats.joins !== 50) { console.error(`FAIL: Joins = ${guildStats.joins}, expected 50`); failed = true; }
  if (memberCount.cnt !== 50) { console.error(`FAIL: Members = ${memberCount.cnt}, expected 50`); failed = true; }
  if (guildStats.message_count !== 1000) { console.error(`FAIL: Guild Msg = ${guildStats.message_count}, expected 1000`); failed = true; }
  if (totalMessages.cnt !== 1000) { console.error(`FAIL: Channel Msg = ${totalMessages.cnt}, expected 1000`); failed = true; }

  if (!failed) {
    console.log('--- STRESS AUDIT SUCCESS ---');
    console.log('System handled high-concurrency transactions and buffered flushes perfectly.');
  } else {
    console.log('--- STRESS AUDIT FAILED ---');
    process.exit(1);
  }

  await db.close();
  try { fs.unlinkSync(dbPath); } catch (e) { void e; }
}

runStressAudit().catch(err => {
  console.error('Stress audit crashed:', err);
  process.exit(1);
});
