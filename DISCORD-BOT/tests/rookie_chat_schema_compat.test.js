jest.mock('../src/lib/rookie-points', () => ({
  addRookiePoints: jest.fn(async () => ({ points: 0 })),
  formatPoints: jest.fn((v) => String(v))
}));

const { trackRookieChatMessage } = require('../src/lib/rookie-chat');
const { ROLE_IDS } = require('../src/constants');

function makeMember(id = 'U1') {
  return {
    id,
    roles: {
      cache: {
        has: (roleId) => roleId === ROLE_IDS.ROOKIE
      }
    }
  };
}

function makeGuild(id = 'G1') {
  return {
    id,
    channels: {
      cache: {
        get: () => null
      }
    }
  };
}

describe('rookie chat schema compatibility', () => {
  test('uses guild-aware query and upsert path when guild_id schema is present', async () => {
    const db = {
      get: jest.fn(async () => ({ message_count: 0, awarded_chunks: 0 })),
      run: jest.fn(async () => ({ changes: 1 }))
    };
    await trackRookieChatMessage({
      db,
      member: makeMember(),
      guild: makeGuild(),
      client: { user: { id: 'BOT1' } }
    });

    expect(db.get).toHaveBeenCalled();
    expect(db.get.mock.calls[0][0]).toContain('WHERE guild_id = ? AND member_id = ? AND week_start = ?');
    expect(db.run).toHaveBeenCalled();
    expect(db.run.mock.calls[0][0]).toContain('ON CONFLICT(guild_id, member_id, week_start)');
  });

  test('falls back to legacy upsert conflict target when guild_id conflict is unavailable', async () => {
    const db = {
      get: jest.fn(async () => ({ message_count: 0, awarded_chunks: 0 })),
      run: jest.fn()
    };
    db.run
      .mockRejectedValueOnce(new Error('SQLITE_ERROR: ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint'))
      .mockResolvedValueOnce({ changes: 1 });

    await trackRookieChatMessage({
      db,
      member: makeMember('U2'),
      guild: makeGuild('G2'),
      client: { user: { id: 'BOT1' } }
    });

    expect(db.run).toHaveBeenCalledTimes(2);
    expect(db.run.mock.calls[0][0]).toContain('ON CONFLICT(guild_id, member_id, week_start)');
    expect(db.run.mock.calls[1][0]).toContain('ON CONFLICT(member_id, week_start)');
  });
});
