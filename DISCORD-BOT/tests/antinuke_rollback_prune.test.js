const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const AntiNukeRollback = require('../src/lib/antinuke-rollback');

describe('AntiNukeRollback pruning', () => {
  test('prunes expired actions, enforces per-guild cap, and trims guild count', () => {
    const now = 1_700_000_000_000;
    const rollback = new AntiNukeRollback();
    rollback.ROLLBACK_TTL_MS = 60_000;
    rollback.ROLLBACK_MAX_ACTIONS_PER_GUILD = 2;
    rollback.ROLLBACK_MAX_GUILDS = 1;

    rollback.rollbackData = new Map([
      ['guild-old', {
        guildId: 'guild-old',
        guildName: 'Old',
        timestamp: now - 5_000,
        actions: [
          { actionType: 'ban', timestamp: now - 120_000 }, // expired
          { actionType: 'ban', timestamp: now - 50_000 },
          { actionType: 'ban', timestamp: now - 40_000 },
          { actionType: 'ban', timestamp: now - 30_000 }
        ]
      }],
      ['guild-new', {
        guildId: 'guild-new',
        guildName: 'New',
        timestamp: now - 1_000,
        actions: [
          { actionType: 'kick', timestamp: now - 10_000 }
        ]
      }]
    ]);

    rollback.pruneRollbackData(now);

    expect(rollback.rollbackData.size).toBe(1);
    expect(rollback.rollbackData.has('guild-new')).toBe(true);

    const guildNew = rollback.rollbackData.get('guild-new');
    expect(guildNew.actions).toHaveLength(1);
    expect(guildNew.actions[0].timestamp).toBe(now - 10_000);
  });

  test('saveRollbackData persists pruned data via temp-file swap', async () => {
    const now = Date.now();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'antinuke-rollback-'));
    const rollbackFile = path.join(tempDir, 'rollback.json');

    const rollback = new AntiNukeRollback();
    rollback.ROLLBACK_FILE = rollbackFile;
    rollback.ROLLBACK_TTL_MS = 1_000;
    rollback.ROLLBACK_MAX_ACTIONS_PER_GUILD = 10;
    rollback.ROLLBACK_MAX_GUILDS = 10;
    rollback.rollbackData = new Map([
      ['guild-expired', {
        guildId: 'guild-expired',
        guildName: 'Expired',
        timestamp: now - 10_000,
        actions: [
          { actionType: 'ban', timestamp: now - 10_000 }
        ]
      }],
      ['guild-active', {
        guildId: 'guild-active',
        guildName: 'Active',
        timestamp: now,
        actions: [
          { actionType: 'kick', timestamp: now }
        ]
      }]
    ]);

    await rollback.saveRollbackData();

    const savedRaw = await fs.readFile(rollbackFile, 'utf8');
    const saved = JSON.parse(savedRaw);
    expect(Object.keys(saved)).toEqual(['guild-active']);
    expect(saved['guild-active'].actions).toHaveLength(1);

    const tmpPath = `${rollbackFile}.tmp`;
    await expect(fs.access(tmpPath)).rejects.toBeTruthy();
  });

  test('init loads rollback state from temp file and migrates to primary file', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'antinuke-rollback-init-'));
    const rollbackFile = path.join(tempDir, 'rollback.json');
    const rollbackTmp = `${rollbackFile}.tmp`;
    const seed = {
      guildA: {
        guildId: 'guildA',
        guildName: 'Guild A',
        timestamp: Date.now(),
        actions: [{ actionType: 'ban', timestamp: Date.now() }]
      }
    };
    try {
      await fs.writeFile(rollbackTmp, JSON.stringify(seed, null, 2), 'utf8');

      const rollback = new AntiNukeRollback();
      rollback.ROLLBACK_FILE = rollbackFile;
      await rollback.init();

      expect(rollback.rollbackData.has('guildA')).toBe(true);
      const persisted = JSON.parse(await fs.readFile(rollbackFile, 'utf8'));
      expect(persisted).toHaveProperty('guildA');
      await expect(fs.access(rollbackTmp)).rejects.toBeTruthy();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('keeps rapid/beast capture families distinct while preserving member rollback snapshots', () => {
    const rollback = new AntiNukeRollback();
    const guild = {
      name: 'Guild',
      iconURL: () => null,
      ownerId: 'OWNER'
    };
    const member = {
      id: 'U1',
      user: { tag: 'User#0001' },
      roles: { cache: { map: () => ['R1', 'R2'] } },
      joinedAt: new Date(0),
      nickname: 'Nickname'
    };

    expect(rollback.normalizeCaptureActionType('rapid_role_delete')).toBe('rapid_action');
    expect(rollback.normalizeCaptureActionType('beast_mode')).toBe('beast_mode');

    const rapidState = rollback.captureState(guild, 'rapid_role_delete', member);
    const beastState = rollback.captureState(guild, 'beast_mode', member);

    expect(rapidState.member).toMatchObject({ id: 'U1', tag: 'User#0001', nickname: 'Nickname' });
    expect(beastState.member).toMatchObject({ id: 'U1', tag: 'User#0001', nickname: 'Nickname' });
  });
});
