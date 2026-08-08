const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const AntiNuke = require('../src/lib/antinuke');

describe('anti-nuke state file durability', () => {
  const originalDataFile = process.env.ANTINUKE_DATA_FILE;
  const originalRequireEncryption = process.env.ANTINUKE_REQUIRE_ENCRYPTION;
  const originalAllowUnencrypted = process.env.ANTINUKE_ALLOW_UNENCRYPTED_BACKUPS;

  let tempDir = null;
  let dataFile = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antinuke-state-'));
    dataFile = path.join(tempDir, 'antinuke.json');
    process.env.ANTINUKE_DATA_FILE = dataFile;
    process.env.ANTINUKE_REQUIRE_ENCRYPTION = 'false';
    process.env.ANTINUKE_ALLOW_UNENCRYPTED_BACKUPS = 'true';
  });

  afterEach(async () => {
    if (originalDataFile === undefined) {
      delete process.env.ANTINUKE_DATA_FILE;
    } else {
      process.env.ANTINUKE_DATA_FILE = originalDataFile;
    }
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
    if (tempDir) {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
    tempDir = null;
    dataFile = null;
  });

  test('loads from temp state file and migrates to primary file', async () => {
    const tempPayload = {
      whitelist: ['U1'],
      whitelistByGuild: {
        G1: ['U2']
      },
      logChannels: {},
      beastModeActions: {},
      beastModeTracker: {},
      pendingWhitelist: {},
      backups: {},
      guildConfig: {},
      quarantineAssignments: {},
      recoveryMappings: {},
      emergencyLockdownUntil: {},
      emergencyMode: {}
    };
    await fsp.writeFile(`${dataFile}.tmp`, JSON.stringify(tempPayload), 'utf8');

    const anti = new AntiNuke();
    await anti.loadDataFromFile();

    expect(anti.whitelist.has('U1')).toBe(true);
    expect(anti.whitelistByGuild.get('G1').has('U2')).toBe(true);

    const migrated = JSON.parse(await fsp.readFile(dataFile, 'utf8'));
    expect(migrated.whitelist).toContain('U1');
    expect(migrated.whitelistByGuild.G1).toContain('U2');
  });

  test('saveDataToFile serializes concurrent writes via queue', async () => {
    const anti = new AntiNuke();
    anti.whitelistByGuild.set('G2', new Set(['A', 'B']));

    await Promise.all([
      anti.saveDataToFile(),
      anti.saveDataToFile(),
      anti.saveDataToFile()
    ]);

    const saved = JSON.parse(await fsp.readFile(dataFile, 'utf8'));
    const guildUsers = Array.isArray(saved.whitelistByGuild.G2) ? saved.whitelistByGuild.G2.slice().sort() : [];
    expect(guildUsers).toEqual(['A', 'B']);
    expect(fs.existsSync(`${dataFile}.tmp`)).toBe(false);
  });
});
