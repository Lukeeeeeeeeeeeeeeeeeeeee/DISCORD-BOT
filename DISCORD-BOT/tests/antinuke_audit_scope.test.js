process.env.OWNER_ID = process.env.OWNER_ID || 'TEST_OWNER';
process.env.ANTINUKE_ENCRYPTION_KEY = process.env.ANTINUKE_ENCRYPTION_KEY || 'test-encryption-key';

const { AuditLogEvent } = require('discord.js');
const AntiNuke = require('../src/lib/antinuke');

function makeAntiNuke() {
  const anti = new AntiNuke();
  anti.client = { user: { id: 'BOT' } };
  anti.trackAction = jest.fn();
  anti.recordBan = jest.fn(() => [Date.now()]);
  anti.checkMassBanLockdown = jest.fn();
  anti.checkEmergencyThresholds = jest.fn();
  return anti;
}

describe('antinuke audit scope handling', () => {
  test('handleAuditLogEntry tracks MemberBanAdd actions', async () => {
    const anti = makeAntiNuke();
    const guild = { id: 'G1' };
    const entry = {
      id: 'AUDIT_BAN_1',
      action: AuditLogEvent.MemberBanAdd,
      executor: { id: 'EXECUTOR_1' },
      target: { id: 'TARGET_1' }
    };

    await anti.handleAuditLogEntry(entry, guild);

    expect(anti.trackAction).toHaveBeenCalledTimes(1);
    expect(anti.trackAction).toHaveBeenCalledWith(
      'G1',
      'EXECUTOR_1',
      'ban',
      expect.objectContaining({
        targetId: 'TARGET_1',
        auditLogId: 'AUDIT_BAN_1'
      })
    );
    expect(anti.recordBan).toHaveBeenCalledTimes(1);
    expect(anti.checkMassBanLockdown).toHaveBeenCalledTimes(1);
    expect(anti.checkEmergencyThresholds).toHaveBeenCalledTimes(1);
  });

  test('handleAuditLogEntry tracks MemberKick actions', async () => {
    const anti = makeAntiNuke();
    const guild = { id: 'G1' };
    const entry = {
      id: 'AUDIT_KICK_1',
      action: AuditLogEvent.MemberKick,
      executor: { id: 'EXECUTOR_2' },
      target: { id: 'TARGET_2' }
    };

    await anti.handleAuditLogEntry(entry, guild);

    expect(anti.trackAction).toHaveBeenCalledTimes(1);
    expect(anti.trackAction).toHaveBeenCalledWith(
      'G1',
      'EXECUTOR_2',
      'kick',
      expect.objectContaining({
        targetId: 'TARGET_2',
        auditLogId: 'AUDIT_KICK_1'
      })
    );
  });

  test('dedupe prevents double tracking when both audit and ban event paths see same audit id', async () => {
    const anti = makeAntiNuke();
    const guild = { id: 'G1' };
    const entry = {
      id: 'AUDIT_BAN_DUP',
      action: AuditLogEvent.MemberBanAdd,
      executor: { id: 'EXECUTOR_DUP' },
      target: { id: 'TARGET_DUP' }
    };
    const ban = { guild, user: { id: 'TARGET_DUP' } };

    anti.waitForAuditLog = jest.fn(async () => entry);

    await anti.handleAuditLogEntry(entry, guild);
    await anti.handleBan(ban);

    expect(anti.trackAction).toHaveBeenCalledTimes(1);
  });
});
