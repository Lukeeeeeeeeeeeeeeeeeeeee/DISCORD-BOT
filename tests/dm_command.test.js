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

const { ensureCommandAccess } = require('../src/lib/command-auth');
const { replyError } = require('../src/lib/embeds');
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
    send: jest.fn().mockResolvedValue(true)
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
  const originalFullFetch = process.env.DM_ALLOW_FULL_FETCH;
  const originalHistoryFile = process.env.DM_HISTORY_FILE;
  let historyFile;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DM_ALLOW_FULL_FETCH;
    historyFile = path.join(
      os.tmpdir(),
      `dm-history-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
    );
    process.env.DM_HISTORY_FILE = historyFile;
    ensureCommandAccess.mockResolvedValue(true);
  });

  afterEach(() => {
    if (fs.existsSync(historyFile)) fs.unlinkSync(historyFile);
  });

  afterAll(() => {
    if (originalFullFetch === undefined) delete process.env.DM_ALLOW_FULL_FETCH;
    else process.env.DM_ALLOW_FULL_FETCH = originalFullFetch;

    if (originalHistoryFile === undefined) delete process.env.DM_HISTORY_FILE;
    else process.env.DM_HISTORY_FILE = originalHistoryFile;
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
    await dmCommand.execute(interaction, null, null);

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
    await dmCommand.execute(interaction, null, null);

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

    await dmCommand.execute(interaction, null, null);

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

    await dmCommand.execute(interaction, null, null);

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
    await dmCommand.execute(first, null, null);
    await sleep(20);

    const second = makeInteraction({
      role,
      fetchedMembers,
      preview: true,
      userId: 'admin-history'
    });
    await dmCommand.execute(second, null, null);

    expect(second.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('0 are left to send')
      })
    );
    expect(replyError).not.toHaveBeenCalled();
  });

  test('returns guild-only error outside a server context', async () => {
    const role = {
      id: 'role-revol',
      name: '[REVOL]',
      members: new Collection()
    };
    const interaction = makeInteraction({ role, guild: null });

    await dmCommand.execute(interaction, null, null);

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

    await dmCommand.execute(interaction, null, null);

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
    await dmCommand.execute(first, null, null);

    const second = makeInteraction({
      role,
      preview: false,
      userId,
      fetchedMembers: new Collection([['u1', makeMember('u1', ['role-revol'])]])
    });
    await dmCommand.execute(second, null, null);

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

    await dmCommand.execute(interaction, null, null);

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const payload = interaction.editReply.mock.calls[0][0];
    expect(payload.flags).toBeUndefined();
    expect(payload.content).toContain('Queued DM broadcast to 1 unsent recipient(s)');
  });
});
