const AntiNuke = require('../src/lib/antinuke');

describe('anti-nuke DM routing', () => {
  const originalLogDmId = process.env.ANTINUKE_LOG_DM_ID;
  const originalLogDmMode = process.env.ANTINUKE_LOG_DM_MODE;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ANTINUKE_LOG_DM_ID;
    delete process.env.ANTINUKE_LOG_DM_MODE;
  });

  afterAll(() => {
    if (originalLogDmId === undefined) delete process.env.ANTINUKE_LOG_DM_ID;
    else process.env.ANTINUKE_LOG_DM_ID = originalLogDmId;
    if (originalLogDmMode === undefined) delete process.env.ANTINUKE_LOG_DM_MODE;
    else process.env.ANTINUKE_LOG_DM_MODE = originalLogDmMode;
  });

  function attachClient(anti, { fetchUser }) {
    anti.client = {
      guilds: {
        cache: new Map([
          ['G1', { id: 'G1', name: 'Guild One', channels: { cache: new Map() } }]
        ])
      },
      users: {
        fetch: fetchUser
      }
    };
  }

  test('does not DM owners by default', async () => {
    const anti = new AntiNuke();
    const ownerSend = jest.fn(async () => null);
    const fetchUser = jest.fn(async () => ({ send: ownerSend }));
    attachClient(anti, { fetchUser });

    await anti.logAction('G1', { type: 'backup_created' });

    expect(fetchUser).not.toHaveBeenCalled();
    expect(ownerSend).not.toHaveBeenCalled();
  });

  test('DMs owner only when explicitly enabled', async () => {
    process.env.ANTINUKE_LOG_DM_ID = 'OWNER_DM';
    process.env.ANTINUKE_LOG_DM_MODE = 'all';
    const anti = new AntiNuke();
    const ownerSend = jest.fn(async () => null);
    const fetchUser = jest.fn(async () => ({ send: ownerSend }));
    attachClient(anti, { fetchUser });

    await anti.logAction('G1', { type: 'backup_created' });

    expect(fetchUser).toHaveBeenCalledWith('OWNER_DM');
    expect(ownerSend).toHaveBeenCalledTimes(1);
  });
});
