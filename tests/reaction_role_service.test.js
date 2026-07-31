const {
  normalizeEmojiKey,
  handleReactionRoleAdd,
  syncExistingReactionRoleUsers,
  upsertReactionRole,
  findReactionRole
} = require('../src/services/reaction-role-service');

describe('reaction-role-service', () => {
  test('normalizes unicode and custom emoji keys', () => {
    expect(normalizeEmojiKey('✅')).toBe('✅');
    expect(normalizeEmojiKey({ id: '123', name: 'tick' })).toBe('123');
    expect(normalizeEmojiKey({ name: '✅' })).toBe('✅');
  });

  test('upserts and finds mappings', async () => {
    const rows = new Map();
    const db = {
      run: jest.fn(async (sql, ...params) => {
        rows.set(`${params[0]}:${params[2]}:${params[3]}`, {
          guild_id: params[0],
          channel_id: params[1],
          message_id: params[2],
          emoji_key: params[3],
          role_id: params[4],
          created_by: params[5]
        });
      }),
      get: jest.fn(async (sql, guildId, messageId, emojiKey) => rows.get(`${guildId}:${messageId}:${emojiKey}`) || null)
    };

    await upsertReactionRole(db, {
      guildId: 'g1',
      channelId: 'c1',
      messageId: 'm1',
      emojiKey: '✅',
      roleId: 'r1',
      createdBy: 'admin'
    });

    await expect(findReactionRole(db, 'g1', 'm1', '✅')).resolves.toMatchObject({
      guild_id: 'g1',
      role_id: 'r1'
    });
  });

  test('assigns configured role and records assignment', async () => {
    const add = jest.fn(async () => {});
    const db = {
      get: jest.fn(async () => ({
        guild_id: 'g1',
        channel_id: 'c1',
        message_id: 'm1',
        emoji_key: '✅',
        role_id: 'r1'
      })),
      run: jest.fn(async () => {})
    };
    const role = { id: 'r1', managed: false };
    const member = {
      roles: {
        cache: new Map(),
        add
      }
    };
    const guild = {
      id: 'g1',
      roles: { cache: new Map([['r1', role]]) },
      members: {
        me: {
          permissions: { has: jest.fn(() => true) },
          roles: {
            highest: {
              comparePositionTo: jest.fn(() => 1)
            }
          }
        },
        fetch: jest.fn(async () => member)
      }
    };
    const reaction = {
      emoji: { name: '✅' },
      message: { id: 'm1', guild }
    };

    await expect(handleReactionRoleAdd({ db, reaction, user: { id: 'u1', bot: false } })).resolves.toBe(true);

    expect(add).toHaveBeenCalledWith('r1', 'Reaction role');
    expect(db.run).toHaveBeenCalled();
  });

  test('syncs users who already reacted', async () => {
    const add = jest.fn(async () => {});
    const db = {
      get: jest.fn(async () => ({
        guild_id: 'g1',
        channel_id: 'c1',
        message_id: 'm1',
        emoji_key: '✅',
        role_id: 'r1'
      })),
      run: jest.fn(async () => {})
    };
    const role = { id: 'r1', managed: false };
    const guild = {
      id: 'g1',
      roles: { cache: new Map([['r1', role]]) },
      members: {
        me: {
          permissions: { has: jest.fn(() => true) },
          roles: {
            highest: {
              comparePositionTo: jest.fn(() => 1)
            }
          }
        },
        fetch: jest.fn(async () => ({
          roles: {
            cache: new Map(),
            add
          }
        }))
      }
    };
    const reaction = {
      emoji: { name: '✅' },
      users: {
        fetch: jest.fn(async () => new Map([
          ['u1', { id: 'u1', bot: false }],
          ['bot1', { id: 'bot1', bot: true }]
        ]))
      }
    };
    const message = {
      id: 'm1',
      guild,
      reactions: {
        cache: [reaction]
      }
    };

    await expect(syncExistingReactionRoleUsers({ db, message, emojiKey: '✅' })).resolves.toEqual({
      assigned: 1,
      scanned: 2
    });
    expect(add).toHaveBeenCalledTimes(1);
  });
});
