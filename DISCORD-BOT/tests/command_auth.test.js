jest.mock('../src/lib/permissions', () => ({
  hasAdministrator: jest.fn(),
  hasAdminOrStaffPermissions: jest.fn()
}));

jest.mock('../src/lib/embeds', () => ({
  replyError: jest.fn().mockResolvedValue(null)
}));

const { hasAdministrator, hasAdminOrStaffPermissions } = require('../src/lib/permissions');
const { replyError } = require('../src/lib/embeds');
const { ensureCommandAccess } = require('../src/lib/command-auth');

function createInteraction() {
  return {
    member: {},
    guild: {
      members: {
        me: null
      }
    }
  };
}

describe('command auth helper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('denies by default when admin permission is missing', async () => {
    hasAdministrator.mockReturnValue(false);

    const ok = await ensureCommandAccess(createInteraction(), {
      deniedMessage: 'Administrator permission required.'
    });

    expect(ok).toBe(false);
    expect(replyError).toHaveBeenCalledWith(
      expect.any(Object),
      'Administrator permission required.',
      { flags: 64 }
    );
  });

  test('allows when staff mode is enabled and staff permission passes', async () => {
    hasAdminOrStaffPermissions.mockReturnValue(true);

    const ok = await ensureCommandAccess(createInteraction(), {
      allowStaff: true
    });

    expect(ok).toBe(true);
    expect(replyError).not.toHaveBeenCalled();
  });

  test('enforces above-bot hierarchy when requested', async () => {
    hasAdministrator.mockReturnValue(true);
    const interaction = createInteraction();
    interaction.member = {
      roles: {
        highest: {
          comparePositionTo: () => 0
        }
      }
    };
    interaction.guild.members.me = {
      roles: {
        highest: {}
      }
    };

    const ok = await ensureCommandAccess(interaction, {
      requireAboveBot: true
    });

    expect(ok).toBe(false);
    expect(replyError).toHaveBeenCalledWith(
      interaction,
      'You must be above the bot in role hierarchy to use this command.',
      { flags: 64 }
    );
  });
});
