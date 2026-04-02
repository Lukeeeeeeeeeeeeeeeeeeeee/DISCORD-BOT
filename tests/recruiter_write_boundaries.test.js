const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { applyCustomMultiplier } = require('../src/lib/economy');
const { upsertActive } = require('../src/repos/absences-repo');
const { upsert: upsertTrialFastTrack } = require('../src/repos/trial-fast-track-repo');
const { storeWeeklyCalculation } = require('../src/lib/recruiting-system');

async function createDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE recruiters (
      guild_id TEXT NOT NULL,
      id TEXT NOT NULL,
      points INTEGER DEFAULT 0,
      warnings INTEGER DEFAULT 0,
      promoted INTEGER DEFAULT 0,
      channel_base INTEGER DEFAULT 4,
      PRIMARY KEY (guild_id, id)
    );
    CREATE TABLE multipliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      recruiter_id TEXT NOT NULL,
      value REAL NOT NULL,
      type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE absences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      recruiter_id TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      active INTEGER DEFAULT 1
    );
    CREATE TABLE trial_fast_track (
      guild_id TEXT NOT NULL,
      recruiter_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      recruit1_id TEXT,
      recruit2_id TEXT,
      recruit3_id TEXT,
      count INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, recruiter_id)
    );
    CREATE TABLE weekly_calculations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      recruiter_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      week_start INTEGER,
      recruits7d INTEGER DEFAULT 0,
      activity_rate REAL DEFAULT 0,
      verify_rate REAL DEFAULT 0,
      retention REAL DEFAULT 0,
      warnings INTEGER DEFAULT 0,
      absent INTEGER DEFAULT 0,
      previous_min_req INTEGER,
      calculated_min_req INTEGER NOT NULL,
      role_base INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX uniq_weekly_calc_recruiter_week ON weekly_calculations(guild_id, recruiter_id, week_start);
  `);
  return db;
}

describe('recruiter write boundaries', () => {
  test('multiplier, absence, trial-fast-track, and weekly calculations auto-seed recruiter rows', async () => {
    const db = await createDb();

    await applyCustomMultiplier(db, 'recruiter-1', {
      value: 2,
      type: 'event_x2',
      days: 7
    }, { guildId: 'guild-1' });

    await upsertActive(db, 'guild-1', 'recruiter-2', {
      startDate: '2026-04-01',
      endDate: '2026-04-10',
      createdBy: 'staff-1'
    });

    await upsertTrialFastTrack(db, 'guild-1', 'recruiter-3', {
      startedAt: Date.now(),
      updatedAt: Date.now(),
      count: 1
    });

    await storeWeeklyCalculation(db, {
      guildId: 'guild-1',
      recruiterId: 'recruiter-4',
      weekStart: 123,
      recruits7d: 2,
      activityRate: 2,
      verifyRate: 1,
      retention: 1,
      warnings: 0,
      absent: 0,
      calculatedMinReq: 2,
      roleBase: 2
    });

    const recruiters = await db.all('SELECT guild_id, id FROM recruiters ORDER BY id');
    expect(recruiters).toEqual([
      { guild_id: 'guild-1', id: 'recruiter-1' },
      { guild_id: 'guild-1', id: 'recruiter-2' },
      { guild_id: 'guild-1', id: 'recruiter-3' },
      { guild_id: 'guild-1', id: 'recruiter-4' }
    ]);

    await db.close();
  });
});
