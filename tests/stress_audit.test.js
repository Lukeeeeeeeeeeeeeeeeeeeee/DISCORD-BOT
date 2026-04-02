const path = require('path');
const fs = require('fs');

jest.setTimeout(30000);

describe('stress audit', () => {
  test('handles concurrent joins and buffered message flushes', async () => {
    const tmp = require('os').tmpdir();
    const dbPath = path.join(tmp, `stress-audit-${Date.now()}.db`);
    const originalDbPath = process.env.DATABASE_PATH;
    const originalFlushMs = process.env.ANALYTICS_FLUSH_MS;

    process.env.DATABASE_PATH = dbPath;
    process.env.ANALYTICS_FLUSH_MS = '0';

    delete require.cache[require.resolve('../src/db_async.js')];
    delete require.cache[require.resolve('../src/lib/analytics.js')];
    delete require.cache[require.resolve('../src/lib/transactions.js')];

    const db = require('../src/db_async');
    const analytics = require('../src/lib/analytics');

    try {
      const joinPromises = [];
      for (let i = 0; i < 50; i++) {
        joinPromises.push(analytics.recordJoin({
          guildId: 'G1',
          userId: `U${i}`,
          joinedAt: Date.now()
        }));
      }
      await Promise.all(joinPromises);

      for (let i = 0; i < 1000; i++) {
        await analytics.recordMessage({
          guildId: 'G1',
          channelId: `C${i % 10}`,
          userId: `U${i % 50}`,
          timestamp: Date.now()
        });
      }

      await analytics.flushAll();

      const guildStats = await db.get(
        'SELECT joins, message_count FROM analytics_daily_guild WHERE guild_id = ?',
        'G1'
      );
      const memberCount = await db.get(
        'SELECT COUNT(*) as cnt FROM analytics_members WHERE guild_id = ?',
        'G1'
      );
      const totalMessages = await db.get(
        'SELECT SUM(message_count) as cnt FROM analytics_daily_channels WHERE guild_id = ?',
        'G1'
      );

      expect(guildStats.joins).toBe(50);
      expect(memberCount.cnt).toBe(50);
      expect(guildStats.message_count).toBe(1000);
      expect(totalMessages.cnt).toBe(1000);
    } finally {
      await db.close();
      delete require.cache[require.resolve('../src/db_async.js')];
      delete require.cache[require.resolve('../src/lib/analytics.js')];
      delete require.cache[require.resolve('../src/lib/transactions.js')];

      if (typeof originalDbPath === 'undefined') {
        delete process.env.DATABASE_PATH;
      } else {
        process.env.DATABASE_PATH = originalDbPath;
      }

      if (typeof originalFlushMs === 'undefined') {
        delete process.env.ANALYTICS_FLUSH_MS;
      } else {
        process.env.ANALYTICS_FLUSH_MS = originalFlushMs;
      }

      try {
        fs.unlinkSync(dbPath);
      } catch (error) {
        void error;
      }
    }
  });
});
