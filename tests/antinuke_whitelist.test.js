process.env.OWNER_ID = process.env.OWNER_ID || 'TEST_OWNER';
process.env.ANTINUKE_ENCRYPTION_KEY = process.env.ANTINUKE_ENCRYPTION_KEY || 'test-encryption-key';

const AntiNuke = require('../src/lib/antinuke');

describe('antinuke whitelist scoping', () => {
  test('whitelist is per guild', () => {
    const anti = new AntiNuke();
    anti.addToWhitelist('GUILD_ONE', 'USER_ONE');

    expect(anti.isWhitelisted('USER_ONE', 'GUILD_ONE')).toBe(true);
    expect(anti.isWhitelisted('USER_ONE', 'GUILD_TWO')).toBe(false);
  });

  test('emergency whitelist bypass is controlled by emergencyForceProtect flag', () => {
    const anti = new AntiNuke();
    const guildId = 'GUILD_ONE';
    const userId = 'USER_ONE';
    anti.addToWhitelist(guildId, userId);
    anti.emergencyMode.set(guildId, true);

    const cfg = anti.getGuildConfig(guildId);
    cfg.strictActive = false;
    cfg.strictForce = false;
    cfg.emergencyForceProtect = false;
    anti.guildConfig.set(guildId, cfg);
    expect(anti.isWhitelistBypassAllowed(guildId, userId)).toBe(false);

    cfg.emergencyForceProtect = true;
    anti.guildConfig.set(guildId, cfg);
    expect(anti.isWhitelistBypassAllowed(guildId, userId)).toBe(true);
  });
});
