jest.mock('../src/lib/rookie-points', () => ({
  addRookiePoints: jest.fn(async () => ({ points: 5, promoted: false, promotionError: null })),
  formatPoints: jest.fn((value) => String(value))
}));

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const constants = require('../src/constants');
const { addRookiePoints } = require('../src/lib/rookie-points');
const { handleRookieWarLogMessage, isStructuredWarLogMessage } = require('../src/lib/rookie-war');

describe('rookie-war log handling', () => {
  let db;

  beforeEach(async () => {
    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
      CREATE TABLE rookie_war_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        type TEXT NOT NULL
      );
    `);
    addRookiePoints.mockClear();
  });

  afterEach(async () => {
    if (db) await db.close();
  });

  test('filters out casual chat that only mentions war keyword', async () => {
    expect(isStructuredWarLogMessage({
      content: 'that war was funny',
      mentions: { users: { size: 0 } },
      attachments: { size: 0 }
    })).toBe(false);
  });

  test('does not award points once per-window cap is exceeded and sends feedback', async () => {
    const guildId = 'G1';
    await db.run(
      'INSERT INTO rookie_war_logs (guild_id, member_id, message_id, created_at, type) VALUES (?, ?, ?, ?, ?)',
      guildId,
      'M1',
      'old1',
      Date.now() - 1_000,
      'war'
    );
    await db.run(
      'INSERT INTO rookie_war_logs (guild_id, member_id, message_id, created_at, type) VALUES (?, ?, ?, ?, ?)',
      guildId,
      'M1',
      'old2',
      Date.now() - 2_000,
      'war'
    );

    const send = jest.fn(async () => true);
    const message = {
      id: 'm3',
      channelId: constants.CHANNELS.ROOKIE_LOGS,
      content: 'war vs enemy https://example.com/proof',
      mentions: { users: { size: 1 } },
      attachments: { size: 0 },
      channel: { send }
    };
    const member = {
      id: 'M1',
      roles: { cache: { has: (id) => id === constants.ROLE_IDS.ROOKIE } },
      user: { bot: false }
    };
    const guild = { id: guildId };
    const client = { user: { id: 'BOT' } };

    await handleRookieWarLogMessage({ db, message, member, guild, client });

    expect(addRookiePoints).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0][0])).toContain('Window cap reached');
  });
});
