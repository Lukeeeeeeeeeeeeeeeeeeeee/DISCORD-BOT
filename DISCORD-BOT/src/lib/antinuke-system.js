const AntiNuke = require('./antinuke');
const AntiNukeRollback = require('./antinuke-rollback');
const runtime = require('./runtime');

class AntiNukeSystem {
  constructor() {
    this.antiNuke = new AntiNuke();
    this.rollback = new AntiNukeRollback();
    this.initialized = false;
  }

  normalizeActionToken(actionType) {
    const raw = actionType == null ? 'unknown' : String(actionType);
    return raw
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase() || 'unknown';
  }

  resolveRapidRollbackActionType(actionType) {
    return `rapid_${this.normalizeActionToken(actionType)}`;
  }

  getCurrentShardId() {
    const shard = this.antiNuke && this.antiNuke.client ? this.antiNuke.client.shard : null;
    if (!shard) return null;
    const ids = Array.isArray(shard.ids) ? shard.ids : [];
    if (!ids.length) return null;
    const first = Number(ids[0]);
    return Number.isFinite(first) ? first : null;
  }

  buildRollbackMeta(extra = {}) {
    const shardId = this.getCurrentShardId();
    return {
      shardId,
      ...extra
    };
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
    this.antiNuke.handleRapidAction = async (guildId, userId, actionType, actions) => {
      const guild = this.antiNuke.client.guilds.cache.get(guildId);
      const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
      const rollbackActionType = this.resolveRapidRollbackActionType(actionType);
      const meta = this.buildRollbackMeta({
        triggerActionType: actionType || null,
        eventFamily: 'rapid_action',
        actionCount: Array.isArray(actions) ? actions.length : 0
      });

      if (guild && member) {
        await this.rollback.recordPreActionState(guild, rollbackActionType, member, meta);
      }

      await originalHandleRapidAction(guildId, userId, actionType, actions);

      if (guild && member) {
        await this.rollback.recordPostActionState(guild, rollbackActionType, member, meta);
      }
    };

    const originalHandleBeastModeTrigger = this.antiNuke.handleBeastModeTrigger.bind(this.antiNuke);
    this.antiNuke.handleBeastModeTrigger = async (guildId, userId, score) => {
      const guild = this.antiNuke.client.guilds.cache.get(guildId);
      const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
      const meta = this.buildRollbackMeta({
        triggerActionType: 'beast_mode',
        eventFamily: 'beast_mode',
        score: Number(score)
      });

      if (guild && member) {
        await this.rollback.recordPreActionState(guild, 'beast_mode', member, meta);
      }

      await originalHandleBeastModeTrigger(guildId, userId, score);

      if (guild && member) {
        await this.rollback.recordPostActionState(guild, 'beast_mode', member, meta);
      }
    };

    const originalHandleEmergencyMode = this.antiNuke.handleEmergencyMode.bind(this.antiNuke);
    this.antiNuke.handleEmergencyMode = async (guildId) => {
      const guild = this.antiNuke.client.guilds.cache.get(guildId);
      const meta = this.buildRollbackMeta({
        triggerActionType: 'emergency_mode',
        eventFamily: 'emergency'
      });
      if (guild) {
        await this.rollback.recordPreActionState(guild, 'emergency_lockdown', null, meta);
      }

      await originalHandleEmergencyMode(guildId);

      if (guild) {
        await this.rollback.recordPostActionState(guild, 'emergency_lockdown', null, meta);
      }
    };

    const originalHandleMassBanLockdown = this.antiNuke.handleMassBanLockdown.bind(this.antiNuke);
    this.antiNuke.handleMassBanLockdown = async (guildId) => {
      const guild = this.antiNuke.client.guilds.cache.get(guildId);
      const meta = this.buildRollbackMeta({
        triggerActionType: 'mass_ban_lockdown',
        eventFamily: 'mass_ban'
      });
      if (guild) {
        await this.rollback.recordPreActionState(guild, 'role_permissions', null, meta);
      }

      await originalHandleMassBanLockdown(guildId);

      if (guild) {
        await this.rollback.recordPostActionState(guild, 'role_permissions', null, meta);
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
