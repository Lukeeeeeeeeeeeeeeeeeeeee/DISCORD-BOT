const db = require('../src/db_async');
const { calculate7DayStats } = require('../src/lib/recruiting-system');

async function test() {
  console.log('--- Testing Recruiting System Hardening ---');
  
  // Mock guild object
  const mockGuild = {
    id: '123456789012345678',
    members: {
      fetch: async (ids) => {
        console.log(`Mock fetch for IDs: ${JSON.stringify(ids)}`);
        // Simulate that all but one are found
        const map = new Map();
        if (Array.isArray(ids)) {
          ids.forEach((id, index) => {
            if (index > 0) map.set(id, { id });
          });
        }
        return map;
      }
    }
  };

  const recruiterId = '111222333444555666';
  
  try {
    // 1. Insert mock data
    const now = Date.now();
    const weekAgo = now - (7 * 24 * 60 * 60 * 1000);
    const twoWeeksAgo = now - (14 * 24 * 60 * 60 * 1000);

    // Clean up
    await db.run('DELETE FROM recruits WHERE recruiter_id = ?', recruiterId);

    console.log('Inserting mock recruits...');
    // Cohort (8-14 days ago) - 3 recruits
    await db.run('INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, created_at, valid) VALUES (?, ?, ?, ?, ?, ?)', 
      mockGuild.id, recruiterId, 'user1', 'EU', twoWeeksAgo + 1000, 1);
    await db.run('INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, created_at, valid) VALUES (?, ?, ?, ?, ?, ?)', 
      mockGuild.id, recruiterId, 'user2', 'EU', twoWeeksAgo + 2000, 1);
    await db.run('INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, created_at, valid) VALUES (?, ?, ?, ?, ?, ?)', 
      mockGuild.id, recruiterId, 'user3', 'EU', twoWeeksAgo + 3000, 1);

    // Recent (0-7 days ago) - 2 recruits
    await db.run('INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, created_at, valid) VALUES (?, ?, ?, ?, ?, ?)', 
      mockGuild.id, recruiterId, 'user4', 'NA', weekAgo + 1000, 1);
    await db.run('INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, created_at, valid) VALUES (?, ?, ?, ?, ?, ?)', 
      mockGuild.id, recruiterId, 'user5', 'NA', weekAgo + 2000, 1);

    console.log('Calculating stats...');
    const stats = await calculate7DayStats(db, recruiterId, mockGuild, {
      sinceTs: weekAgo,
      untilTs: now,
      retentionEndTs: weekAgo,
      retentionStartTs: twoWeeksAgo
    });

    console.log('Stats Result:', JSON.stringify(stats, null, 2));

    if (stats.recruits7d === 2) {
      console.log('✅ Recent recruitment count correct (2)');
    } else {
      console.log(`❌ Recent recruitment count incorrect: ${stats.recruits7d}`);
    }

    // Retention cohort was 3 users. Mock fetch returns 2/3.
    // Result should be 0.666...
    if (Math.abs(stats.retention - (2/3)) < 0.01) {
      console.log('✅ Retention calculation correct (approx 0.67)');
    } else {
      console.log(`❌ Retention calculation incorrect: ${stats.retention}`);
    }

  } catch (err) {
    console.error('Test failed:', err);
  } finally {
    process.exit(0);
  }
}

test();
