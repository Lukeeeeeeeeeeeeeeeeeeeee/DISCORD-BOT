const fs = require('fs');
const os = require('os');
const path = require('path');
const { Collection } = require('discord.js');

jest.mock('../src/lib/command-auth', () => ({
  ensureCommandAccess: jest.fn()
}));

jest.mock('../src/lib/embeds', () => ({
  replyError: jest.fn().mockResolvedValue(null)
}));

jest.mock('../src/services/dm/dm-campaign-service', () => ({
  createCampaign: jest.fn(),
  getCampaignStatus: jest.fn(),
  cancelCampaign: jest.fn(),
  listWorkers: jest.fn()
}));

const { ensureCommandAccess } = require('../src/lib/command-auth');
const { replyError } = require('../src/lib/embeds');
const { createCampaign } = require('../src/services/dm/dm-campaign-service');
const dmCommand = require('../src/commands/dm');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeMember(id, roleIds = [], bot = false) {
  return {
    id,
    user: { bot },
    roles: {
      cache: {
        has: (roleId) => roleIds.includes(roleId)
      }
    },
    send: jest.fn().mockResolvedValue(true),
    createDM: jest.fn().mockResolvedValue({
      messages: {
        fetch: jest.fn().mockResolvedValue(new Collection())
      }
    })
  };
}

function makeInteraction({
  role,
  fetchedMembers = new Collection(),
  preview = true,
  everyone = false,
  message = 'hello from dm command',
  limit = null,
  offset = null,
  userId = 'admin-user',
  guild = undefined
} = {}) {
  const interaction = {
    user: { id: userId },
    member: {},
    deferred: false,
    replied: false,
    guild: guild === undefined ? {
      id: 'guild-1',
      members: {
        cache: new Collection(),
        fetch: jest.fn().mockResolvedValue(fetchedMembers)
      },
      channels: {
        fetch: jest.fn().mockResolvedValue(null)
      }
    } : guild,
    options: {
      getRole: jest.fn().mockImplementation((name) => (name === 'role' ? role : null)),
      getString: jest.fn().mockImplementation((name) => (name === 'message' ? message : null)),
      getInteger: jest.fn().mockImplementation((name) => {
        if (name === 'limit') return limit;
        if (name === 'offset') return offset;
        return null;
      }),
      getBoolean: jest.fn().mockImplementation((name) => {
        if (name === 'preview') return preview;
        if (name === 'everyone') return everyone;
        return null;
      })
    }
  };

  interaction.deferReply = jest.fn().mockImplementation(async () => {
    interaction.deferred = true;
  });
  interaction.editReply = jest.fn().mockResolvedValue(true);
  interaction.reply = jest.fn().mockResolvedValue(true);
  return interaction;
}

describe('/dm command', () => {
  const BOT_CLIENT = { user: { id: 'bot-user' } };
  const originalFullFetch = process.env.DM_ALLOW_FULL_FETCH;
  const originalHistoryFile = process.env.DM_HISTORY_FILE;
  const originalProgressUpdates = process.env.DM_PROGRESS_UPDATES;
  let historyFile;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DM_ALLOW_FULL_FETCH;
    historyFile = path.join(
      os.tmpdir(),
      `dm-history-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
    );
    process.env.DM_HISTORY_FILE = historyFile;
    process.env.DM_PROGRESS_UPDATES = 'false';
    ensureCommandAccess.mockResolvedValue(true);
    createCampaign.mockImplementation(async ({ directUserIds = [], preview = false }) => ({
      campaignId: 321,
      totalTargets: directUserIds.length,
      totalBatches: directUserIds.length ? 1 : 0,
      preview
    }));
  });

  afterEach(() => {
    if (fs.existsSync(historyFile)) fs.unlinkSync(historyFile);
  });

  afterAll(() => {
    if (originalFullFetch === undefined) delete process.env.DM_ALLOW_FULL_FETCH;
    else process.env.DM_ALLOW_FULL_FETCH = originalFullFetch;

    if (originalHistoryFile === undefined) delete process.env.DM_HISTORY_FILE;
    else process.env.DM_HISTORY_FILE = originalHistoryFile;

    if (originalProgressUpdates === undefined) delete process.env.DM_PROGRESS_UPDATES;
    else process.env.DM_PROGRESS_UPDATES = originalProgressUpdates;
  });

  test('preview defaults to all unsent recipients instead of 30 cap', async () => {
    const role = {
      id: 'role-revol',
      name: '[REVOL]',
      members: new Collection()
    };
    const fetchedMembers = new Collection([
      ['u1', makeMember('u1', ['role-revol'])],
      ['u2', makeMember('u2', ['role-revol'])]
    ]);

    const interaction = makeInteraction({ role, fetchedMembers, preview: true, everyone: false });
    await dmCommand.execute(interaction, BOT_CLIENT, null);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('showing up to 2')
      })
    );
  });

  test('fetches all guild members by default when role cache is empty', async () => {
    const role = {
      id: 'role-revol',
      name: '[REVOL]',
      members: new Collection()
    };
    const fetchedMembers = new Collection([
      ['u1', makeMember('u1', ['role-revol'])],
      ['u2', makeMember('u2', ['role-revol'])],
      ['u3', makeMember('u3', ['other-role'])],
      ['bot1', makeMember('bot1', ['role-revol'], true)]
    ]);

    const interaction = makeInteraction({ role, fetchedMembers, preview: true, everyone: false });
    await dmCommand.execute(interaction, BOT_CLIENT, null);

    expect(interaction.guild.members.fetch).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Preview: found 2 members')
      })
    );
    expect(replyError).not.toHaveBeenCalled();
  });

  test('supports opting out of full fetch via DM_ALLOW_FULL_FETCH=false', async () => {
    process.env.DM_ALLOW_FULL_FETCH = 'false';
    const role = {
      id: 'role-revol',
      name: '[REVOL]',
      members: new Collection([
        ['u1', makeMember('u1', ['role-revol'])]
      ])
    };
    const interaction = makeInteraction({
      role,
      fetchedMembers: new Collection([['u2', makeMember('u2', ['role-revol'])]]),
      preview: true,
      everyone: false
    });

    await dmCommand.execute(interaction, BOT_CLIENT, null);

    expect(interaction.guild.members.fetch).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Preview: found 1 members')
      })
    );
  });

  test('applies offset to unsent list for resume behavior', async () => {
    const role = {
      id: 'role-revol',
      name: '[REVOL]',
      members: new Collection()
    };
    const fetchedMembers = new Collection([
      ['u1', makeMember('u1', ['role-revol'])],
      ['u2', makeMember('u2', ['role-revol'])],
      ['u3', makeMember('u3', ['role-revol'])]
    ]);

    const interaction = makeInteraction({
      role,
      fetchedMembers,
      preview: true,
      offset: 1,
      limit: 1
    });

    await dmCommand.execute(interaction, BOT_CLIENT, null);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('First 1: <@u2>')
      })
    );
  });

  test('detects already sent recipients from DM history scan when file history is empty', async () => {
    const role = {
      id: 'role-revol',
      name: '[REVOL]',
      members: new Collection()
    };
    const sentMember = makeMember('u1', ['role-revol']);
    const unsentMember = makeMember('u2', ['role-revol']);
    sentMember.createDM = jest.fn().mockResolvedValue({
      messages: {
        fetch: jest.fn().mockResolvedValue(new Collection([
          ['m1', {
            author: { id: 'bot-user' },
            content: 'hello from dm command',
            createdTimestamp: Date.now() - 1000
          }]
        ]))
      }
    });

    const interaction = makeInteraction({
      role,
      fetchedMembers: new Collection([
        ['u1', sentMember],
        ['u2', unsentMember]
      ]),
      preview: true
    });

    await dmCommand.execute(interaction, BOT_CLIENT, null);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('1 already sent for this same message')
      })
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('First 1: <@u2>')
      })
    );
  });

  test('tracks successful sends and skips them on later preview of same message', async () => {
    const role = {
      id: 'role-revol',
      name: '[REVOL]',
      members: new Collection()
    };
    const member = makeMember('u1', ['role-revol']);
    const fetchedMembers = new Collection([['u1', member]]);

    const first = makeInteraction({
      role,
      fetchedMembers,
      preview: false,
      userId: 'admin-history'
    });
    await dmCommand.execute(first, BOT_CLIENT, null);
    await sleep(20);

    const second = makeInteraction({
      role,
      fetchedMembers,
      preview: true,
      userId: 'admin-history'
    });
    await dmCommand.execute(second, BOT_CLIENT, null);

    expect(second.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('0 are left to send')
      })
    );
    expect(replyError).not.toHaveBeenCalled();
  });

  test('history is scoped by role so the same message can be reused for a different audience', async () => {
    const sharedMember = makeMember('u1', ['role-fire', 'role-water']);
    const fetchedMembers = new Collection([['u1', sharedMember]]);
    const fireRole = {
      id: 'role-fire',
      name: '[FIRE]',
      members: new Collection()
    };
    const waterRole = {
      id: 'role-water',
      name: '[WATER]',
      members: new Collection()
    };

    const first = makeInteraction({
      role: fireRole,
      fetchedMembers,
      preview: false,
      userId: 'admin-history-scope'
    });
    await dmCommand.execute(first, BOT_CLIENT, null);

    const second = makeInteraction({
      role: waterRole,
      fetchedMembers,
      preview: true,
      userId: 'admin-history-scope'
    });
    await dmCommand.execute(second, BOT_CLIENT, null);

    expect(second.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('1 are left to send')
      })
    );
  });

  test('returns guild-only error outside a server context', async () => {
    const role = {
      id: 'role-revol',
      name: '[REVOL]',
      members: new Collection()
    };
    const interaction = makeInteraction({ role, guild: null });

    await dmCommand.execute(interaction, BOT_CLIENT, null);

    expect(replyError).toHaveBeenCalledWith(
      interaction,
      'This command can only be used inside a server.'
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  test('validates message length before deferring', async () => {
    const role = {
      id: 'role-revol',
      name: '[REVOL]',
      members: new Collection()
    };
    const interaction = makeInteraction({
      role,
      message: 'x'.repeat(2001)
    });

    await dmCommand.execute(interaction, BOT_CLIENT, null);

    expect(replyError).toHaveBeenCalledWith(
      interaction,
      'Message must be 2000 characters or fewer.'
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  test('does not consume cooldown when no recipients are found', async () => {
    const role = {
      id: 'role-revol',
      name: '[REVOL]',
      members: new Collection()
    };
    const userId = 'admin-cooldown-no-targets';

    const first = makeInteraction({
      role,
      preview: false,
      userId,
      fetchedMembers: new Collection()
    });
    await dmCommand.execute(first, BOT_CLIENT, null);

    const second = makeInteraction({
      role,
      preview: false,
      userId,
      fetchedMembers: new Collection([['u1', makeMember('u1', ['role-revol'])]])
    });
    await dmCommand.execute(second, BOT_CLIENT, null);

    const cooldownErrorCall = replyError.mock.calls.find((call) => String(call[1]).includes('Please wait'));
    expect(cooldownErrorCall).toBeUndefined();
    expect(second.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Queued DM broadcast to 1 unsent recipient(s)')
      })
    );
  });

  test('queued response edit does not send flags', async () => {
    const role = {
      id: 'role-revol',
      name: '[REVOL]',
      members: new Collection()
    };
    const interaction = makeInteraction({
      role,
      preview: false,
      userId: 'admin-queue-flags',
      fetchedMembers: new Collection([['u1', makeMember('u1', ['role-revol'])]])
    });

    await dmCommand.execute(interaction, BOT_CLIENT, null);

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const payload = interaction.editReply.mock.calls[0][0];
    expect(payload.flags).toBeUndefined();
    expect(payload.content).toContain('Queued DM broadcast to 1 unsent recipient(s)');
  });

  test('posts DM audit logs to economy notifications channel when available', async () => {
    const role = {
      id: 'role-revol',
      name: '[REVOL]',
      members: new Collection()
    };
    const auditChannel = {
      send: jest.fn().mockResolvedValue(true)
    };
    const constants = require('../src/constants');
    const interaction = makeInteraction({
      role,
      preview: false,
      userId: 'admin-audit-channel',
      fetchedMembers: new Collection([['u1', makeMember('u1', ['role-revol'])]]),
      guild: {
        id: 'guild-1',
        members: {
          cache: new Collection(),
          fetch: jest.fn().mockResolvedValue(new Collection([['u1', makeMember('u1', ['role-revol'])]]))
        },
        channels: {
          fetch: jest.fn().mockResolvedValue(auditChannel)
        }
      }
    });

    await dmCommand.execute(interaction, BOT_CLIENT, null);
    await sleep(30);

    expect(interaction.guild.channels.fetch).toHaveBeenCalledWith(constants.CHANNELS.ECONOMY_NOTIFICATIONS);
    expect(auditChannel.send).toHaveBeenCalled();
  });
});
