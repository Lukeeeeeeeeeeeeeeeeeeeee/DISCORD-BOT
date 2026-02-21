jest.setTimeout(10000);

const AntiNuke = require('../src/lib/antinuke');

describe('anti-nuke backup safety', () => {
  const originalRequireEncryption = process.env.ANTINUKE_REQUIRE_ENCRYPTION;

  beforeEach(() => {
    process.env.ANTINUKE_REQUIRE_ENCRYPTION = 'false';
  });

  afterEach(() => {
    if (originalRequireEncryption === undefined) {
      delete process.env.ANTINUKE_REQUIRE_ENCRYPTION;
    } else {
      process.env.ANTINUKE_REQUIRE_ENCRYPTION = originalRequireEncryption;
    }
  });

  test('createBackup handles channels without permission overwrite cache', async () => {
    const antiNuke = new AntiNuke();
    antiNuke.saveData = jest.fn();
    antiNuke.logAction = jest.fn();

    const guild = {
      id: 'G_BACKUP_1',
      roles: {
        cache: new Map([
          ['R1', {
            id: 'R1',
            name: 'Role One',
            permissions: { bitfield: BigInt(8) },
            position: 1,
            color: 0,
            hoist: false,
            mentionable: false
          }]
        ])
      },
      channels: {
        cache: new Map([
          ['C1', {
            id: 'C1',
            name: 'general',
            type: 0,
            position: 1,
            parentId: null,
            permissionOverwrites: {
              cache: new Map([
                ['OW1', {
                  id: 'OW1',
                  type: 0,
                  allow: { bitfield: BigInt(1024) },
                  deny: { bitfield: BigInt(2048) }
                }]
              ])
            }
          }],
          ['C2', {
            id: 'C2',
            name: 'thread-like',
            type: 11,
            position: 2,
            parentId: 'C1'
          }]
        ])
      }
    };

    const backup = await antiNuke.createBackup(guild, { type: 'full', manual: true, executorId: 'U1' });
    expect(backup).toBeDefined();
    expect(backup.counts.roles).toBe(1);
    expect(backup.counts.channels).toBe(1);
    expect(backup.counts.threads).toBe(1);

    const snapshot = antiNuke.decryptSnapshot(backup);
    expect(snapshot).toBeTruthy();
    const threadLike = snapshot.threads.find(ch => ch.id === 'C2');
    expect(threadLike).toMatchObject({ id: 'C2', parentId: 'C1', type: 11 });
  });

  test('createBackup handles array-backed caches', async () => {
    const antiNuke = new AntiNuke();
    antiNuke.saveData = jest.fn();
    antiNuke.logAction = jest.fn();

    const guild = {
      id: 'G_BACKUP_2',
      roles: {
        cache: [{
          id: 'R2',
          name: 'Role Two',
          permissions: { bitfield: BigInt(4) },
          position: 1,
          color: 0,
          hoist: false,
          mentionable: true
        }]
      },
      channels: {
        cache: [{
          id: 'C3',
          name: 'array-channel',
          type: 0,
          position: 0,
          parentId: null,
          permissionOverwrites: { cache: [] }
        }]
      }
    };

    const backup = await antiNuke.createBackup(guild, { type: 'full' });
    expect(backup).toBeDefined();
    expect(backup.counts.roles).toBe(1);
    expect(backup.counts.channels).toBe(1);
  });

  test('createBackup does not fail when client guild cache is unavailable', async () => {
    const antiNuke = new AntiNuke();
    antiNuke.client = null;
    antiNuke.saveData = jest.fn();

    const guild = {
      id: 'G_BACKUP_3',
      roles: { cache: [] },
      channels: { cache: [] }
    };

    const backup = await antiNuke.createBackup(guild, { type: 'full', manual: true, executorId: 'U1' });
    expect(backup).toBeDefined();
    expect(backup.id).toBeTruthy();
  });
});
