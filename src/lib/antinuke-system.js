const AntiNuke = require('./antinuke');
const AntiNukeRollback = require('./antinuke-rollback');
const runtime = require('./runtime');

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

      runtime.setClient(client);
      runtime.setAntiNuke(this.antiNuke);
      runtime.setAntiNukeRollback(this.rollback);

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
    // IMPORTANT:
    // We only record rollback state for actions *performed by the anti-nuke system itself*.
    // Tracking events (like a user banning/kicking/etc) should not be recorded for rollback,
    // otherwise we end up storing corrupted/meaningless data.

    const originalHandleRapidAction = this.antiNuke.handleRapidAction.bind(this.antiNuke);
    this.antiNuke.handleRapidAction = async (...args) => {
      const [guildId, userId] = args;
      const guild = this.antiNuke.client.guilds.cache.get(guildId);
      const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;

      if (guild && member) {
        await this.rollback.recordPreActionState(guild, 'ban', member);
      }

      await originalHandleRapidAction(...args);

      if (guild && member) {
        await this.rollback.recordPostActionState(guild, 'ban', member);
      }
    };

    const originalHandleBeastModeTrigger = this.antiNuke.handleBeastModeTrigger.bind(this.antiNuke);
    this.antiNuke.handleBeastModeTrigger = async (...args) => {
      const [guildId, userId] = args;
      const guild = this.antiNuke.client.guilds.cache.get(guildId);
      const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;

      if (guild && member) {
        await this.rollback.recordPreActionState(guild, 'ban', member);
      }

      await originalHandleBeastModeTrigger(...args);

      if (guild && member) {
        await this.rollback.recordPostActionState(guild, 'ban', member);
      }
    };

    const originalHandleEmergencyMode = this.antiNuke.handleEmergencyMode.bind(this.antiNuke);
    this.antiNuke.handleEmergencyMode = async (...args) => {
      const [guildId] = args;
      const guild = this.antiNuke.client.guilds.cache.get(guildId);
      if (guild) {
        await this.rollback.recordPreActionState(guild, 'emergency_lockdown', null);
      }

      await originalHandleEmergencyMode(...args);

      if (guild) {
        await this.rollback.recordPostActionState(guild, 'emergency_lockdown', null);
      }
    };

    const originalHandleMassBanLockdown = this.antiNuke.handleMassBanLockdown.bind(this.antiNuke);
    this.antiNuke.handleMassBanLockdown = async (...args) => {
      const [guildId] = args;
      const guild = this.antiNuke.client.guilds.cache.get(guildId);
      if (guild) {
        await this.rollback.recordPreActionState(guild, 'role_permissions', null);
      }

      await originalHandleMassBanLockdown(...args);

      if (guild) {
        await this.rollback.recordPostActionState(guild, 'role_permissions', null);
      }
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
