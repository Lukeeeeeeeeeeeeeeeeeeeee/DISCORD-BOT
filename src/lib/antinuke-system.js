const AntiNuke = require('./lib/antinuke');
const AntiNukeRollback = require('./lib/antinuke-rollback');

class AntiNukeSystem {
  constructor() {
    this.antiNuke = new AntiNuke();
    this.rollback = new AntiNukeRollback();
    this.initialized = false;
  }

  // Initialize the complete anti-nuke system
  async init(client) {
    if (this.initialized) return;

    try {
      // Initialize both systems
      await this.antiNuke.init(client);
      await this.rollback.init();

      // Make anti-nuke globally accessible
      global.antiNuke = this.antiNuke;
      global.antiNukeRollback = this.rollback;

      // Set up integration between systems
      this.setupIntegration();

      this.initialized = true;
      console.log('🛡️ Complete Anti-Nuke System initialized with rollback support!');

    } catch (error) {
      console.error('❌ Failed to initialize anti-nuke system:', error);
      throw error;
    }
  }

  // Set up integration between anti-nuke and rollback
  setupIntegration() {
    // Wrap anti-nuke actions with rollback tracking
    const originalTrackAction = this.antiNuke.trackAction.bind(this.antiNuke);
    
    this.antiNuke.trackAction = (guildId, userId, actionType, details) => {
      // Record pre-action state for rollback
      const guild = this.antiNuke.client.guilds.cache.get(guildId);
      if (guild) {
        this.rollback.recordPreActionState(guild, actionType, details);
      }

      // Execute original tracking
      originalTrackAction(guildId, userId, actionType, details);

      // Record post-action state for rollback
      if (guild) {
        this.rollback.recordPostActionState(guild, actionType, details);
      }
    };

    // Override ban handler to include rollback
    const originalHandleBan = this.antiNuke.handleBan.bind(this.antiNuke);
    this.antiNuke.handleBan = async (ban) => {
      const guild = ban.guild;
      const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: 'MEMBER_BAN_ADD' }).catch(() => null);
      const executor = auditLogs?.entries.first()?.executor;
      
      if (!executor || executor.id === this.antiNuke.client.user.id) return;

      // Get target member before ban for rollback
      const targetMember = await guild.members.fetch(ban.user.id).catch(() => null);
      
      // Record pre-action state
      this.rollback.recordPreActionState(guild, 'ban', targetMember);
      
      // Execute original ban handling
      await originalHandleBan(ban);
      
      // Record post-action state
      this.rollback.recordPostActionState(guild, 'ban', targetMember);
    };

    // Override kick handler to include rollback
    const originalHandleKick = this.antiNuke.handleKick.bind(this.antiNuke);
    this.antiNuke.handleKick = async (member) => {
      const guild = member.guild;
      const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: 'MEMBER_KICK' }).catch(() => null);
      const executor = auditLogs?.entries.first()?.executor;
      
      if (!executor || executor.id === this.antiNuke.client.user.id) return;

      // Record pre-action state
      this.rollback.recordPreActionState(guild, 'kick', member);
      
      // Execute original kick handling
      await originalHandleKick(member);
      
      // Record post-action state
      this.rollback.recordPostActionState(guild, 'kick', member);
    };

    // Override channel delete handler to include rollback
    const originalHandleChannelDelete = this.antiNuke.handleChannelDelete.bind(this.antiNuke);
    this.antiNuke.handleChannelDelete = async (channel) => {
      const guild = channel.guild;
      const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: 'CHANNEL_DELETE' }).catch(() => null);
      const executor = auditLogs?.entries.first()?.executor;
      
      if (!executor || executor.id === this.antiNuke.client.user.id) return;

      // Record pre-action state
      this.rollback.recordPreActionState(guild, 'channel_delete', channel);
      
      // Execute original channel delete handling
      await originalHandleChannelDelete(channel);
      
      // Record post-action state
      this.rollback.recordPostActionState(guild, 'channel_delete', channel);
    };

    // Override role delete handler to include rollback
    const originalHandleRoleDelete = this.antiNuke.handleRoleDelete.bind(this.antiNuke);
    this.antiNuke.handleRoleDelete = async (role) => {
      const guild = role.guild;
      const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: 'ROLE_DELETE' }).catch(() => null);
      const executor = auditLogs?.entries.first()?.executor;
      
      if (!executor || executor.id === this.antiNuke.client.user.id) return;

      // Record pre-action state
      this.rollback.recordPreActionState(guild, 'role_delete', role);
      
      // Execute original role delete handling
      await originalHandleRoleDelete(role);
      
      // Record post-action state
      this.rollback.recordPostActionState(guild, 'role_delete', role);
    };

    // Override emergency mode handler to include rollback
    const originalHandleEmergencyMode = this.antiNuke.handleEmergencyMode.bind(this.antiNuke);
    this.antiNuke.handleEmergencyMode = async (guildId) => {
      const guild = this.antiNuke.client.guilds.cache.get(guildId);
      if (!guild) return;

      // Record pre-action state
      this.rollback.recordPreActionState(guild, 'emergency_lockdown', null);
      
      // Execute original emergency mode handling
      await originalHandleEmergencyMode(guildId);
      
      // Record post-action state
      this.rollback.recordPostActionState(guild, 'emergency_lockdown', null);
    };

    // Override bot addition handler to include rollback
    const originalHandleMemberAdd = this.antiNuke.handleMemberAdd.bind(this.antiNuke);
    this.antiNuke.handleMemberAdd = async (member) => {
      if (!member.user.bot) return;
      
      const guild = member.guild;
      const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: 'BOT_ADD' }).catch(() => null);
      const executor = auditLogs?.entries.first()?.executor;
      
      if (!executor || executor.id === this.antiNuke.client.user.id) return;

      // Record pre-action state
      this.rollback.recordPreActionState(guild, 'bot_add', member);
      
      // Execute original bot addition handling
      await originalHandleMemberAdd(member);
      
      // Record post-action state
      this.rollback.recordPostActionState(guild, 'bot_add', member);
    };

    console.log('🔄 Anti-nuke rollback integration enabled');
  }

  // Get system status
  getStatus() {
    if (!this.initialized) {
      return {
        initialized: false,
        message: 'Anti-nuke system not initialized'
      };
    }

    return {
      initialized: true,
      antiNuke: 'Active',
      rollback: 'Active',
      integration: 'Active',
      features: {
        protection: '45+ features',
        rollback: 'Complete restoration',
        logging: 'Dual channel',
        backup: 'Automatic',
        whitelist: 'Persistent',
        beastMode: 'Smart detection',
        emergency: 'Multi-threshold'
      }
    };
  }

  // Check if user is owner (for rollback command)
  isOwner(userId) {
    return this.antiNuke.isOwner(userId);
  }

  // Get rollback status
  getRollbackStatus(guildId) {
    return this.rollback.getRollbackStatus(guildId);
  }

  // Perform rollback
  async rollbackAll(guild, client) {
    return await this.rollback.rollbackAll(guild, client);
  }
}

module.exports = AntiNukeSystem;
