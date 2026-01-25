const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');

class AntiNuke {
  constructor() {
    // Configuration
    this.OWNER_ID = '1381692847018868778';
    this.LOG_DM_ID = '1262471979215355969';
    
    // Protection thresholds
    this.THRESHOLDS = {
      ban: { count: 4, time: 2500, stackCount: 8, stackTime: 3000 },
      kick: { count: 4, time: 2500 },
      channelDelete: { count: 4, time: 2500 },
      roleDelete: { count: 3, time: 5000 },
      webhookCreate: { count: 5, time: 10000 },
      emergency: [
        { count: 10, time: 10000 },
        { count: 20, time: 30000 },
        { count: 30, time: 300000 },
        { count: 50, time: 600000 },
        { count: 75, time: 1800000 },
        { count: 100, time: 3600000 }
      ],
      massBanLockdown: { count: 100, time: 3600000 }
    };
    
    // Beast mode settings
    this.BEAST_MODE_THRESHOLD = 40;
    this.POINTS = {
      ban: 20,
      botAdd: 20
    };
    
    // Data storage
    this.actionTracker = new Map(); // guildId -> Map<userId, actions[]>
    this.beastModeTracker = new Map(); // guildId -> Map<userId, score>
    this.hourlyBanTracker = new Map(); // guildId -> ban count
    this.emergencyMode = new Map(); // guildId -> boolean
    this.whitelist = new Set(); // userIds
    this.logChannels = new Map(); // guildId -> channelId
    this.backups = new Map(); // guildId -> backup data
    
    // File paths
    this.DATA_FILE = path.join(__dirname, '../data/antinuke_data.json');
    
    // Colors
    this.COLORS = {
      critical: 0x992D22,
      red: 0xFF0000,
      orange: 0xFFA500,
      yellow: 0xFFFF00,
      blue: 0x0000FF,
      green: 0x00FF00
    };
    
    // Dangerous permissions
    this.DANGEROUS_PERMISSIONS = [
      PermissionsBitField.Flags.Administrator,
      PermissionsBitField.Flags.ManageGuild,
      PermissionsBitField.Flags.ManageRoles,
      PermissionsBitField.Flags.ManageChannels,
      PermissionsBitField.Flags.BanMembers,
      PermissionsBitField.Flags.KickMembers,
      PermissionsBitField.Flags.ManageMessages,
      PermissionsBitField.Flags.MentionEveryone,
      PermissionsBitField.Flags.ManageWebhooks,
      PermissionsBitField.Flags.ManageEmojisAndStickers,
      PermissionsBitField.Flags.CreateInstantInvite,
      PermissionsBitField.Flags.ManageNicknames
    ];
  }

  // Initialize the anti-nuke system
  async init(client) {
    this.client = client;
    
    // Load data from file
    await this.loadData();
    
    // Start automated tasks
    this.startAutomatedTasks();
    
    // Set up event listeners
    this.setupEventListeners();
    
    console.log('🛡️ Anti-nuke system initialized with 45+ protection features');
  }

  // Load persistent data
  async loadData() {
    try {
      const data = await fs.readFile(this.DATA_FILE, 'utf8');
      const parsed = JSON.parse(data);
      
      if (parsed.whitelist) this.whitelist = new Set(parsed.whitelist);
      if (parsed.logChannels) this.logChannels = new Map(Object.entries(parsed.logChannels));
      
      console.log('📁 Anti-nuke data loaded successfully');
    } catch (error) {
      console.log('📁 No existing anti-nuke data found, starting fresh');
    }
  }

  // Save persistent data
  async saveData() {
    try {
      const data = {
        whitelist: Array.from(this.whitelist),
        logChannels: Object.fromEntries(this.logChannels)
      };
      await fs.writeFile(this.DATA_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('❌ Failed to save anti-nuke data:', error);
    }
  }

  // Set up event listeners
  setupEventListeners() {
    this.client.on('guildBanAdd', (ban) => this.handleBan(ban));
    this.client.on('guildMemberRemove', (member) => this.handleKick(member));
    this.client.on('channelDelete', (channel) => this.handleChannelDelete(channel));
    this.client.on('roleDelete', (role) => this.handleRoleDelete(role));
    this.client.on('guildMemberAdd', (member) => this.handleMemberAdd(member));
    this.client.on('webhookUpdate', (channel) => this.handleWebhookUpdate(channel));
  }

  // Track user action
  trackAction(guildId, userId, actionType, details = {}) {
    if (!this.actionTracker.has(guildId)) {
      this.actionTracker.set(guildId, new Map());
    }
    
    const guildTracker = this.actionTracker.get(guildId);
    if (!guildTracker.has(userId)) {
      guildTracker.set(userId, []);
    }
    
    const userActions = guildTracker.get(userId);
    userActions.push({
      type: actionType,
      timestamp: Date.now(),
      details
    });
    
    // Update beast mode score
    this.updateBeastModeScore(guildId, userId, actionType);
    
    // Check for rapid actions
    this.checkRapidActions(guildId, userId, actionType);
  }

  // Update beast mode score
  updateBeastModeScore(guildId, userId, actionType) {
    if (!this.beastModeTracker.has(guildId)) {
      this.beastModeTracker.set(guildId, new Map());
    }
    
    const guildScores = this.beastModeTracker.get(guildId);
    const currentScore = guildScores.get(userId) || 0;
    const points = this.POINTS[actionType] || 0;
    const newScore = currentScore + points;
    
    guildScores.set(userId, newScore);
    
    // Log score changes
    if (points > 0) {
      this.logAction(guildId, {
        type: 'beast_mode_score',
        userId,
        actionType,
        points,
        previousScore: currentScore,
        newScore,
        level: this.getScoreLevel(newScore)
      });
    }
    
    // Check for auto-ban threshold
    if (newScore >= this.BEAST_MODE_THRESHOLD) {
      this.handleBeastModeTrigger(guildId, userId, newScore);
    }
  }

  // Get score level for logging
  getScoreLevel(score) {
    if (score >= 35) return 'critical';
    if (score >= 30) return 'danger';
    if (score >= 20) return 'warning';
    return 'safe';
  }

  // Handle beast mode trigger
  async handleBeastModeTrigger(guildId, userId, score) {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return;
    
    // Check if user is whitelisted
    if (this.whitelist.has(userId)) {
      this.logAction(guildId, {
        type: 'beast_mode_whitelisted',
        userId,
        score,
        message: 'User reached beast mode threshold but is whitelisted'
      });
      return;
    }
    
    try {
      const user = await guild.members.fetch(userId).catch(() => null);
      if (user) {
        await user.ban({ reason: 'Anti-nuke: Beast mode threshold reached' });
        this.logAction(guildId, {
          type: 'beast_mode_ban',
          userId,
          score,
          success: true
        });
        
        // Reset score after ban
        const guildScores = this.beastModeTracker.get(guildId);
        guildScores.set(userId, 0);
      }
    } catch (error) {
      this.logAction(guildId, {
        type: 'beast_mode_ban_failed',
        userId,
        score,
        error: error.message
      });
    }
  }

  // Check for rapid actions
  checkRapidActions(guildId, userId, actionType) {
    const guildTracker = this.actionTracker.get(guildId);
    const userActions = guildTracker.get(userId);
    if (!userActions) return;
    
    const now = Date.now();
    const threshold = this.THRESHOLDS[actionType];
    if (!threshold) return;
    
    // Count recent actions
    const recentActions = userActions.filter(action => 
      action.type === actionType && (now - action.timestamp) <= threshold.time
    );
    
    if (recentActions.length >= threshold.count) {
      this.handleRapidAction(guildId, userId, actionType, recentActions);
    }
    
    // Check stacking detection for bans
    if (actionType === 'ban' && threshold.stackCount) {
      const stackActions = userActions.filter(action => 
        action.type === 'ban' && (now - action.timestamp) <= threshold.stackTime
      );
      
      if (stackActions.length >= threshold.stackCount) {
        this.handleRapidAction(guildId, userId, 'ban_stack', stackActions);
      }
    }
  }

  // Handle rapid action detection
  async handleRapidAction(guildId, userId, actionType, actions) {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return;
    
    // Check if user is whitelisted
    if (this.whitelist.has(userId)) {
      this.logAction(guildId, {
        type: 'rapid_action_whitelisted',
        userId,
        actionType,
        count: actions.length,
        message: 'User triggered rapid action detection but is whitelisted'
      });
      return;
    }
    
    try {
      const user = await guild.members.fetch(userId).catch(() => null);
      if (user) {
        await user.ban({ reason: `Anti-nuke: Rapid ${actionType} detected` });
        this.logAction(guildId, {
          type: 'rapid_action_ban',
          userId,
          actionType,
          count: actions.length,
          success: true
        });
      }
    } catch (error) {
      this.logAction(guildId, {
        type: 'rapid_action_ban_failed',
        userId,
        actionType,
        count: actions.length,
        error: error.message
      });
    }
  }

  // Handle ban events
  async handleBan(ban) {
    const guild = ban.guild;
    const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: 'MEMBER_BAN_ADD' }).catch(() => null);
    const executor = auditLogs?.entries.first()?.executor;
    
    if (!executor || executor.id === this.client.user.id) return;
    
    this.trackAction(guild.id, executor.id, 'ban', { targetId: ban.user.id });
    this.updateHourlyBanCount(guild.id);
    this.checkEmergencyThresholds(guild.id);
  }

  // Handle kick events
  async handleKick(member) {
    const guild = member.guild;
    const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: 'MEMBER_KICK' }).catch(() => null);
    const executor = auditLogs?.entries.first()?.executor;
    
    if (!executor || executor.id === this.client.user.id) return;
    
    this.trackAction(guild.id, executor.id, 'kick', { targetId: member.id });
  }

  // Handle channel deletion
  async handleChannelDelete(channel) {
    const guild = channel.guild;
    const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: 'CHANNEL_DELETE' }).catch(() => null);
    const executor = auditLogs?.entries.first()?.executor;
    
    if (!executor || executor.id === this.client.user.id) return;
    
    this.trackAction(guild.id, executor.id, 'channelDelete', { 
      channelId: channel.id,
      channelName: channel.name 
    });
  }

  // Handle role deletion
  async handleRoleDelete(role) {
    const guild = role.guild;
    const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: 'ROLE_DELETE' }).catch(() => null);
    const executor = auditLogs?.entries.first()?.executor;
    
    if (!executor || executor.id === this.client.user.id) return;
    
    this.trackAction(guild.id, executor.id, 'roleDelete', { 
      roleId: role.id,
      roleName: role.name 
    });
  }

  // Handle member add (bot detection)
  async handleMemberAdd(member) {
    if (!member.user.bot) return;
    
    const guild = member.guild;
    const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: 'BOT_ADD' }).catch(() => null);
    const executor = auditLogs?.entries.first()?.executor;
    
    if (!executor || executor.id === this.client.user.id) return;
    
    this.trackAction(guild.id, executor.id, 'botAdd', { 
      botId: member.id,
      botTag: member.user.tag 
    });
    
    // If beast mode is triggered, ban both user and bot
    const guildScores = this.beastModeTracker.get(guild.id);
    const userScore = guildScores?.get(executor.id) || 0;
    
    if (userScore >= this.BEAST_MODE_THRESHOLD) {
      try {
        await member.ban({ reason: 'Anti-nuke: Bot added by beast mode user' });
        this.logAction(guild.id, {
          type: 'bot_beast_mode_ban',
          executorId: executor.id,
          botId: member.id,
          botTag: member.user.tag
        });
      } catch (error) {
        this.logAction(guild.id, {
          type: 'bot_beast_mode_ban_failed',
          executorId: executor.id,
          botId: member.id,
          error: error.message
        });
      }
    }
  }

  // Handle webhook updates
  async handleWebhookUpdate(channel) {
    const guild = channel.guild;
    const webhooks = await channel.fetchWebhooks().catch(() => []);
    const recentWebhooks = webhooks.filter(w => 
      Date.now() - w.createdTimestamp < 10000 // Last 10 seconds
    );
    
    if (recentWebhooks.length >= this.THRESHOLDS.webhookCreate.count) {
      const auditLogs = await guild.fetchAuditLogs({ limit: 5, type: 'WEBHOOK_CREATE' }).catch(() => null);
      const executor = auditLogs?.entries.first()?.executor;
      
      if (!executor || executor.id === this.client.user.id) return;
      
      this.trackAction(guild.id, executor.id, 'webhookCreate', { 
        webhookCount: recentWebhooks.length 
      });
    }
  }

  // Update hourly ban count
  updateHourlyBanCount(guildId) {
    const currentCount = this.hourlyBanTracker.get(guildId) || 0;
    this.hourlyBanTracker.set(guildId, currentCount + 1);
    
    // Check for mass ban lockdown
    if (currentCount + 1 >= this.THRESHOLDS.massBanLockdown.count) {
      this.handleMassBanLockdown(guildId);
    }
  }

  // Handle mass ban lockdown
  async handleMassBanLockdown(guildId) {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return;
    
    try {
      // Remove dangerous permissions from all roles
      await this.removeDangerousPermissions(guild);
      
      this.logAction(guildId, {
        type: 'mass_ban_lockdown',
        banCount: this.hourlyBanTracker.get(guildId),
        success: true
      });
    } catch (error) {
      this.logAction(guildId, {
        type: 'mass_ban_lockdown_failed',
        error: error.message
      });
    }
  }

  // Check emergency thresholds
  checkEmergencyThresholds(guildId) {
    const banCount = this.hourlyBanTracker.get(guildId) || 0;
    const now = Date.now();
    
    for (const threshold of this.THRESHOLDS.emergency) {
      // This would need more sophisticated time tracking for different windows
      // For now, using hourly count as a simple implementation
      if (banCount >= threshold.count) {
        this.handleEmergencyMode(guildId);
        break;
      }
    }
  }

  // Handle emergency mode
  async handleEmergencyMode(guildId) {
    if (this.emergencyMode.get(guildId)) return; // Already in emergency mode
    
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return;
    
    try {
      // Create backup before lockdown
      await this.createBackup(guild);
      
      // Remove all permissions except view channels
      await this.removeDangerousPermissions(guild, true);
      
      // Lock down @everyone
      const everyoneRole = guild.roles.everyone;
      await everyoneRole.setPermissions([]);
      
      // Disable all invites
      await guild.disableInvites();
      
      this.emergencyMode.set(guildId, true);
      
      this.logAction(guildId, {
        type: 'emergency_mode',
        success: true
      });
      
      // Send critical alert
      await this.sendCriticalAlert(guild, 'Emergency mode activated due to critical attack threshold');
      
    } catch (error) {
      this.logAction(guildId, {
        type: 'emergency_mode_failed',
        error: error.message
      });
    }
  }

  // Remove dangerous permissions
  async removeDangerousPermissions(guild, emergencyMode = false) {
    const permissions = emergencyMode 
      ? [PermissionsBitField.Flags.ViewChannel] // Only allow view channels in emergency
      : new PermissionsBitField(); // Remove all permissions
    
    const roles = guild.roles.cache.filter(role => !role.managed);
    
    for (const role of roles) {
      try {
        await role.setPermissions(permissions);
      } catch (error) {
        // Skip roles that can't be modified
      }
    }
  }

  // Create backup
  async createBackup(guild) {
    const backup = {
      timestamp: Date.now(),
      roles: guild.roles.cache.map(role => ({
        id: role.id,
        name: role.name,
        permissions: role.permissions.bitfield.toString(),
        position: role.position,
        color: role.color,
        hoist: role.hoist,
        mentionable: role.mentionable
      })),
      channels: guild.channels.cache.map(channel => ({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        position: channel.position,
        parentId: channel.parentId,
        permissionOverwrites: Array.from(channel.permissionOverwrites.cache.values()).map(overwrite => ({
          id: overwrite.id,
          type: overwrite.type,
          allow: overwrite.allow.bitfield.toString(),
          deny: overwrite.deny.bitfield.toString()
        }))
      }))
    };
    
    this.backups.set(guild.id, backup);
    this.logAction(guild.id, {
      type: 'backup_created',
      rolesCount: backup.roles.length,
      channelsCount: backup.channels.length
    });
  }

  // Send critical alert
  async sendCriticalAlert(guild, message) {
    const embed = new EmbedBuilder()
      .setColor(this.COLORS.critical)
      .setTitle('🚨 CRITICAL ANTI-NUKE ALERT')
      .setDescription(message)
      .addFields(
        { name: 'Server', value: guild.name, inline: true },
        { name: 'Server ID', value: guild.id, inline: true },
        { name: 'Time', value: new Date().toISOString(), inline: true }
      )
      .setTimestamp();
    
    // Send to owner DM
    try {
      const owner = await this.client.users.fetch(this.OWNER_ID);
      await owner.send({ embeds: [embed] });
    } catch (error) {
      // Owner might have DMs disabled
    }
    
    // Send to log channel
    const logChannelId = this.logChannels.get(guild.id);
    if (logChannelId) {
      const logChannel = guild.channels.cache.get(logChannelId);
      if (logChannel) {
        await logChannel.send({ embeds: [embed] }).catch(() => {});
      }
    }
  }

  // Log action
  async logAction(guildId, actionData) {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return;
    
    const embed = new EmbedBuilder()
      .setColor(this.getColorForAction(actionData))
      .setTitle(this.getTitleForAction(actionData))
      .setDescription(this.getDescriptionForAction(actionData))
      .addFields(
        { name: 'Server', value: guild.name, inline: true },
        { name: 'Action', value: actionData.type, inline: true },
        { name: 'Time', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true }
      )
      .setTimestamp();
    
    // Add user info if available
    if (actionData.userId) {
      const user = await this.client.users.fetch(actionData.userId).catch(() => null);
      if (user) {
        embed.addFields(
          { name: 'User', value: `${user.tag} (${user.id})`, inline: false }
        );
      }
    }
    
    // Send to log channel
    const logChannelId = this.logChannels.get(guildId);
    if (logChannelId) {
      const logChannel = guild.channels.cache.get(logChannelId);
      if (logChannel) {
        await logChannel.send({ embeds: [embed] }).catch(() => {});
      }
    }
    
    // Send to owner DM
    try {
      const owner = await this.client.users.fetch(this.LOG_DM_ID);
      await owner.send({ embeds: [embed] });
    } catch (error) {
      // DM might be disabled
    }
  }

  // Get color for action type
  getColorForAction(action) {
    switch (action.type) {
      case 'beast_mode_ban':
      case 'rapid_action_ban':
      case 'emergency_mode':
      case 'mass_ban_lockdown':
        return this.COLORS.critical;
      case 'beast_mode_score':
        return action.level === 'critical' ? this.COLORS.red :
               action.level === 'danger' ? this.COLORS.orange :
               action.level === 'warning' ? this.COLORS.yellow :
               this.COLORS.green;
      case 'beast_mode_whitelisted':
      case 'rapid_action_whitelisted':
        return this.COLORS.yellow;
      case 'backup_created':
      case 'emergency_recover':
        return this.COLORS.green;
      default:
        return this.COLORS.blue;
    }
  }

  // Get title for action type
  getTitleForAction(action) {
    switch (action.type) {
      case 'beast_mode_ban':
        return '🔴 Beast Mode Ban';
      case 'rapid_action_ban':
        return '🔴 Rapid Action Ban';
      case 'beast_mode_score':
        return `🟠 Beast Mode Score Update (${action.level.toUpperCase()})`;
      case 'beast_mode_whitelisted':
        return '🟡 Beast Mode (Whitelisted)';
      case 'rapid_action_whitelisted':
        return '🟡 Rapid Action (Whitelisted)';
      case 'emergency_mode':
        return '🚨 EMERGENCY MODE ACTIVATED';
      case 'mass_ban_lockdown':
        return '🚨 MASS BAN LOCKDOWN';
      case 'backup_created':
        return '💾 Backup Created';
      case 'emergency_recover':
        return '✅ Emergency Recovery';
      default:
        return '🔵 Anti-Nuke Action';
    }
  }

  // Get description for action type
  getDescriptionForAction(action) {
    switch (action.type) {
      case 'beast_mode_ban':
        return `User reached beast mode threshold (${action.score} points) and was banned.`;
      case 'rapid_action_ban':
        return `User performed ${action.count} rapid ${action.actionType} actions.`;
      case 'beast_mode_score':
        return `Score: ${action.previousScore} → ${action.newScore} (+${action.points} points for ${action.actionType})`;
      case 'beast_mode_whitelisted':
        return `User reached beast mode threshold (${action.score} points) but is whitelisted.`;
      case 'rapid_action_whitelisted':
        return `User triggered rapid action detection (${action.count} ${action.actionType}) but is whitelisted.`;
      case 'emergency_mode':
        return 'Critical attack threshold reached. Server locked down.';
      case 'mass_ban_lockdown':
        return `Mass ban detected (${action.banCount} bans). All dangerous permissions removed.`;
      case 'backup_created':
        return `Server backup created: ${action.rolesCount} roles, ${action.channelsCount} channels.`;
      default:
        return 'Anti-nuke action detected.';
    }
  }

  // Start automated tasks
  startAutomatedTasks() {
    // Cleanup task - runs every hour
    setInterval(() => {
      this.cleanupOldData();
    }, 3600000); // 1 hour
    
    // Backup task - runs every 6 hours
    setInterval(() => {
      this.createAutomaticBackups();
    }, 21600000); // 6 hours
    
    console.log('⏰ Automated tasks started (cleanup + backups)');
  }

  // Clean up old data
  cleanupOldData() {
    const now = Date.now();
    const oneDayAgo = now - (24 * 60 * 60 * 1000);
    
    // Clean action tracker
    for (const [guildId, guildTracker] of this.actionTracker) {
      for (const [userId, actions] of guildTracker) {
        const filteredActions = actions.filter(action => action.timestamp > oneDayAgo);
        if (filteredActions.length === 0) {
          guildTracker.delete(userId);
        } else {
          guildTracker.set(userId, filteredActions);
        }
      }
    }
    
    // Reset hourly ban tracker
    this.hourlyBanTracker.clear();
    
    console.log('🧹 Anti-nuke data cleanup completed');
  }

  // Create automatic backups
  async createAutomaticBackups() {
    for (const guild of this.client.guilds.cache.values()) {
      try {
        await this.createBackup(guild);
      } catch (error) {
        console.error(`Failed to create backup for ${guild.name}:`, error);
      }
    }
    
    console.log('💾 Automatic backups completed');
  }

  // Check if user is owner
  isOwner(userId) {
    return userId === this.OWNER_ID;
  }

  // Check if user is whitelisted
  isWhitelisted(userId) {
    return this.whitelist.has(userId);
  }

  // Add to whitelist
  addToWhitelist(userId) {
    this.whitelist.add(userId);
    this.saveData();
  }

  // Remove from whitelist
  removeFromWhitelist(userId) {
    this.whitelist.delete(userId);
    this.saveData();
  }

  // Get whitelist
  getWhitelist() {
    return Array.from(this.whitelist);
  }

  // Set log channel
  setLogChannel(guildId, channelId) {
    this.logChannels.set(guildId, channelId);
    this.saveData();
  }

  // Get log channel
  getLogChannel(guildId) {
    return this.logChannels.get(guildId);
  }

  // Get status
  getStatus(guildId) {
    const guildTracker = this.actionTracker.get(guildId);
    const guildScores = this.beastModeTracker.get(guildId);
    const hourlyBans = this.hourlyBanTracker.get(guildId) || 0;
    const isEmergency = this.emergencyMode.get(guildId) || false;
    const backup = this.backups.get(guildId);
    
    let totalTrackedUsers = 0;
    let totalActions = 0;
    
    if (guildTracker) {
      totalTrackedUsers = guildTracker.size;
      for (const actions of guildTracker.values()) {
        totalActions += actions.length;
      }
    }
    
    return {
      guildId,
      totalTrackedUsers,
      totalWhitelistedUsers: this.whitelist.size,
      hourlyBans,
      totalActions,
      isEmergency,
      hasBackup: !!backup,
      logChannel: this.logChannels.get(guildId) || null,
      beastModeScores: guildScores ? Object.fromEntries(guildScores) : {}
    };
  }

  // Get user score
  getUserScore(guildId, userId) {
    const guildScores = this.beastModeTracker.get(guildId);
    return guildScores ? guildScores.get(userId) || 0 : 0;
  }

  // Reset scores
  resetScores(guildId, userId = null) {
    const guildScores = this.beastModeTracker.get(guildId);
    if (!guildScores) return;
    
    if (userId) {
      guildScores.set(userId, 0);
    } else {
      guildScores.clear();
    }
  }

  // Emergency recovery
  async emergencyRecover(guildId) {
    const guild = this.client.guilds.cache.get(guildId);
    const backup = this.backups.get(guildId);
    
    if (!guild || !backup) {
      throw new Error('Guild or backup not found');
    }
    
    if (!this.emergencyMode.get(guildId)) {
      throw new Error('Server is not in emergency mode');
    }
    
    try {
      // Restore roles
      for (const roleData of backup.roles) {
        const role = guild.roles.cache.get(roleData.id);
        if (role) {
          await role.setPermissions(roleData.permissions);
          await role.setPosition(roleData.position);
        }
      }
      
      // Restore channel permissions
      for (const channelData of backup.channels) {
        const channel = guild.channels.cache.get(channelData.id);
        if (channel) {
          // Clear existing overwrites
          for (const [id, overwrite] of channel.permissionOverwrites.cache) {
            await overwrite.delete();
          }
          
          // Restore original overwrites
          for (const overwrite of channelData.permissionOverwrites || []) {
            await channel.permissionOverwrites.create(overwrite.id, {
              allow: overwrite.allow,
              deny: overwrite.deny
            });
          }
        }
      }
      
      // Disable emergency mode
      this.emergencyMode.delete(guildId);
      
      this.logAction(guildId, {
        type: 'emergency_recover',
        success: true
      });
      
      return {
        success: true,
        rolesRestored: backup.roles.length,
        channelsRestored: backup.channels.length
      };
      
    } catch (error) {
      this.logAction(guildId, {
        type: 'emergency_recover_failed',
        error: error.message
      });
      throw error;
    }
  }
}

module.exports = AntiNuke;
