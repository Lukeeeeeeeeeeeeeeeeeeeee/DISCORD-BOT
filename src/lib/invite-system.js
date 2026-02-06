const db = require('../db_async');
const { formatUtcDate } = require('./time');

class InviteSystem {
  constructor() {
    this.activeInvites = new Map(); // userId -> invite data
    this.inviteCooldowns = new Map(); // userId -> timestamp
  }

  // Initialize the invite system
  async init() {
    // Load active invites from database
    await this.loadActiveInvites();
    console.log('🔗 Invite system initialized');
  }

  // Load active invites from database
  async loadActiveInvites() {
    try {
      const activeInvites = await db.all(`
        SELECT * FROM recruiter_invites 
        WHERE used = 0 AND expires_at > ?
        ORDER BY created_at DESC
      `, Date.now());

      for (const invite of activeInvites) {
        this.activeInvites.set(invite.recruiter_id, {
          code: invite.invite_code,
          url: invite.invite_url,
          createdAt: invite.created_at,
          expiresAt: invite.expires_at,
          maxUses: 1,
          currentUses: invite.used
        });
      }

      console.log(`📋 Loaded ${activeInvites.length} active invites`);
    } catch (error) {
      console.error('Error loading active invites:', error);
    }
  }

  // Check if user is a recruiter (trial, regular, or any type)
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

  // Create a new invite for a recruiter
  async createInvite(recruiterId, guild) {
    try {
      // Clean up expired invites first
      await this.cleanupExpiredInvites();

      // Check if user has an active unused invite
      if (this.activeInvites.has(recruiterId)) {
        const activeInvite = this.activeInvites.get(recruiterId);
        const now = Date.now();

        // Check if the existing invite is still valid
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
          // Remove expired/used invite from memory
          this.activeInvites.delete(recruiterId);
        }
      }

      // Check cooldown (1 hour 30 minutes = 90 minutes = 5400000 ms)
      const cooldownTime = 90 * 60 * 1000; // 1.5 hours in ms
      const now = Date.now();

      if (this.inviteCooldowns.has(recruiterId)) {
        const lastUsed = this.inviteCooldowns.get(recruiterId);
        const timeLeft = lastUsed + cooldownTime - now;

        if (timeLeft > 0) {
          const minutesLeft = Math.ceil(timeLeft / (60 * 1000));
          return {
            success: false,
            message: `You must wait ${minutesLeft} minutes before creating another invite.`
          };
        }
      }

      // Create Discord invite
      const channel = guild.channels.cache.find(ch =>
        ch.type === 0 && ch.permissionsFor(guild.members.me).has('CreateInstantInvite')
      );

      if (!channel) {
        return {
          success: false,
          message: 'No suitable channel found to create invite.'
        };
      }

      const invite = await channel.createInvite({
        maxAge: 90 * 60, // 1 hour 30 minutes in seconds
        maxUses: 1,
        unique: true,
        reason: `Recruiter invite for ${recruiterId}`
      });

      const expiresAt = Date.now() + (90 * 60 * 1000); // 1 hour 30 minutes from now

      // Save to database
      await db.run(`
        INSERT INTO recruiter_invites 
        (recruiter_id, invite_code, invite_url, created_at, expires_at, used)
        VALUES (?, ?, ?, ?, ?, 0)
      `, recruiterId, invite.code, invite.url, Date.now(), expiresAt);

      // Store in memory
      this.activeInvites.set(recruiterId, {
        code: invite.code,
        url: invite.url,
        createdAt: Date.now(),
        expiresAt: expiresAt,
        maxUses: 1,
        currentUses: 0
      });

      // Set cooldown
      this.inviteCooldowns.set(recruiterId, Date.now());

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

  // Get user's current invite status
  getInviteStatus(userId) {
    const activeInvite = this.activeInvites.get(userId);
    const now = Date.now();

    if (activeInvite) {
      // Check if invite has expired or been used
      if (activeInvite.currentUses > 0 || activeInvite.expiresAt <= now) {
        // Remove expired/used invite from memory
        this.activeInvites.delete(userId);

        // Check cooldown
        if (this.inviteCooldowns.has(userId)) {
          const lastUsed = this.inviteCooldowns.get(userId);
          const cooldownTime = 90 * 60 * 1000; // 1.5 hours
          const timeLeft = lastUsed + cooldownTime - now;

          if (timeLeft > 0) {
            const minutesLeft = Math.ceil(timeLeft / (60 * 1000));
            return {
              hasActive: false,
              onCooldown: true,
              cooldownLeft: `${minutesLeft} minutes`
            };
          }
        }

        return {
          hasActive: false,
          onCooldown: false,
          canCreate: true
        };
      }

      // Invite is still active
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

    // Check cooldown
    if (this.inviteCooldowns.has(userId)) {
      const lastUsed = this.inviteCooldowns.get(userId);
      const cooldownTime = 90 * 60 * 1000; // 1.5 hours
      const timeLeft = lastUsed + cooldownTime - now;

      if (timeLeft > 0) {
        const minutesLeft = Math.ceil(timeLeft / (60 * 1000));
        return {
          hasActive: false,
          onCooldown: true,
          cooldownLeft: `${minutesLeft} minutes`
        };
      }
    }

    return {
      hasActive: false,
      onCooldown: false,
      canCreate: true
    };
  }

  // Mark invite as used
  async markInviteUsed(inviteCode, usedBy = null) {
    try {
      await db.run(`
        UPDATE recruiter_invites 
        SET used = 1, used_at = ?, used_by = ?
        WHERE invite_code = ?
      `, Date.now(), usedBy, inviteCode);

      // Find and update in memory
      for (const [recruiterId, invite] of this.activeInvites.entries()) {
        if (invite.code === inviteCode) {
          invite.currentUses = 1;
          // Set cooldown when invite is used
          this.inviteCooldowns.set(recruiterId, Date.now());
          break;
        }
      }

      console.log(`✅ Invite ${inviteCode} marked as used`);
    } catch (error) {
      console.error('Error marking invite as used:', error);
    }
  }

  // Mark invite as expired (when cancelled or manually expired)
  async markInviteExpired(inviteCode) {
    try {
      // Update in database
      await db.run(`
        UPDATE recruiter_invites 
        SET used = 1, used_at = ?
        WHERE invite_code = ?
      `, Date.now(), inviteCode);

      // Remove from memory and set cooldown
      for (const [recruiterId, invite] of this.activeInvites.entries()) {
        if (invite.code === inviteCode) {
          this.activeInvites.delete(recruiterId);
          // Set cooldown when invite expires/cancelled
          this.inviteCooldowns.set(recruiterId, Date.now());
          break;
        }
      }

      console.log(`⏰ Invite ${inviteCode} marked as expired`);
    } catch (error) {
      console.error('Error marking invite as expired:', error);
    }
  }

  // Clean up expired invites
  async cleanupExpiredInvites() {
    try {
      const now = Date.now();
      const yieldEvery = 100;
      let iterations = 0;

      // Remove from memory
      for (const [recruiterId, invite] of this.activeInvites.entries()) {
        if (invite.expiresAt <= now) {
          this.activeInvites.delete(recruiterId);
        }
        if (++iterations % yieldEvery === 0) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }

      // Remove cooldowns that have expired
      for (const [userId, timestamp] of this.inviteCooldowns.entries()) {
        if (timestamp + (90 * 60 * 1000) <= now) {
          this.inviteCooldowns.delete(userId);
        }
        if (++iterations % yieldEvery === 0) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }

      // Clean database
      await db.run(`
        DELETE FROM recruiter_invites 
        WHERE expires_at < ? OR (used = 1 AND used_at < ?)
      `, now, now - (7 * 24 * 60 * 60 * 1000)); // Keep used invites for 7 days

    } catch (error) {
      console.error('Error cleaning up expired invites:', error);
    }
  }

  // Get statistics
  async getStats() {
    try {
      const stats = await db.get(`
        SELECT 
          COUNT(*) as total_invites,
          COUNT(CASE WHEN used = 1 THEN 1 END) as used_invites,
          COUNT(CASE WHEN used = 0 AND expires_at > ? THEN 1 END) as active_invites
        FROM recruiter_invites
        WHERE created_at > ?
      `, Date.now(), Date.now() - (7 * 24 * 60 * 60 * 1000)); // Last 7 days

      return {
        totalInvites: stats.total_invites || 0,
        usedInvites: stats.used_invites || 0,
        activeInvites: stats.active_invites || 0,
        memoryActive: this.activeInvites.size
      };
    } catch (error) {
      console.error('Error getting invite stats:', error);
      return { totalInvites: 0, usedInvites: 0, activeInvites: 0, memoryActive: 0 };
    }
  }

  async getActiveInviteCodeCandidates() {
    try {
      const rows = await db.all(
        'SELECT invite_code FROM recruiter_invites WHERE used = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT 10',
        Date.now()
      );
      return (rows || []).map(r => r.invite_code).filter(Boolean);
    } catch (e) {
      return [];
    }
  }
}

module.exports = InviteSystem;
