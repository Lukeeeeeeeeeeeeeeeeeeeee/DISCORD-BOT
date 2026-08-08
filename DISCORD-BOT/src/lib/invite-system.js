const db = require('../db_async');
const { GUILD_ID } = require('../constants');
const { formatUtcDate } = require('./time');

function resolveDefaultGuildId() {
  return process.env.GUILD_ID || GUILD_ID || 'GLOBAL';
}

class InviteSystem {
  constructor() {
    this.activeInvites = new Map(); // recruiterId -> invite data
    this.inviteCooldowns = new Map(); // recruiterId -> timestamp
    this.guildId = resolveDefaultGuildId();
  }

  resolveGuildId(guildOrId = null) {
    if (typeof guildOrId === 'string' && guildOrId) return guildOrId;
    if (guildOrId && guildOrId.id) return guildOrId.id;
    return this.guildId || resolveDefaultGuildId();
  }

  async init(guildOrId = null) {
    this.guildId = this.resolveGuildId(guildOrId);
    await this.loadActiveInvites();
    console.log(`Invite system initialized for guild ${this.guildId}`);
  }

  async loadActiveInvites() {
    try {
      this.activeInvites.clear();
      const activeInvites = await db.all(
        `SELECT *
         FROM recruiter_invites
         WHERE guild_id = ? AND used = 0 AND expires_at > ?
         ORDER BY created_at DESC`,
        this.guildId,
        Date.now()
      );

      for (const invite of activeInvites || []) {
        if (!invite || !invite.recruiter_id) continue;
        this.activeInvites.set(invite.recruiter_id, {
          code: invite.invite_code,
          url: invite.invite_url,
          createdAt: invite.created_at,
          expiresAt: invite.expires_at,
          maxUses: 1,
          currentUses: Number(invite.used || 0)
        });
      }

      console.log(`Loaded ${this.activeInvites.size} active invites for guild ${this.guildId}`);
    } catch (error) {
      console.error('Error loading active invites:', error);
    }
  }

  async isRecruiter(userId, guild, memberOverride = null) {
    try {
      const member = memberOverride || await guild.members.fetch(userId).catch(() => null);
      if (!member) return false;

      const { ROLE_IDS, RECRUITER_ROLE_IDS } = require('../constants');
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
      this.guildId = this.resolveGuildId(guild);

      await this.cleanupExpiredInvites(this.guildId);

      if (this.activeInvites.has(recruiterId)) {
        const activeInvite = this.activeInvites.get(recruiterId);
        const now = Date.now();
        if (activeInvite.currentUses === 0 && activeInvite.expiresAt > now) {
          const minutesLeft = Math.ceil((activeInvite.expiresAt - now) / (60 * 1000));
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
        }
        this.activeInvites.delete(recruiterId);
      }

      const cooldownTime = 90 * 60 * 1000;
      const now = Date.now();
      if (this.inviteCooldowns.has(recruiterId)) {
        const lastUsed = this.inviteCooldowns.get(recruiterId);
        const timeLeft = lastUsed + cooldownTime - now;
        if (timeLeft > 0) {
          return {
            success: false,
            message: `You must wait ${Math.ceil(timeLeft / (60 * 1000))} minutes before creating another invite.`
          };
        }
      }

      const channel = guild.channels.cache.find(ch =>
        ch.type === 0 && ch.permissionsFor(guild.members.me).has('CreateInstantInvite')
      );
      if (!channel) {
        return { success: false, message: 'No suitable channel found to create invite.' };
      }

      const invite = await channel.createInvite({
        maxAge: 90 * 60,
        maxUses: 1,
        unique: true,
        reason: `Recruiter invite for ${recruiterId}`
      });
      const createdAt = Date.now();
      const expiresAt = createdAt + (90 * 60 * 1000);

      await db.run(
        `INSERT INTO recruiter_invites
         (guild_id, recruiter_id, invite_code, invite_url, created_at, expires_at, used)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
        this.guildId,
        recruiterId,
        invite.code,
        invite.url,
        createdAt,
        expiresAt
      );

      this.activeInvites.set(recruiterId, {
        code: invite.code,
        url: invite.url,
        createdAt,
        expiresAt,
        maxUses: 1,
        currentUses: 0
      });
      this.inviteCooldowns.set(recruiterId, createdAt);

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

  getInviteStatus(userId) {
    const activeInvite = this.activeInvites.get(userId);
    const now = Date.now();
    const cooldownTime = 90 * 60 * 1000;

    if (activeInvite) {
      if (activeInvite.currentUses > 0 || activeInvite.expiresAt <= now) {
        this.activeInvites.delete(userId);
      } else {
        return {
          hasActive: true,
          code: activeInvite.code,
          url: activeInvite.url,
          expiresAt: formatUtcDate(activeInvite.expiresAt),
          timeLeft: `${Math.ceil((activeInvite.expiresAt - now) / (60 * 1000))} minutes`,
          isExpired: false
        };
      }
    }

    if (this.inviteCooldowns.has(userId)) {
      const lastUsed = this.inviteCooldowns.get(userId);
      const timeLeft = lastUsed + cooldownTime - now;
      if (timeLeft > 0) {
        return {
          hasActive: false,
          onCooldown: true,
          cooldownLeft: `${Math.ceil(timeLeft / (60 * 1000))} minutes`
        };
      }
    }

    return {
      hasActive: false,
      onCooldown: false,
      canCreate: true
    };
  }

  async markInviteUsed(inviteCode, usedBy = null, guildOrId = null) {
    try {
      const guildId = this.resolveGuildId(guildOrId);
      await db.run(
        `UPDATE recruiter_invites
         SET used = 1, used_at = ?, used_by = ?
         WHERE guild_id = ? AND invite_code = ?`,
        Date.now(),
        usedBy,
        guildId,
        inviteCode
      );

      for (const [recruiterId, invite] of this.activeInvites.entries()) {
        if (invite.code === inviteCode) {
          invite.currentUses = 1;
          this.inviteCooldowns.set(recruiterId, Date.now());
          break;
        }
      }
      console.log(`Invite ${inviteCode} marked as used`);
    } catch (error) {
      console.error('Error marking invite as used:', error);
    }
  }

  async markInviteExpired(inviteCode, guildOrId = null) {
    try {
      const guildId = this.resolveGuildId(guildOrId);
      await db.run(
        `UPDATE recruiter_invites
         SET used = 1, used_at = ?
         WHERE guild_id = ? AND invite_code = ?`,
        Date.now(),
        guildId,
        inviteCode
      );

      for (const [recruiterId, invite] of this.activeInvites.entries()) {
        if (invite.code === inviteCode) {
          this.activeInvites.delete(recruiterId);
          this.inviteCooldowns.set(recruiterId, Date.now());
          break;
        }
      }
      console.log(`Invite ${inviteCode} marked as expired`);
    } catch (error) {
      console.error('Error marking invite as expired:', error);
    }
  }

  async cleanupExpiredInvites(guildOrId = null) {
    try {
      const guildId = this.resolveGuildId(guildOrId);
      const now = Date.now();
      const cooldownTime = 90 * 60 * 1000;
      const purgeWindow = 7 * 24 * 60 * 60 * 1000;
      let iterations = 0;
      const yieldEvery = 100;

      for (const [recruiterId, invite] of this.activeInvites.entries()) {
        if (invite.expiresAt <= now) {
          this.activeInvites.delete(recruiterId);
        }
        if (++iterations % yieldEvery === 0) await new Promise(resolve => setImmediate(resolve));
      }

      for (const [userId, timestamp] of this.inviteCooldowns.entries()) {
        if (timestamp + cooldownTime <= now) {
          this.inviteCooldowns.delete(userId);
        }
        if (++iterations % yieldEvery === 0) await new Promise(resolve => setImmediate(resolve));
      }

      await db.run(
        `DELETE FROM recruiter_invites
         WHERE guild_id = ? AND (expires_at < ? OR (used = 1 AND used_at < ?))`,
        guildId,
        now,
        now - purgeWindow
      );
    } catch (error) {
      console.error('Error cleaning up expired invites:', error);
    }
  }

  async getStats(guildOrId = null) {
    try {
      const guildId = this.resolveGuildId(guildOrId);
      const now = Date.now();
      const stats = await db.get(
        `SELECT
           COUNT(*) as total_invites,
           COUNT(CASE WHEN used = 1 THEN 1 END) as used_invites,
           COUNT(CASE WHEN used = 0 AND expires_at > ? THEN 1 END) as active_invites
         FROM recruiter_invites
         WHERE guild_id = ? AND created_at > ?`,
        now,
        guildId,
        now - (7 * 24 * 60 * 60 * 1000)
      );

      return {
        totalInvites: stats ? (stats.total_invites || 0) : 0,
        usedInvites: stats ? (stats.used_invites || 0) : 0,
        activeInvites: stats ? (stats.active_invites || 0) : 0,
        memoryActive: this.activeInvites.size
      };
    } catch (error) {
      console.error('Error getting invite stats:', error);
      return { totalInvites: 0, usedInvites: 0, activeInvites: 0, memoryActive: 0 };
    }
  }

  async getActiveInviteCodeCandidates(guildOrId = null) {
    try {
      const guildId = this.resolveGuildId(guildOrId);
      const rows = await db.all(
        `SELECT invite_code
         FROM recruiter_invites
         WHERE guild_id = ? AND used = 0 AND expires_at > ?
         ORDER BY created_at DESC LIMIT 10`,
        guildId,
        Date.now()
      );
      return (rows || []).map(r => r.invite_code).filter(Boolean);
    } catch (_error) {
      return [];
    }
  }
}

module.exports = InviteSystem;
