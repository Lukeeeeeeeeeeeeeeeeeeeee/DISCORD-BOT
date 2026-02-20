const { Collection } = require('discord.js');

jest.mock('../src/constants', () => ({
  GUILD_ID: 'guild-1',
  TESTING_USER_ID: 'owner-1',
  ROLE_IDS: {
    ONBOARDING: ['react-fire', 'react-water', 'react-air'],
    ONBOARDING_FIRE: 'react-fire',
    ONBOARDING_WATER: 'react-water',
    ONBOARDING_AIR: 'react-air',
    TEAM_MEMBER: {
      EU: 'team-eu',
      NA: 'team-na',
      AS: 'team-as'
    }
  },
  REGION_ROLE_IDS: {
    EU: 'region-eu',
    NA: 'region-na',
    AS: 'region-as'
  },
  ACTIVITY_CHECK: {
    OWNER_IDS: ['owner-1'],
    TEAM_TO_INACTIVE_ROLE: {
      EU: 'inactive-eu',
      NA: 'inactive-na',
      AS: 'inactive-as'
    },
    INACTIVE_ROLE_POOL: ['inactive-eu', 'inactive-na', 'inactive-as'],
    TARGET_ROLE_IDS: ['member-role'],
    PRESERVE_ROLE_IDS: ['react-fire'],
    EXEMPT_ROLE_IDS: [],
    PRESERVE_REGION_ROLES: true,
    PRESERVE_ONBOARDING_ROLES: true,
    PRESERVE_STAFF_ROLES: true
  }
}));

jest.mock('../src/lib/permissions', () => ({
  getStaffRoleIds: jest.fn(() => [])
}));

const mockReplyError = jest.fn(async () => null);
jest.mock('../src/lib/embeds', () => ({
  replyError: (...args) => mockReplyError(...args)
}));

const cmd = require('../src/commands/activitycheck');

function makeRole(id, extra = {}) {
  return { id, managed: false, editable: true, ...extra };
}

function makeMember(id, roleIds, roleMap) {
  const cache = new Collection();
  for (const roleId of roleIds) {
    cache.set(roleId, roleMap.get(roleId));
  }
  return {
    id,
    user: { id, bot: false },
    roles: {
      cache,
      add: jest.fn(async (roleId) => {
        const role = roleMap.get(roleId);
        if (role) cache.set(roleId, role);
        return null;
      }),
      remove: jest.fn(async (roleIdsToRemove) => {
        const list = Array.isArray(roleIdsToRemove) ? roleIdsToRemove : [roleIdsToRemove];
        for (const roleId of list) cache.delete(roleId);
        return null;
      })
    }
  };
}

function makeInteraction({ userId = 'owner-1', preview = false } = {}) {
  const roleMap = new Collection([
    ['guild-1', makeRole('guild-1')],
    ['member-role', makeRole('member-role')],
    ['team-eu', makeRole('team-eu')],
    ['region-eu', makeRole('region-eu')],
    ['react-fire', makeRole('react-fire')],
    ['vip-role', makeRole('vip-role')],
    ['inactive-eu', makeRole('inactive-eu')],
    ['inactive-na', makeRole('inactive-na')],
    ['inactive-as', makeRole('inactive-as')]
  ]);

  const reactedMember = makeMember('reacted-user', ['member-role', 'team-eu', 'vip-role'], roleMap);
  const targetMember = makeMember('target-user', ['member-role', 'team-eu', 'region-eu', 'react-fire', 'vip-role'], roleMap);
  const untargetedMember = makeMember('untargeted-user', ['vip-role'], roleMap);

  const members = new Collection([
    [reactedMember.id, reactedMember],
    [targetMember.id, targetMember],
    [untargetedMember.id, untargetedMember]
  ]);

  const reactedUsers = new Collection([
    [reactedMember.id, { id: reactedMember.id, bot: false }]
  ]);

  const message = {
    id: 'message-1',
    reactions: {
      cache: new Collection([
        ['emoji', { users: { fetch: jest.fn(async () => reactedUsers) } }]
      ])
    }
  };

  const channel = {
    id: 'channel-1',
    guildId: 'guild-1',
    isTextBased: () => true,
    messages: {
      fetch: jest.fn(async () => message)
    }
  };

  const guild = {
    id: 'guild-1',
    channels: {
      cache: new Collection([
        [channel.id, channel]
      ]),
      fetch: jest.fn(async (id) => {
        if (id === channel.id) return channel;
        return null;
      })
    },
    roles: {
      cache: roleMap,
      fetch: jest.fn(async () => roleMap)
    },
    members: {
      fetch: jest.fn(async () => members)
    }
  };

  const interaction = {
    user: { id: userId },
    guild,
    channel,
    options: {
      getSubcommand: jest.fn(() => 'role'),
      getString: jest.fn(() => 'message-1'),
      getChannel: jest.fn(() => channel),
      getBoolean: jest.fn(() => preview),
      getInteger: jest.fn(() => null)
    },
    deferReply: jest.fn(async () => null),
    editReply: jest.fn(async () => null)
  };

  return { interaction, targetMember };
}

describe('activitycheck command', () => {
  beforeEach(() => {
    mockReplyError.mockClear();
  });

  test('rejects non-owner users', async () => {
    const { interaction } = makeInteraction({ userId: 'someone-else' });
    await cmd.execute(interaction);
    expect(mockReplyError).toHaveBeenCalled();
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  test('assigns team-matched inactive role and removes non-preserved roles for non-reactors', async () => {
    const { interaction, targetMember } = makeInteraction({ userId: 'owner-1', preview: false });

    await cmd.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(targetMember.roles.add).toHaveBeenCalledWith(
      'inactive-eu',
      expect.stringContaining('Activity check')
    );
    expect(targetMember.roles.remove).toHaveBeenCalledTimes(1);
    const removed = targetMember.roles.remove.mock.calls[0][0];
    expect(removed).toEqual(expect.arrayContaining(['member-role', 'team-eu', 'vip-role']));

    expect(targetMember.roles.cache.has('inactive-eu')).toBe(true);
    expect(targetMember.roles.cache.has('region-eu')).toBe(true);
    expect(targetMember.roles.cache.has('react-fire')).toBe(true);
    expect(interaction.editReply).toHaveBeenCalled();
  });

  test('accepts Discord message URL for messageid and resolves channel automatically', async () => {
    const { interaction, targetMember } = makeInteraction({ userId: 'owner-1', preview: false });
    interaction.options.getString = jest.fn(() => 'https://discord.com/channels/guild-1/channel-1/message-1');
    interaction.options.getChannel = jest.fn(() => null);

    await cmd.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(targetMember.roles.add).toHaveBeenCalledWith(
      'inactive-eu',
      expect.stringContaining('Activity check')
    );
    expect(interaction.editReply).toHaveBeenCalled();
  });

  test('counts reacted users across paginated reaction user fetches', async () => {
    const { interaction } = makeInteraction({ userId: 'owner-1', preview: true });

    const page1 = new Collection();
    for (let i = 1; i <= 100; i += 1) {
      page1.set(`u${i}`, { id: `u${i}`, bot: false });
    }
    const page2 = new Collection();
    for (let i = 101; i <= 185; i += 1) {
      page2.set(`u${i}`, { id: `u${i}`, bot: false });
    }

    const fetchUsers = jest.fn(async (opts = {}) => {
      if (!opts.after) return page1;
      return page2;
    });

    const pagedMessage = {
      id: 'message-1',
      reactions: {
        cache: new Collection([
          ['emoji', { users: { fetch: fetchUsers } }]
        ])
      }
    };

    interaction.channel.messages.fetch = jest.fn(async () => pagedMessage);

    await cmd.execute(interaction);

    expect(fetchUsers).toHaveBeenCalledTimes(2);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Reacted users: **185**')
      })
    );
  });
});
