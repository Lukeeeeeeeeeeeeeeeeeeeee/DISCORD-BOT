process.env.OWNER_ID = process.env.OWNER_ID || 'TEST_OWNER';
process.env.ANTINUKE_ENCRYPTION_KEY = process.env.ANTINUKE_ENCRYPTION_KEY || 'test-encryption-key';

const { AuditLogEvent } = require('discord.js');
const AntiNuke = require('../src/lib/antinuke');

function makeAuditLogs(entries) {
  const mapped = new Map();
  for (let i = 0; i < entries.length; i += 1) {
    mapped.set(String(i), entries[i]);
  }
  return { entries: mapped };
}

describe('anti-nuke audit log lookup hardening', () => {
  test('escalates fetch depth when target is not found in initial audit window', async () => {
    const anti = new AntiNuke();
    anti.sleep = jest.fn(async () => {});
    const now = Date.now();
    const guild = {
      fetchAuditLogs: jest
        .fn()
        .mockResolvedValueOnce(makeAuditLogs([
          {
            id: 'AUDIT_OLD',
            target: { id: 'OTHER_TARGET' },
            createdTimestamp: now
          }
        ]))
        .mockResolvedValueOnce(makeAuditLogs([
          {
            id: 'AUDIT_MATCH',
            target: { id: 'TARGET_USER' },
            createdTimestamp: now
          }
        ]))
    };

    const entry = await anti.waitForAuditLog(guild, AuditLogEvent.MemberBanAdd, 'TARGET_USER', 5000);

    expect(entry && entry.id).toBe('AUDIT_MATCH');
    expect(guild.fetchAuditLogs).toHaveBeenCalledTimes(2);
    expect(guild.fetchAuditLogs.mock.calls[0][0]).toEqual({ limit: 6, type: AuditLogEvent.MemberBanAdd });
    expect(guild.fetchAuditLogs.mock.calls[1][0]).toEqual({ limit: 12, type: AuditLogEvent.MemberBanAdd });
  });

  test('retries when fetchAuditLogs is rate-limited', async () => {
    const anti = new AntiNuke();
    anti.sleep = jest.fn(async () => {});
    const now = Date.now();
    const rateLimited = Object.assign(new Error('Too many requests'), {
      status: 429,
      retry_after: 0.05
    });
    const guild = {
      fetchAuditLogs: jest
        .fn()
        .mockRejectedValueOnce(rateLimited)
        .mockResolvedValueOnce(makeAuditLogs([
          {
            id: 'AUDIT_RETRY_OK',
            target: { id: 'TARGET_429' },
            createdTimestamp: now
          }
        ]))
    };

    const entry = await anti.waitForAuditLog(guild, AuditLogEvent.MemberKick, 'TARGET_429', 5000);

    expect(entry && entry.id).toBe('AUDIT_RETRY_OK');
    expect(guild.fetchAuditLogs).toHaveBeenCalledTimes(2);
    expect(anti.sleep).toHaveBeenCalledWith(50);
  });
});
