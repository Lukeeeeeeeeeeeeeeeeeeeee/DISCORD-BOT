const mockExecute = jest.fn();
const mockInit = jest.fn();
const mockInitWithDb = jest.fn();
const mockDispose = jest.fn();
const mockGetCached = jest.fn();

jest.mock('../src/services/recruiting/invite-service', () => ({
  execute: (...args) => mockExecute(...args),
  init: (...args) => mockInit(...args),
  initWithDb: (...args) => mockInitWithDb(...args),
  dispose: (...args) => mockDispose(...args),
  getCached: (...args) => mockGetCached(...args)
}));

describe('/invite command wrapper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('delegates execute to the invite service', async () => {
    const cmd = require('../src/commands/recruiting/invite.js');
    const interaction = { id: 'interaction-1' };
    const client = { id: 'client-1' };
    const db = { id: 'db-1' };
    mockExecute.mockResolvedValue('ok');

    await expect(cmd.execute(interaction, client, db)).resolves.toBe('ok');

    expect(mockExecute).toHaveBeenCalledWith(interaction, client, db);
  });

  test('re-exports init helpers for runtime callers', async () => {
    const cmd = require('../src/commands/recruiting/invite.js');
    mockInit.mockResolvedValue('global-system');
    mockInitWithDb.mockResolvedValue('guild-system');
    mockGetCached.mockReturnValue('cached-system');

    await expect(cmd.init()).resolves.toBe('global-system');
    await expect(cmd.initWithDb('guild-1', 'db-handle')).resolves.toBe('guild-system');
    expect(cmd.getCached('guild-1')).toBe('cached-system');

    cmd.dispose('guild-1');

    expect(mockInit).toHaveBeenCalledWith();
    expect(mockInitWithDb).toHaveBeenCalledWith('guild-1', 'db-handle');
    expect(mockGetCached).toHaveBeenCalledWith('guild-1');
    expect(mockDispose).toHaveBeenCalledWith('guild-1');
  });
});
