const { Collection } = require('discord.js');

jest.mock('../src/constants', () => ({
  GUILD_ID: 'guild-1',
  TESTING_USER_ID: 'owner-1'
}));

const mockReplyError = jest.fn(async () => null);
jest.mock('../src/lib/embeds', () => ({
  replyError: (...args) => mockReplyError(...args)
}));

const command = require('../src/commands/pathbalance');

function makeRole(id, extra = {}) {
  return { id, name: id, ...extra };
}

function makeMember(id, roleIds, roleMap) {
  const cache = new Collection();
  for (const roleId of roleIds) {
    cache.set(roleId, roleMap.get(roleId));
  }
  return {
    id,
    user: { id, bot: false, tag: `${id}#0001` },
    roles: {
      cache,
      add: jest.fn(async (ids) => {
        const list = Array.isArray(ids) ? ids : [ids];
        for (const roleId of list) {
          const role = roleMap.get(roleId);
          if (role) cache.set(roleId, role);
        }
      }),
      remove: jest.fn(async (ids) => {
        const list = Array.isArray(ids) ? ids : [ids];
        for (const roleId of list) cache.delete(roleId);
      })
    }
  };
}

function makeInteraction({
  members,
  sourceRoleId = '1463200689252597770',
  preview = true,
  allMembers = false,
  confirm = '',
  removeSourceRole = true,
  deleteSourceRole = true
}) {
  const allRoleIds = [
    sourceRoleId,
    '1412808625529028767',
    '1412808625747132501',
    '1412808626040733738',
    '1421549298033627156',
    '1412808626099323003',
    '1412808626099323004',
    '1412808626136940575',
    '1473726598300700796',
    '1473726606634909829',
    '1473726616025694419',
    '1473726626733756438',
    '1473726632769622173',
    '1473726640939991261',
    '1473726648712036496',
    '1473726655565529259',
    '1473726663329316946',
    '1473726967277686854',
    '1473726977105072314',
    '1473726986508833061',
    '1473773076092027091',
    '1473773084430307390',
    '1473773094429655124',
    '1473773139652775968',
    '1473773194552021107',
    '1473773203905314871',
    '1473773213463875654',
    '1473773221273796618',
    '1473773230564180001'
  ];

  const roleMap = new Collection(allRoleIds.map((id) => [id, makeRole(id)]));
  const sourceMembers = new Collection(members.map((member) => [member.id, member]));
  const sourceRole = makeRole(sourceRoleId, {
    members: sourceMembers,
    delete: jest.fn(async () => true)
  });
  roleMap.set(sourceRoleId, sourceRole);

  const guild = {
    id: 'guild-1',
    members: {
      cache: sourceMembers,
      fetch: jest.fn(async () => sourceMembers)
    },
    roles: {
      cache: roleMap,
      fetch: jest.fn(async (id) => {
        if (!id) return roleMap;
        return roleMap.get(id) || null;
      })
    }
  };

  const interaction = {
    user: { id: 'owner-1' },
    member: {
      id: 'owner-1',
      roles: {
        cache: new Collection([
          ['1412808626136940575', makeRole('1412808626136940575')],
          ['1412808626099323003', makeRole('1412808626099323003')],
          ['1412808626099323004', makeRole('1412808626099323004')]
        ])
      },
      permissions: {
        has: jest.fn(() => false)
      }
    },
    guild,
    options: {
      getBoolean: jest.fn((name) => {
        if (name === 'preview') return preview;
        if (name === 'all_members') return allMembers;
        if (name === 'remove_source_role') return removeSourceRole;
        if (name === 'delete_source_role') return deleteSourceRole;
        return null;
      }),
      getString: jest.fn((name) => {
        if (name === 'confirm') return confirm;
        return null;
      }),
      getInteger: jest.fn(() => null),
      getRole: jest.fn(() => sourceRole)
    },
    deferReply: jest.fn(async () => null),
    editReply: jest.fn(async () => null)
  };

  return { interaction, sourceRole, roleMap };
}

describe('pathbalance command', () => {
  beforeEach(() => {
    mockReplyError.mockClear();
  });

  test('preview balances unassigned staged rookies across three paths', async () => {
    const roleMap = new Collection();
    const members = [
      makeMember('u1', ['1463200689252597770', '1412808625529028767'], roleMap),
      makeMember('u2', ['1463200689252597770', '1412808625529028767'], roleMap),
      makeMember('u3', ['1463200689252597770', '1412808625529028767'], roleMap),
      makeMember('u4', ['1463200689252597770', '1412808625529028767'], roleMap),
      makeMember('u5', ['1463200689252597770', '1412808625529028767'], roleMap),
      makeMember('u6', ['1463200689252597770', '1412808625529028767'], roleMap)
    ];
    const ctx = makeInteraction({ members, preview: true });

    // Rebuild members using actual roleMap from interaction context.
    const rebuilt = members.map((m) => makeMember(m.id, ['1463200689252597770', '1412808625529028767'], ctx.roleMap));
    ctx.sourceRole.members.clear();
    for (const m of rebuilt) ctx.sourceRole.members.set(m.id, m);

    await command.execute(ctx.interaction);

    expect(ctx.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Assigned paths (global): FIRE **2**, WATER **2**, AIR **2**')
      })
    );
  });

  test('live run keeps existing path and applies matching mod regional role', async () => {
    const member = makeMember(
      'mod1',
      [
        '1463200689252597770',
        '1412808626136940575',
        '1473726640939991261' // existing member WATER path
      ],
      new Collection()
    );
    const ctx = makeInteraction({ members: [member], preview: false, confirm: 'CONFIRM' });
    const liveMember = makeMember(
      'mod1',
      [
        '1463200689252597770',
        '1412808626136940575',
        '1473726640939991261'
      ],
      ctx.roleMap
    );
    ctx.sourceRole.members.clear();
    ctx.sourceRole.members.set(liveMember.id, liveMember);

    await command.execute(ctx.interaction);

    expect(liveMember.roles.add).toHaveBeenCalledWith(
      expect.arrayContaining(['1473773221273796618']),
      expect.stringContaining('One-time path balance')
    );
    expect(liveMember.roles.remove).toHaveBeenCalledWith(
      expect.arrayContaining(['1463200689252597770']),
      expect.stringContaining('One-time path balance')
    );
    expect(ctx.sourceRole.delete).toHaveBeenCalled();
  });

  test('uses highest tier only and strips lower-tier/inactive path roles', async () => {
    const ctx = makeInteraction({
      members: [makeMember(
        'mixed1',
        [
          '1463200689252597770',
          '1412808626099323004', // HELPER+ (highest for this user)
          '1473726640939991261', // member WATER (lower tier, should be removed)
          '1473726655565529259', // inactive FIRE (lower tier, should be removed)
          '1473773076092027091' // helper FIRE (lower than helper+)
        ],
        new Collection()
      )],
      preview: false,
      confirm: 'CONFIRM'
    });

    const member = makeMember(
      'mixed1',
      [
        '1463200689252597770',
        '1412808626099323004',
        '1473726640939991261',
        '1473726655565529259',
        '1473773076092027091'
      ],
      ctx.roleMap
    );
    ctx.sourceRole.members.clear();
    ctx.sourceRole.members.set(member.id, member);

    await command.execute(ctx.interaction);

    // Existing FIRE path hint should be preserved, but only in highest HELPER+ bucket.
    expect(member.roles.add).toHaveBeenCalledWith(
      expect.arrayContaining(['1473773139652775968']),
      expect.stringContaining('One-time path balance')
    );
    expect(member.roles.remove).toHaveBeenCalledWith(
      expect.arrayContaining([
        '1473726640939991261',
        '1473726655565529259',
        '1473773076092027091',
        '1463200689252597770'
      ]),
      expect.stringContaining('One-time path balance')
    );
  });

  test('all_members mode processes guild members without source-role scope', async () => {
    const ctx = makeInteraction({
      members: [makeMember(
        'all1',
        ['1412808625529028767'], // rookie only, not in source role
        new Collection()
      )],
      preview: true,
      allMembers: true,
      removeSourceRole: false,
      deleteSourceRole: false
    });
    const member = makeMember('all1', ['1412808625529028767'], ctx.roleMap);
    const allMembers = new Collection([[member.id, member]]);
    ctx.interaction.guild.members.cache = allMembers;
    ctx.interaction.guild.members.fetch = jest.fn(async () => allMembers);
    ctx.sourceRole.members.clear();

    await command.execute(ctx.interaction);

    expect(ctx.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Scope: **all guild members**')
      })
    );
    expect(ctx.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Processed members: **1**')
      })
    );
  });

  test('all_members cleanup keeps inactive bucket and strips leftover onboarding path roles', async () => {
    const ctx = makeInteraction({
      members: [makeMember(
        'inactive1',
        [
          '1473726655565529259', // inactive FIRE
          '1473726606634909829' // leftover rookie FIRE path
        ],
        new Collection()
      )],
      preview: false,
      allMembers: true,
      confirm: 'CONFIRM',
      removeSourceRole: false,
      deleteSourceRole: false
    });
    const member = makeMember(
      'inactive1',
      [
        '1473726655565529259',
        '1473726606634909829'
      ],
      ctx.roleMap
    );
    const allMembers = new Collection([[member.id, member]]);
    ctx.interaction.guild.members.cache = allMembers;
    ctx.interaction.guild.members.fetch = jest.fn(async () => allMembers);
    ctx.sourceRole.members.clear();

    await command.execute(ctx.interaction);

    expect(member.roles.add).not.toHaveBeenCalled();
    expect(member.roles.remove).toHaveBeenCalledWith(
      expect.arrayContaining(['1473726606634909829']),
      expect.stringContaining('One-time path balance')
    );
    expect(ctx.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('INACTIVE: **1** (F:1 W:0 A:0)')
      })
    );
  });
});
