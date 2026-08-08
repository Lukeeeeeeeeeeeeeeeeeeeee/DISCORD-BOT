jest.setTimeout(10000);

const AntiNuke = require('../src/lib/antinuke');

describe('anti-nuke backup safety', () => {
  const originalRequireEncryption = process.env.ANTINUKE_REQUIRE_ENCRYPTION;
  const originalAllowUnencrypted = process.env.ANTINUKE_ALLOW_UNENCRYPTED_BACKUPS;
  const originalLogAutomaticBackups = process.env.ANTINUKE_LOG_AUTOMATIC_BACKUPS;
  const originalLogIncrementalBackups = process.env.ANTINUKE_LOG_INCREMENTAL_BACKUPS;

  beforeEach(() => {
    process.env.ANTINUKE_REQUIRE_ENCRYPTION = 'false';
    process.env.ANTINUKE_ALLOW_UNENCRYPTED_BACKUPS = 'true';
    delete process.env.ANTINUKE_LOG_AUTOMATIC_BACKUPS;
    delete process.env.ANTINUKE_LOG_INCREMENTAL_BACKUPS;
  });

  afterEach(() => {
    if (originalRequireEncryption === undefined) {
      delete process.env.ANTINUKE_REQUIRE_ENCRYPTION;
    } else {
      process.env.ANTINUKE_REQUIRE_ENCRYPTION = originalRequireEncryption;
    }
    if (originalAllowUnencrypted === undefined) {
      delete process.env.ANTINUKE_ALLOW_UNENCRYPTED_BACKUPS;
    } else {
      process.env.ANTINUKE_ALLOW_UNENCRYPTED_BACKUPS = originalAllowUnencrypted;
    }
    if (originalLogAutomaticBackups === undefined) {
      delete process.env.ANTINUKE_LOG_AUTOMATIC_BACKUPS;
    } else {
      process.env.ANTINUKE_LOG_AUTOMATIC_BACKUPS = originalLogAutomaticBackups;
    }
    if (originalLogIncrementalBackups === undefined) {
      delete process.env.ANTINUKE_LOG_INCREMENTAL_BACKUPS;
    } else {
      process.env.ANTINUKE_LOG_INCREMENTAL_BACKUPS = originalLogIncrementalBackups;
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

  test('suppresses duplicate automatic backup notifications inside dedupe window', async () => {
    process.env.ANTINUKE_LOG_AUTOMATIC_BACKUPS = 'true';
    const antiNuke = new AntiNuke();
    antiNuke.saveData = jest.fn();
    antiNuke.logAction = jest.fn();
    antiNuke.BACKUP_LOG_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

    const guild = {
      id: 'G_BACKUP_4',
      roles: { cache: [] },
      channels: { cache: [] }
    };

    await antiNuke.createBackup(guild, { type: 'full' });
    await antiNuke.createBackup(guild, { type: 'incremental' });

    expect(antiNuke.logAction).toHaveBeenCalledTimes(1);
    expect(antiNuke.logAction).toHaveBeenCalledWith('G_BACKUP_4', expect.objectContaining({
      type: 'backup_created'
    }));
  });

  test('does not log automatic backup notifications by default', async () => {
    const antiNuke = new AntiNuke();
    antiNuke.saveData = jest.fn();
    antiNuke.logAction = jest.fn();

    const guild = {
      id: 'G_BACKUP_5',
      roles: { cache: [] },
      channels: { cache: [] }
    };

    await antiNuke.createBackup(guild, { type: 'incremental' });

    expect(antiNuke.logAction).not.toHaveBeenCalled();
  });

  test('does not log incremental backups unless explicitly enabled', async () => {
    process.env.ANTINUKE_LOG_AUTOMATIC_BACKUPS = 'true';
    const antiNukeDefault = new AntiNuke();
    antiNukeDefault.saveData = jest.fn();
    antiNukeDefault.logAction = jest.fn();

    const guild = {
      id: 'G_BACKUP_6',
      roles: { cache: [] },
      channels: { cache: [] }
    };

    await antiNukeDefault.createBackup(guild, { type: 'incremental' });
    expect(antiNukeDefault.logAction).not.toHaveBeenCalled();

    process.env.ANTINUKE_LOG_INCREMENTAL_BACKUPS = 'true';
    const antiNukeIncrementalEnabled = new AntiNuke();
    antiNukeIncrementalEnabled.saveData = jest.fn();
    antiNukeIncrementalEnabled.logAction = jest.fn();

    await antiNukeIncrementalEnabled.createBackup(guild, { type: 'incremental' });
    expect(antiNukeIncrementalEnabled.logAction).toHaveBeenCalledWith('G_BACKUP_6', expect.objectContaining({
      type: 'backup_incremental_created'
    }));
  });
});
