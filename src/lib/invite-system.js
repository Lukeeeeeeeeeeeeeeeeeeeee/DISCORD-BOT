const defaultDb = require('../db_async');
const { ROLE_IDS, RECRUITER_ROLE_IDS } = require('../constants');
const { formatUtcDate } = require('./time');
const { resolveGuildId } = require('./guild');
const invitesRepo = require('../repos/recruiter-invites-repo');
const cooldownsRepo = require('../repos/invite-cooldowns-repo');
const { acquireJobLock } = require('./job-locks');

const INVITE_CREATE_LOCK_MS = Number.parseInt(process.env.INVITE_CREATE_LOCK_MS || '10000', 10);

class InviteSystem {
  constructor(dbHandle = null) {
    this.db = dbHandle || defaultDb;
    this.activeInvites = new Map(); // key -> invite data
    this.inviteCooldowns = new Map(); // key -> timestamp
    this.initializedGuilds = new Set();
  }

  setDb(dbHandle) {
    if (dbHandle) this.db = dbHandle;
  }

  getDb() {
    return this.db || defaultDb;
  }

  makeKey(guildId, userId) {
    const gid = guildId || 'GLOBAL';
    return `${gid}:${userId}`;
  }

  async init(guildId = null) {
    const key = guildId || '*';
    if (this.initializedGuilds.has(key)) return;
    await this.loadActiveInvites(guildId);
    this.initializedGuilds.add(key);
    console.log(`Invite system initialized${guildId ? ` for ${guildId}` : ''}`);
  }

  async loadActiveInvites(guildId = null) {
    try {
      const db = this.getDb();
      if (guildId) {
        const prefix = `${guildId}:`;
        for (const key of Array.from(this.activeInvites.keys())) {
          if (key.startsWith(prefix)) this.activeInvites.delete(key);
        }
      } else {
        this.activeInvites.clear();
      }
      const now = Date.now();
      const allowGlobal = !guildId && (process.env.ALLOW_GLOBAL_INVITE_SCOPE || '').toLowerCase() === 'true';
      const rows = await invitesRepo.getActiveInvites(db, { guildId, now, allowGlobal });
      for (const invite of rows || []) {
        const storedGuildId = invite.guild_id || 'GLOBAL';
        const key = this.makeKey(storedGuildId, invite.recruiter_id);
        this.activeInvites.set(key, {
          guildId: storedGuildId,
          code: invite.invite_code,
          url: invite.invite_url,
          createdAt: invite.created_at,
          expiresAt: invite.expires_at,
          maxUses: 1,
          currentUses: invite.used
        });
      }
      console.log(`Loaded ${rows ? rows.length : 0} active invites`);
    } catch (error) {
      console.error('Error loading active invites:', error);
    }
  }

  async isRecruiter(userId, guild, memberOverride = null) {
    try {
      const member = memberOverride || await guild.members.fetch(userId).catch(() => null);
      if (!member) return false;

      const recruiterRoles = [
        ROLE_IDS.TRIAL_RECRUITER,
        ROLE_IDS.RECRUITER,
        ...(RECRUITER_ROLE_IDS ? Object.values(RECRUITER_ROLE_IDS) : [])
      ].filter(Boolean);

      return recruiterRoles.some(roleId => member.roles.cache.has(roleId));
    } catch (error) {
      console.error('Error checking recruiter status:', error);
      return false;
    }
  }

  async createInvite(recruiterId, guild) {
    try {
      const db = this.getDb();
      const guildId = resolveGuildId(guild) || 'GLOBAL';
      const key = this.makeKey(guildId, recruiterId);
      const lockTtl = Number.isFinite(INVITE_CREATE_LOCK_MS) && INVITE_CREATE_LOCK_MS > 0
        ? INVITE_CREATE_LOCK_MS
        : 10000;
      const lockOk = await acquireJobLock(db, {
        guildId,
        key: `invite_create_${recruiterId}`,
        ttlMs: lockTtl,
        failOpen: false
      });
      if (!lockOk) {
        return {
          success: false,
          message: 'An invite request is already being processed. Please try again in a few seconds.'
        };
      }

      await this.cleanupExpiredInvites(guildId);

      if (this.activeInvites.has(key)) {
        const activeInvite = this.activeInvites.get(key);
        const now = Date.now();

        if (activeInvite.currentUses === 0 && activeInvite.expiresAt > now) {
          const timeLeft = activeInvite.expiresAt - now;
          const minutesLeft = Math.ceil(timeLeft / (60 * 1000));
          return {
            success: true,
            invite: {
              code: activeInvite.code,
              url: activeInvite.url,
              expiresAt: formatUtcDate(activeInvite.expiresAt),
              expiresIn: `${minutesLeft} minutes`
            },
            reused: true
          };
        } else {
          this.activeInvites.delete(key);
        }
      }

      const cooldownTime = 90 * 60 * 1000;
      const now = Date.now();

      const cachedCooldown = this.inviteCooldowns.get(key);
      if (cachedCooldown && cachedCooldown > now) {
        const minutesLeft = Math.ceil((cachedCooldown - now) / (60 * 1000));
        return {
          success: false,
          message: `You must wait ${minutesLeft} minutes before creating another invite.`
        };
      }
      const cooldownRow = await cooldownsRepo.getCooldown(db, guildId, recruiterId).catch(() => null);
      if (cooldownRow && Number(cooldownRow.cooldown_until) > now) {
        this.inviteCooldowns.set(key, Number(cooldownRow.cooldown_until));
        const minutesLeft = Math.ceil((Number(cooldownRow.cooldown_until) - now) / (60 * 1000));
        return {
          success: false,
          message: `You must wait ${minutesLeft} minutes before creating another invite.`
        };
      }

      const botMember = guild.members.me
        || await guild.members.fetch(guild.client.user.id).catch(() => null);
      if (!botMember) {
        return {
          success: false,
          message: 'Unable to resolve bot member for invite creation.'
        };
      }

      const channel = guild.channels.cache.find(ch =>
        ch.type === 0 && ch.permissionsFor(botMember).has('CreateInstantInvite')
      );

      if (!channel) {
        return {
          success: false,
          message: 'No suitable channel found to create invite.'
        };
      }

      const invite = await channel.createInvite({
        maxAge: 90 * 60,
        maxUses: 1,
        unique: true,
        reason: `Recruiter invite for ${recruiterId}`
      });

      const expiresAt = Date.now() + (90 * 60 * 1000);

      await invitesRepo.insertInvite(db, guildId, {
        recruiterId,
        inviteCode: invite.code,
        inviteUrl: invite.url,
        createdAt: Date.now(),
        expiresAt
      });

      this.activeInvites.set(key, {
        guildId,
        code: invite.code,
        url: invite.url,
        createdAt: Date.now(),
        expiresAt,
        maxUses: 1,
        currentUses: 0
      });

      const cooldownUntil = Date.now() + cooldownTime;
      this.inviteCooldowns.set(key, cooldownUntil);
      await cooldownsRepo.upsertCooldown(db, guildId, recruiterId, cooldownUntil);

      return {
        success: true,
        invite: {
          code: invite.code,
          url: invite.url,
          expiresAt: formatUtcDate(expiresAt),
          expiresIn: '1 hour 30 minutes'
        }
      };

    } catch (error) {
      console.error('Error creating invite:', error);
      return {
        success: false,
        message: 'Failed to create invite. Please try again later.'
      };
    }
  }

  getInviteStatus(userId, guildOrGuildId) {
    const guildId = resolveGuildId(guildOrGuildId) || 'GLOBAL';
    const key = this.makeKey(guildId, userId);
    const activeInvite = this.activeInvites.get(key);
    const now = Date.now();

    if (activeInvite) {
      if (activeInvite.currentUses > 0 || activeInvite.expiresAt <= now) {
        this.activeInvites.delete(key);

        const cachedCooldown = this.inviteCooldowns.get(key);
        if (cachedCooldown && cachedCooldown > now) {
          const minutesLeft = Math.ceil((cachedCooldown - now) / (60 * 1000));
          return {
            hasActive: false,
            onCooldown: true,
            cooldownLeft: `${minutesLeft} minutes`
          };
        }

        return {
          hasActive: false,
          onCooldown: false,
          canCreate: true
        };
      }

      const timeLeft = activeInvite.expiresAt - now;
      const minutesLeft = Math.ceil(timeLeft / (60 * 1000));

      return {
        hasActive: true,
        code: activeInvite.code,
        url: activeInvite.url,
        expiresAt: formatUtcDate(activeInvite.expiresAt),
        timeLeft: `${minutesLeft} minutes`,
        isExpired: false
      };
    }

    const cachedCooldown = this.inviteCooldowns.get(key);
    if (cachedCooldown && cachedCooldown > now) {
      const minutesLeft = Math.ceil((cachedCooldown - now) / (60 * 1000));
      return {
        hasActive: false,
        onCooldown: true,
        cooldownLeft: `${minutesLeft} minutes`
      };
    }

    return {
      hasActive: false,
      onCooldown: false,
      canCreate: true
    };
  }

  async markInviteUsed(inviteCode, usedBy = null, guildOrGuildId = null) {
    try {
      const db = this.getDb();
      const guildId = resolveGuildId(guildOrGuildId) || null;
      await invitesRepo.markUsed(db, guildId, inviteCode, usedBy, Date.now());

      for (const [key, invite] of this.activeInvites.entries()) {
        if (invite.code === inviteCode && (!guildId || invite.guildId === guildId)) {
          invite.currentUses = 1;
          const cooldownUntil = Date.now() + (90 * 60 * 1000);
          this.inviteCooldowns.set(key, cooldownUntil);
          const parts = key.split(':');
          const g = parts[0];
          const uid = parts[1];
          await cooldownsRepo.upsertCooldown(db, g, uid, cooldownUntil);
          break;
        }
      }

      console.log(`Invite ${inviteCode} marked as used`);
    } catch (error) {
      console.error('Error marking invite as used:', error);
    }
  }

  async markInviteExpired(inviteCode, guildOrGuildId = null) {
    try {
      const db = this.getDb();
      const guildId = resolveGuildId(guildOrGuildId) || null;
      await invitesRepo.markExpired(db, guildId, inviteCode, Date.now());

      for (const [key, invite] of this.activeInvites.entries()) {
        if (invite.code === inviteCode && (!guildId || invite.guildId === guildId)) {
          this.activeInvites.delete(key);
          const cooldownUntil = Date.now() + (90 * 60 * 1000);
          this.inviteCooldowns.set(key, cooldownUntil);
          const parts = key.split(':');
          const g = parts[0];
          const uid = parts[1];
          await cooldownsRepo.upsertCooldown(db, g, uid, cooldownUntil);
          break;
        }
      }

      console.log(`Invite ${inviteCode} marked as expired`);
    } catch (error) {
      console.error('Error marking invite as expired:', error);
    }
  }

  async cleanupExpiredInvites(guildOrGuildId = null) {
    try {
      const db = this.getDb();
      const now = Date.now();
      const guildId = resolveGuildId(guildOrGuildId) || null;
      const prefix = guildId ? `${guildId}:` : null;
      const yieldEvery = 100;
      let iterations = 0;

      for (const [key, invite] of this.activeInvites.entries()) {
        if (invite.expiresAt <= now && (!prefix || key.startsWith(prefix))) {
          this.activeInvites.delete(key);
        }
        if (++iterations % yieldEvery === 0) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }

      for (const [key, cooldownUntil] of this.inviteCooldowns.entries()) {
        if (cooldownUntil <= now && (!prefix || key.startsWith(prefix))) {
          this.inviteCooldowns.delete(key);
        }
        if (++iterations % yieldEvery === 0) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }

      const allowGlobal = !guildId && (process.env.ALLOW_GLOBAL_INVITE_SCOPE || '').toLowerCase() === 'true';
      await invitesRepo.cleanupExpired(db, { guildId, now, allowGlobal });
      await cooldownsRepo.cleanupExpired(db, { guildId, now, allowGlobal: !guildId });

    } catch (error) {
      console.error('Error cleaning up expired invites:', error);
    }
  }

  async getStats(guildOrGuildId = null) {
    try {
      const db = this.getDb();
      const now = Date.now();
      const guildId = resolveGuildId(guildOrGuildId) || null;
      const allowGlobal = !guildId && (process.env.ALLOW_GLOBAL_INVITE_SCOPE || '').toLowerCase() === 'true';
      const stats = await invitesRepo.getStats(db, { guildId, now, sinceMs: now - (7 * 24 * 60 * 60 * 1000), allowGlobal });

      return {
        totalInvites: stats && stats.total_invites ? stats.total_invites : 0,
        usedInvites: stats && stats.used_invites ? stats.used_invites : 0,
        activeInvites: stats && stats.active_invites ? stats.active_invites : 0,
        memoryActive: Array.from(this.activeInvites.keys()).filter(k => !guildId || k.startsWith(`${guildId}:`)).length
      };
    } catch (error) {
      console.error('Error getting invite stats:', error);
      return { totalInvites: 0, usedInvites: 0, activeInvites: 0, memoryActive: 0 };
    }
  }

  async getActiveInviteCodeCandidates(guildOrGuildId = null) {
    try {
      const db = this.getDb();
      const guildId = resolveGuildId(guildOrGuildId) || null;
      const allowGlobal = !guildId && (process.env.ALLOW_GLOBAL_INVITE_SCOPE || '').toLowerCase() === 'true';
      return await invitesRepo.getActiveCodes(db, { guildId, now: Date.now(), limit: 10, allowGlobal });
    } catch (e) {
      return [];
    }
  }
}

module.exports = InviteSystem;
