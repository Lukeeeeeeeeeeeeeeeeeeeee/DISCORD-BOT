const mockInit = jest.fn();
const mockIsRecruiter = jest.fn();
const mockGetInviteStatus = jest.fn();
const mockCreateInvite = jest.fn();
const mockHasAdministrator = jest.fn();
const mockRecordInviteCreated = jest.fn();

jest.mock('../src/lib/invite-system', () => {
  return jest.fn().mockImplementation(() => ({
    init: mockInit,
    isRecruiter: mockIsRecruiter,
    getInviteStatus: mockGetInviteStatus,
    createInvite: mockCreateInvite
  }));
});

jest.mock('../src/lib/permissions', () => ({
  hasAdministrator: (...args) => mockHasAdministrator(...args)
}));

jest.mock('../src/lib/analytics', () => ({
  recordInviteCreated: (...args) => mockRecordInviteCreated(...args)
}));

function makeInteraction() {
  const interaction = {
    guild: { id: 'G1' },
    member: {},
    user: { id: 'U1', tag: 'User#0001' },
    deferred: false,
    replied: false
  };

  interaction.deferReply = jest.fn().mockImplementation(async () => {
    interaction.deferred = true;
  });
  interaction.editReply = jest.fn().mockResolvedValue(true);
  interaction.reply = jest.fn().mockResolvedValue(true);
  return interaction;
}

describe('/invite interaction acknowledgment handling', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    mockInit.mockResolvedValue(undefined);
    mockIsRecruiter.mockResolvedValue(false);
    mockGetInviteStatus.mockReturnValue({ hasActive: false, onCooldown: false });
    mockCreateInvite.mockResolvedValue({ success: false, message: 'failed' });
    mockHasAdministrator.mockReturnValue(false);
    mockRecordInviteCreated.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (consoleErrorSpy) consoleErrorSpy.mockRestore();
  });

  test('defers before role checks and edits deferred reply for recruiter-gate errors', async () => {
    const interaction = makeInteraction();
    const cmd = require('../src/commands/recruiting/invite.js');

    await cmd.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(mockIsRecruiter).toHaveBeenCalled();
    expect(interaction.deferReply.mock.invocationCallOrder[0])
      .toBeLessThan(mockIsRecruiter.mock.invocationCallOrder[0]);
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  test('swallows unknown interaction errors raised during defer', async () => {
    const interaction = makeInteraction();
    interaction.deferReply.mockRejectedValue(Object.assign(new Error('Unknown interaction'), { code: 10062 }));
    const cmd = require('../src/commands/recruiting/invite.js');

    await cmd.execute(interaction);

    expect(mockIsRecruiter).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  test('swallows already-acknowledged errors while reporting command failures', async () => {
    const interaction = makeInteraction();
    mockIsRecruiter.mockResolvedValue(true);
    mockCreateInvite.mockRejectedValue(new Error('boom'));
    interaction.editReply.mockRejectedValue(Object.assign(new Error('Interaction has already been acknowledged.'), { code: 40060 }));
    const cmd = require('../src/commands/recruiting/invite.js');

    await cmd.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});
