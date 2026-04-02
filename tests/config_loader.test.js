const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadGuildConfig } = require('../src/lib/config-loader');

describe('config loader', () => {
  test('throws for an explicit malformed config file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-loader-'));
    const configPath = path.join(tempDir, 'config.json');
    fs.writeFileSync(configPath, '{ invalid json', 'utf8');

    expect(() => loadGuildConfig({ GUILD_ID: 'BASE' }, {
      env: {
        CONFIG_PATH: configPath
      },
      cwd: tempDir
    })).toThrow(`Failed to parse guild config at ${configPath}`);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('merges guild-specific overrides onto the base config', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-loader-'));
    const configPath = path.join(tempDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      BRAND_NAME: 'RootBrand',
      guilds: {
        guild_2: {
          BRAND_NAME: 'GuildBrand',
          roleIds: {
            rookie: 'rookie_override'
          }
        }
      }
    }), 'utf8');

    const { config } = loadGuildConfig({
      GUILD_ID: 'BASE',
      BRAND_NAME: 'BaseBrand',
      ROLE_IDS: {
        ROOKIE: 'rookie_base'
      }
    }, {
      env: {
        GUILD_ID: 'guild_2',
        CONFIG_PATH: configPath
      },
      cwd: tempDir
    });

    expect(config.GUILD_ID).toBe('guild_2');
    expect(config.BRAND_NAME).toBe('GuildBrand');
    expect(config.ROLE_IDS.ROOKIE).toBe('rookie_override');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
