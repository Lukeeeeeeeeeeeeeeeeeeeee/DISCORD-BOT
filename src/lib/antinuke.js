const {
  EmbedBuilder,
  PermissionsBitField,
  AuditLogEvent,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ShardClientUtil
} = require('discord.js');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const runtime = require('./runtime');
const { buildErrorEmbed } = require('./embeds');
const { formatUtcDate } = require('./time');
const { withTransaction } = require('./transactions');

const antiNukeFileSaveQueuesByPath = new Map();

function enqueueStateFileSave(filePath, task) {
  const key = path.resolve(filePath);
  const previous = antiNukeFileSaveQueuesByPath.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(task);
  antiNukeFileSaveQueuesByPath.set(key, next);
  return next;
}

class AntiNuke {
  constructor() {
    // Configuration
    const ownerEnv = process.env.ANTINUKE_OWNER_ID || process.env.OWNER_ID;
    this.OWNER_ID = ownerEnv ? String(ownerEnv).trim() : null;
    if (!this.OWNER_ID) {
      console.warn('OWNER_ID is not configured; owner-only anti-nuke actions will be disabled.');
    }
    const logDmEnv = process.env.ANTINUKE_LOG_DM_ID || process.env.LOG_DM_ID || '';
    this.LOG_DM_ID = logDmEnv ? String(logDmEnv).trim() : null;
    this.LOG_DM_MODE = String(process.env.ANTINUKE_LOG_DM_MODE || 'off').toLowerCase();
    this.LOG_DM_INCLUDE_NON_CRITICAL = String(process.env.ANTINUKE_LOG_DM_INCLUDE_NON_CRITICAL || 'false').toLowerCase() === 'true';
    this.LOG_DM_INCLUDE_BACKUPS = String(process.env.ANTINUKE_LOG_DM_INCLUDE_BACKUPS || 'false').toLowerCase() === 'true';
    this.LOG_DM_DUPLICATE_WITH_CHANNEL = String(process.env.ANTINUKE_LOG_DM_DUPLICATE_WITH_CHANNEL || 'false').toLowerCase() === 'true';
    this.LOG_AUTOMATIC_BACKUPS = String(process.env.ANTINUKE_LOG_AUTOMATIC_BACKUPS || 'false').toLowerCase() === 'true';
    this.LOG_INCREMENTAL_BACKUPS = String(process.env.ANTINUKE_LOG_INCREMENTAL_BACKUPS || 'false').toLowerCase() === 'true';
    this.BACKUP_LOG_DEDUPE_WINDOW_MS = Number.parseInt(process.env.ANTINUKE_BACKUP_LOG_DEDUPE_WINDOW_MS || '180000', 10);
    this.BACKUP_INCREMENTAL_AFTER_FULL_SUPPRESS_MS = Number.parseInt(
      process.env.ANTINUKE_BACKUP_INCREMENTAL_AFTER_FULL_SUPPRESS_MS || '900000',
      10
    );
    if ((this.LOG_DM_MODE === 'critical' || this.LOG_DM_MODE === 'all') && !this.LOG_DM_ID) {
      console.warn('ANTINUKE_LOG_DM_MODE is enabled but ANTINUKE_LOG_DM_ID is not set; anti-nuke DM alerts are disabled.');
    }

    // Protection thresholds (base values; per-guild scaling is applied at runtime)
    this.THRESHOLDS = {
      ban: { count: 3, time: 2500, stackCount: 6, stackTime: 2500 },
      kick: { count: 3, time: 2500 },
      channelDelete: { count: 3, time: 2500 },
      roleDelete: { count: 2, time: 4000 },
      webhookCreate: { count: 4, time: 10000 },
      joinRaid: { count: 12, time: 15000 },
      emergency: [
        { count: 8, time: 10000 },
        { count: 16, time: 30000 },
        { count: 25, time: 300000 },
        { count: 40, time: 600000 },
        { count: 60, time: 1800000 },
        { count: 80, time: 3600000 }
      ],
      massBanLockdown: { count: 80, time: 3600000 }
    };
    // Scale thresholds up for larger servers to keep fairness while staying strict on smaller servers.
    this.THRESHOLD_SCALES = [
      { minMembers: 15000, scale: 1.5 },
      { minMembers: 8000, scale: 1.35 },
      { minMembers: 3000, scale: 1.2 },
      { minMembers: 1000, scale: 1.1 }
    ];

    // Beast mode settings
    this.BEAST_MODE_THRESHOLD = 40;
    this.BEAST_MODE_WARN = 20;
    this.BEAST_MODE_DANGER = 30;
    this.BEAST_MODE_WINDOW = 24 * 60 * 60 * 1000;
    this.BAN_WINDOW = 60 * 60 * 1000;
    this.BAN_DAY_WINDOW = 24 * 60 * 60 * 1000;
    this.WEBHOOK_DEDUPE_WINDOW = 60 * 60 * 1000;
    this.AUDIT_ACTION_DEDUPE_WINDOW = 10 * 60 * 1000;
    this.AUDIT_LOG_FETCH_LIMIT = 6;
    this.AUDIT_LOG_MAX_FETCH_LIMIT = 60;
    this.PENDING_WHITELIST_TTL = 12 * 60 * 60 * 1000;
    this.WHITELIST_APPROVALS_REQUIRED = 3;
    this.MASS_BAN_COOLDOWN = 30 * 60 * 1000;
    this.AUTO_ACTION_THRESHOLD = 0.8;
    this.AGGRESSIVE_ACTION_THRESHOLD = 0.5;
    this.AUTO_STRICT_DURATION = 30 * 60 * 1000;
    this.QUARANTINE_DURATION = 24 * 60 * 60 * 1000;
    this.BACKUP_RETENTION_FULL = 7;
    this.BACKUP_RETENTION_INCREMENTAL = 30;
    this.LOG_HISTORY_LIMIT = 200;
    this.EMERGENCY_CONFIRM_WINDOW = 30 * 1000;
    this.EMERGENCY_LOCKDOWN_DURATION = 12 * 60 * 60 * 1000;
    const rawEncryptionKey = process.env.ANTINUKE_ENCRYPTION_KEY;
    this.ENCRYPTION_KEY = rawEncryptionKey ? String(rawEncryptionKey).trim() : null;
    const allowUnencryptedEnv = process.env.ANTINUKE_ALLOW_UNENCRYPTED_BACKUPS;
    this.ALLOW_UNENCRYPTED_BACKUPS = allowUnencryptedEnv
      ? allowUnencryptedEnv.toLowerCase() === 'true'
      : false;
    const requireEncEnv = process.env.ANTINUKE_REQUIRE_ENCRYPTION;
    this.REQUIRE_BACKUP_ENCRYPTION = requireEncEnv
      ? requireEncEnv.toLowerCase() === 'true'
      : true;
    if (!this.ENCRYPTION_KEY) {
      if (this.REQUIRE_BACKUP_ENCRYPTION || !this.ALLOW_UNENCRYPTED_BACKUPS) {
        console.warn('ANTINUKE_ENCRYPTION_KEY is missing; backups are blocked until a key is configured.');
      } else {
        console.warn('ANTINUKE_ENCRYPTION_KEY is missing; backups will be stored unencrypted because ANTINUKE_ALLOW_UNENCRYPTED_BACKUPS=true.');
      }
    }
    this.POINTS = {
      ban: 20,
      botAdd: 20,
      kick: 10,
      channelDelete: 10,
      roleDelete: 15,
      webhookCreate: 5,
      prune: 30
    };
    this.DEFAULT_CONFIG = {
      strictMode: false,
      aggressiveBan: false,
      autoStrictUntil: 0,
      strictForce: false,
      emergencyForceProtect: false,
      pruneInstantBan: true,
      pruneThreshold: 1,
      autoActionThreshold: this.AUTO_ACTION_THRESHOLD,
      quarantine: {
        mode: 'quarantine',
        preserveView: false,
        durationMs: this.QUARANTINE_DURATION
      }
    };

    // Data storage
    this.actionTracker = new Map(); // guildId -> Map<userId, actions[]>
    this.beastModeActions = new Map(); // guildId -> Map<userId, { actions: [], lastLevel: string }>
    this.beastModeTracker = new Map(); // guildId -> Map<userId, score>
    this.banTracker = new Map(); // guildId -> [timestamps]
    this.joinTracker = new Map(); // guildId -> [timestamps]
    this.emergencyMode = new Map(); // guildId -> boolean
    this.emergencyLockdownUntil = new Map(); // guildId -> timestamp
    this.whitelist = new Set(); // legacy global userIds
    this.whitelistByGuild = new Map(); // guildId -> Set<userId>
    this.logChannels = new Map(); // guildId -> channelId
    this.backups = new Map(); // guildId -> backup data
    this.webhookAuditTracker = new Map(); // guildId -> Map<logId, timestamp>
    this.auditActionTracker = new Map(); // guildId -> Map<auditLogId, timestamp>
    this.pruneTracker = new Map(); // guildId -> last prune log id
    this.pendingWhitelist = new Map(); // guildId -> Map<userId, { approvers: Set, createdAt: number, requestedBy: string }>
    this.lastMassBanLockdown = new Map(); // guildId -> timestamp
    this.guildConfig = new Map(); // guildId -> config
    this.logHistory = new Map(); // guildId -> log entries
    this.quarantineAssignments = new Map(); // guildId -> Map<userId, { roles, expiresAt, quarantineRoleId }>
    this.recoveryMappings = new Map(); // guildId -> { channels: Map<oldId, newId>, roles: Map<oldId, newId> }
    this.pendingEmergencyConfirmations = new Map(); // guildId -> { pending, expiresAt }
    this.rapidActionTimers = new Map(); // key -> timeout
    this.lastBackupNotification = new Map(); // guildId -> { timestamp: number, type: string }
    this.lastFullBackupAt = new Map(); // guildId -> timestamp

    // File paths:
    // - default runtime state is stored in a local, non-repo file
    // - repo file remains a seed/fallback to avoid merge conflicts on pull
    // - test/smoke scripts can still override via ANTINUKE_DATA_FILE
    const overrideDataFile = process.env.ANTINUKE_DATA_FILE;
    const repoDataFile = path.join(__dirname, '../data/antinuke_data.json');
    const localDataFile = path.join(__dirname, '../data/antinuke_data.local.json');
    this.DATA_FILE = overrideDataFile ? path.resolve(overrideDataFile) : localDataFile;
    this.DATA_FILE_TMP = `${this.DATA_FILE}.tmp`;
    this.FALLBACK_DATA_FILE = overrideDataFile ? null : repoDataFile;
    this.stateBackend = 'file';
    this.lastGlobalStateUpdatedAt = 0;

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
    const dangerousPermissionNames = new Set([
      'Administrator',
      'ManageGuild',
      'ManageRoles',
      'ManageChannels',
      'BanMembers',
      'KickMembers',
      'ModerateMembers',
      'ManageMessages',
      'MentionEveryone',
      'ManageWebhooks',
      'ManageEmojisAndStickers',
      'ManageGuildExpressions',
      'ManageThreads',
      'CreateInstantInvite',
      'ManageNicknames',
      'MuteMembers',
      'DeafenMembers',
      'MoveMembers',
      'ManageEvents'
    ]);
    for (const name of Object.keys(PermissionsBitField.Flags)) {
      if (name.startsWith('Manage')
        || name === 'Administrator'
        || name === 'BanMembers'
        || name === 'KickMembers'
        || name === 'ModerateMembers'
        || name === 'MentionEveryone'
        || name === 'CreateInstantInvite'
        || name === 'MoveMembers'
        || name === 'DeafenMembers'
        || name === 'MuteMembers') {
        dangerousPermissionNames.add(name);
      }
    }
    this.DANGEROUS_PERMISSIONS = Array.from(dangerousPermissionNames)
      .map(name => PermissionsBitField.Flags[name])
      .filter(Boolean);
  }

  async handleAuditLogEntry(entry, guild) {
    if (!entry || !guild) return;
    if (entry.action === AuditLogEvent.MemberPrune) {
      await this.handleMemberPrune(entry, guild);
      return;
    }
    if (entry.action === AuditLogEvent.MemberBanAdd) {
      await this.handleMemberBanAudit(entry, guild);
      return;
    }
    if (entry.action === AuditLogEvent.MemberKick) {
      await this.handleMemberKickAudit(entry, guild);
    }
  }

  async handleMemberBanAudit(entry, guild) {
    if (!entry || !guild || !entry.executor || entry.executor.id === this.client.user.id) return;
    if (!this.recordProcessedAuditAction(guild.id, entry.id)) return;
    const eventTime = typeof entry.createdTimestamp === 'number' ? entry.createdTimestamp : Date.now();
    const targetId = this.getAuditTargetId(entry);
    this.trackAction(guild.id, entry.executor.id, 'ban', {
      targetId: targetId || null,
      auditLogId: entry.id || null,
      traceId: this.createTraceId(),
      timestamp: eventTime
    });
    const banTimestamps = this.recordBan(guild.id, eventTime);
    this.checkMassBanLockdown(guild.id, banTimestamps, eventTime);
    this.checkEmergencyThresholds(guild.id, banTimestamps, eventTime);
  }

  async handleMemberKickAudit(entry, guild) {
    if (!entry || !guild || !entry.executor || entry.executor.id === this.client.user.id) return;
    if (!this.recordProcessedAuditAction(guild.id, entry.id)) return;
    const eventTime = typeof entry.createdTimestamp === 'number' ? entry.createdTimestamp : Date.now();
    const targetId = this.getAuditTargetId(entry);
    this.trackAction(guild.id, entry.executor.id, 'kick', {
      targetId: targetId || null,
      auditLogId: entry.id || null,
      traceId: this.createTraceId(),
      timestamp: eventTime
    });
  }

  async handleMemberPrune(entry, guild) {
    if (!entry.executor || entry.executor.id === this.client.user.id) return;
    const lastPruneId = this.pruneTracker.get(guild.id);
    if (lastPruneId === entry.id) return;
    this.pruneTracker.set(guild.id, entry.id);

    const eventTime = Date.now();
    const executorId = entry.executor.id;
    const removed = entry.extra?.removed || null;
    const traceId = this.createTraceId();
    this.trackAction(guild.id, executorId, 'prune', {
      removed,
      auditLogId: entry.id,
      traceId,
      timestamp: eventTime
    });

    const config = this.getGuildConfig(guild.id);
    const whitelisted = this.isProtectedUser(executorId, guild.id);
    const bypassWhitelist = this.isWhitelistBypassAllowed(guild.id, executorId);
    if (whitelisted && !bypassWhitelist) {
      this.logAction(guild.id, {
        type: 'prune_whitelisted',
        userId: executorId,
        removed,
        whitelisted: true,
        traceId,
        actionTaken: 'none',
        result: 'whitelist_exempt'
      });
      return;
    }
    const member = await guild.members.fetch(executorId).catch(err => {
      console.error('Failed to fetch executor member:', err);
      return null;
    });
    if (!member) {
      this.logAction(guild.id, {
        type: 'prune_ban_failed',
        userId: executorId,
        removed,
        traceId,
        error: 'Member not found'
      });
      return;
    }

    const canAct = this.canActOnMember(guild, member);
    if (!canAct.allowed) {
      this.logAction(guild.id, {
        type: 'prune_ban_failed',
        userId: executorId,
        removed,
        traceId,
        actionTaken: 'none',
        result: canAct.reason
      });
      return;
    }

    if (config.strictActive || config.pruneInstantBan) {
      await this.performProtectiveAction(guild, member, {
        reason: 'Anti-nuke: Member prune detected (strict)',
        actionType: 'prune',
        actionLabel: 'Member Prune',
        traceId,
        forceBan: config.pruneInstantBan,
        whitelisted,
        successType: 'prune_ban',
        failType: 'prune_ban_failed'
      });
      return;
    }

    const threshold = config.pruneThreshold || 1;
    if (removed && removed < threshold) {
      this.logAction(guild.id, {
        type: 'prune_ban_failed',
        userId: executorId,
        removed,
        traceId,
        actionTaken: 'none',
        result: 'below_threshold'
      });
      return;
    }

    await this.performProtectiveAction(guild, member, {
      reason: 'Anti-nuke: Member prune detected',
      actionType: 'prune',
      actionLabel: 'Member Prune',
      traceId,
      whitelisted,
    });
  }

  // Initialize the anti-nuke system
  async init(client) {
    this.client = client;
    this.stateBackend = this.resolveStateBackend();

    // Load data from persistent storage
    await this.loadData();

    // Start automated tasks
    this.startAutomatedTasks();

    // Set up event listeners
    this.setupEventListeners();

    console.log('🛡️ Anti-nuke system initialized with 45+ protection features');
  }

  resolveStateBackend() {
    const override = (process.env.ANTINUKE_STATE_BACKEND || '').toLowerCase();
    if (override === 'db' || override === 'database' || override === 'sqlite') return 'db';
    if (override === 'file' || override === 'json') return 'file';
    if (this.client && this.client.shard) return 'db';
    return 'file';
  }

  getStateDb() {
    const db = runtime.getDb && runtime.getDb();
    if (!db || typeof db.get !== 'function' || typeof db.all !== 'function' || typeof db.run !== 'function') {
      return null;
    }
    return db;
  }

  ownsGuildId(guildId) {
    if (!guildId) return false;
    const shard = this.client && this.client.shard ? this.client.shard : null;
    if (!shard || !Array.isArray(shard.ids) || typeof shard.count !== 'number') return true;
    try {
      const shardId = ShardClientUtil.shardIdForGuildId(guildId, shard.count);
      return shard.ids.includes(shardId);
    } catch (e) {
      return true;
    }
  }

  collectGuildIds() {
    const ids = new Set();
    const stores = [
      this.logChannels,
      this.beastModeActions,
      this.beastModeTracker,
      this.whitelistByGuild,
      this.pendingWhitelist,
      this.backups,
      this.guildConfig,
      this.quarantineAssignments,
      this.recoveryMappings,
      this.emergencyLockdownUntil,
      this.emergencyMode
    ];
    for (const store of stores) {
      if (!store || typeof store.keys !== 'function') continue;
      for (const guildId of store.keys()) ids.add(guildId);
    }
    if (this.client && this.client.guilds && this.client.guilds.cache) {
      for (const guildId of this.client.guilds.cache.keys()) ids.add(guildId);
    }
    return ids;
  }

  async ensureStateTable(db) {
    if (!db || typeof db.exec !== 'function') return;
    try {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS antinuke_state (
          key TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    } catch (e) {
      console.error('Failed to ensure antinuke_state table:', e);
    }
  }

  serializeGuildState(guildId) {
    if (!guildId) return null;
    const state = {};

    const logChannel = this.logChannels.get(guildId);
    if (logChannel) state.logChannel = logChannel;

    const actionMap = this.beastModeActions.get(guildId);
    if (actionMap && actionMap.size) {
      const actions = {};
      for (const [userId, entry] of actionMap.entries()) {
        actions[userId] = {
          actions: Array.isArray(entry.actions) ? entry.actions : [],
          lastLevel: entry.lastLevel || null
        };
      }
      state.beastModeActions = actions;
    }

    const tracker = this.beastModeTracker.get(guildId);
    if (tracker && tracker.size) {
      state.beastModeTracker = Object.fromEntries(tracker);
    }

    const guildWhitelist = this.whitelistByGuild.get(guildId);
    if (guildWhitelist && guildWhitelist.size) {
      state.whitelist = Array.from(guildWhitelist);
    }

    const pending = this.pendingWhitelist.get(guildId);
    if (pending && pending.size) {
      const pendingState = {};
      for (const [userId, entry] of pending.entries()) {
        pendingState[userId] = {
          approvers: Array.from(entry.approvers || []),
          createdAt: entry.createdAt,
          requestedBy: entry.requestedBy || null
        };
      }
      state.pendingWhitelist = pendingState;
    }

    const quarantine = this.quarantineAssignments.get(guildId);
    if (quarantine && quarantine.size) {
      const assignments = {};
      for (const [userId, entry] of quarantine.entries()) {
        assignments[userId] = {
          roles: Array.isArray(entry.roles) ? entry.roles : [],
          expiresAt: entry.expiresAt || 0,
          quarantineRoleId: entry.quarantineRoleId || null
        };
      }
      state.quarantineAssignments = assignments;
    }

    const backups = this.backups.get(guildId);
    if (backups) {
      state.backups = this.normalizeBackupStore(backups, guildId);
    }

    const config = this.guildConfig.get(guildId);
    if (config) {
      state.guildConfig = config;
    }

    const recovery = this.recoveryMappings.get(guildId);
    if (recovery) {
      const channels = recovery.channels ? Object.fromEntries(recovery.channels) : {};
      const roles = recovery.roles ? Object.fromEntries(recovery.roles) : {};
      state.recoveryMappings = { channels, roles };
    }

    if (this.emergencyLockdownUntil.has(guildId)) {
      state.emergencyLockdownUntil = this.emergencyLockdownUntil.get(guildId);
    }
    if (this.emergencyMode.has(guildId)) {
      state.emergencyMode = this.emergencyMode.get(guildId);
    }

    return state;
  }

  applyGuildState(guildId, state) {
    if (!guildId || !state || typeof state !== 'object') return;

    if (state.logChannel) this.logChannels.set(guildId, state.logChannel);

    if (state.beastModeActions) {
      const userEntries = Object.entries(state.beastModeActions).map(([userId, entry]) => {
        const actions = Array.isArray(entry.actions) ? entry.actions : [];
        const lastLevel = entry.lastLevel || null;
        return [userId, { actions, lastLevel }];
      });
      this.beastModeActions.set(guildId, new Map(userEntries));
    }

    if (state.beastModeTracker) {
      const trackerEntries = Object.entries(state.beastModeTracker).map(([userId, score]) => [userId, Number(score) || 0]);
      this.beastModeTracker.set(guildId, new Map(trackerEntries));
    }

    if (Array.isArray(state.whitelist)) {
      this.whitelistByGuild.set(guildId, new Set(state.whitelist.map(v => String(v))));
    }

    if (state.pendingWhitelist) {
      const pendingEntries = Object.entries(state.pendingWhitelist).map(([userId, entry]) => {
        const approvers = Array.isArray(entry.approvers) ? entry.approvers : [];
        return [userId, {
          approvers: new Set(approvers),
          createdAt: entry.createdAt || Date.now(),
          requestedBy: entry.requestedBy || null
        }];
      });
      this.pendingWhitelist.set(guildId, new Map(pendingEntries));
    }

    if (state.quarantineAssignments) {
      const assignmentEntries = Object.entries(state.quarantineAssignments).map(([userId, entry]) => [userId, {
        roles: Array.isArray(entry.roles) ? entry.roles : [],
        expiresAt: entry.expiresAt || 0,
        quarantineRoleId: entry.quarantineRoleId || null
      }]);
      this.quarantineAssignments.set(guildId, new Map(assignmentEntries));
    }

    if (state.backups) {
      this.backups.set(guildId, this.normalizeBackupStore(state.backups, guildId));
    }

    if (state.guildConfig) {
      this.guildConfig.set(guildId, state.guildConfig);
    }

    if (state.recoveryMappings) {
      const entry = state.recoveryMappings && typeof state.recoveryMappings === 'object' ? state.recoveryMappings : {};
      const channels = new Map(Object.entries(entry.channels || {}));
      const roles = new Map(Object.entries(entry.roles || {}));
      this.recoveryMappings.set(guildId, { channels, roles });
    }

    if (state.emergencyLockdownUntil !== undefined) {
      this.emergencyLockdownUntil.set(guildId, Number(state.emergencyLockdownUntil) || 0);
    }
    if (state.emergencyMode !== undefined) {
      this.emergencyMode.set(guildId, !!state.emergencyMode);
    }
  }

  async loadDataFromDb(db) {
    if (!db) return false;
    try {
      await this.ensureStateTable(db);
      const rows = await db.all('SELECT key, payload, updated_at FROM antinuke_state');
      if (!rows || rows.length === 0) return false;

      for (const row of rows) {
        if (!row || !row.key || !row.payload) continue;
        let payload;
        try {
          payload = JSON.parse(row.payload);
        } catch (e) {
          console.error('Failed to parse antinuke_state payload', { key: row.key, error: e });
          continue;
        }

        if (row.key === 'global') {
          if (payload && Array.isArray(payload.whitelist)) {
            this.whitelist = new Set(payload.whitelist);
          }
          if (row.updated_at) {
            this.lastGlobalStateUpdatedAt = Math.max(this.lastGlobalStateUpdatedAt, Number(row.updated_at) || 0);
          }
          continue;
        }

        if (row.key.startsWith('guild:')) {
          const guildId = row.key.slice(6);
          this.applyGuildState(guildId, payload);
        }
      }

      console.log('Anti-nuke data loaded from shared DB store');
      return true;
    } catch (error) {
      console.error('Failed to load anti-nuke data from DB:', error);
      return false;
    }
  }

  async saveDataToDb(db) {
    if (!db) return;
    const now = Date.now();
    const guildIds = Array.from(this.collectGuildIds()).filter(id => this.ownsGuildId(id));

    try {
      await this.ensureStateTable(db);
      await withTransaction(db, async (tx) => {
        const globalPayload = JSON.stringify({ whitelist: Array.from(this.getAllWhitelistedUsers()) });
        await tx.run(
          `INSERT INTO antinuke_state (key, payload, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
          'global',
          globalPayload,
          now
        );

        for (const guildId of guildIds) {
          const payload = JSON.stringify(this.serializeGuildState(guildId) || {});
          const key = `guild:${guildId}`;
          await tx.run(
            `INSERT INTO antinuke_state (key, payload, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
            key,
            payload,
            now
          );
        }
      });
      this.lastGlobalStateUpdatedAt = now;
    } catch (error) {
      console.error('Failed to save anti-nuke data to DB:', error);
    }
  }

  // Load persistent data
  async loadData() {
    const db = this.stateBackend === 'db' ? this.getStateDb() : null;
    if (db && this.stateBackend === 'db') {
      const loaded = await this.loadDataFromDb(db);
      if (loaded) return;
    }
    await this.loadDataFromFile();
    if (db && this.stateBackend === 'db') {
      await this.saveDataToDb(db);
    }
  }

  getDataFileCandidates() {
    const candidates = [this.DATA_FILE, this.DATA_FILE_TMP, this.FALLBACK_DATA_FILE]
      .filter(Boolean)
      .map(filePath => path.resolve(filePath));
    return Array.from(new Set(candidates));
  }

  async writeStateFileAtomic(payload) {
    const tempPath = this.DATA_FILE_TMP;
    const handle = await fs.open(tempPath, 'w');
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
    await fs.rename(tempPath, this.DATA_FILE);

    // Best-effort directory sync for crash consistency on platforms that support it.
    try {
      const dirHandle = await fs.open(path.dirname(this.DATA_FILE), 'r');
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close().catch(() => {});
      }
    } catch (_error) {
      // ignored
    }
  }

  async loadDataFromFile() {
    try {
      let parsed = null;
      let loadedFrom = null;
      let lastError = null;
      const candidates = this.getDataFileCandidates();

      for (const candidate of candidates) {
        try {
          const data = await fs.readFile(candidate, 'utf8');
          parsed = JSON.parse(data);
          loadedFrom = candidate;
          break;
        } catch (error) {
          lastError = error;
        }
      }

      if (!parsed || !loadedFrom) {
        throw lastError || new Error('No anti-nuke data file could be loaded');
      }

      if (parsed.whitelist) this.whitelist = new Set(parsed.whitelist);
      if (parsed.whitelistByGuild) {
        this.whitelistByGuild = new Map(Object.entries(parsed.whitelistByGuild).map(([guildId, userIds]) => {
          const list = Array.isArray(userIds) ? userIds.map(v => String(v)) : [];
          return [guildId, new Set(list)];
        }));
      }
      if (parsed.logChannels) this.logChannels = new Map(Object.entries(parsed.logChannels));

      if (parsed.beastModeActions) {
        const guildEntries = Object.entries(parsed.beastModeActions);
        this.beastModeActions = new Map(guildEntries.map(([guildId, users]) => {
          const userEntries = Object.entries(users || {}).map(([userId, entry]) => {
            const actions = Array.isArray(entry.actions) ? entry.actions : [];
            const lastLevel = entry.lastLevel || null;
            return [userId, { actions, lastLevel }];
          });
          return [guildId, new Map(userEntries)];
        }));
      }

      if (parsed.quarantineAssignments) {
        const guildEntries = Object.entries(parsed.quarantineAssignments);
        this.quarantineAssignments = new Map(guildEntries.map(([guildId, users]) => {
          const userEntries = Object.entries(users || {}).map(([userId, entry]) => [userId, {
            roles: Array.isArray(entry.roles) ? entry.roles : [],
            expiresAt: entry.expiresAt || 0,
            quarantineRoleId: entry.quarantineRoleId || null
          }]);
          return [guildId, new Map(userEntries)];
        }));
      }

      if (parsed.backups) {
        this.backups = new Map(Object.entries(parsed.backups).map(([guildId, store]) => (
          [guildId, this.normalizeBackupStore(store, guildId)]
        )));
      }

      if (parsed.guildConfig) {
        this.guildConfig = new Map(Object.entries(parsed.guildConfig));
      }

      if (parsed.emergencyLockdownUntil) {
        this.emergencyLockdownUntil = new Map(Object.entries(parsed.emergencyLockdownUntil).map(([guildId, value]) => (
          [guildId, Number(value) || 0]
        )));
      }

      if (parsed.beastModeTracker) {
        const guildEntries = Object.entries(parsed.beastModeTracker);
        this.beastModeTracker = new Map(guildEntries.map(([guildId, users]) => {
          const userEntries = Object.entries(users || {}).map(([userId, score]) => [userId, Number(score) || 0]);
          return [guildId, new Map(userEntries)];
        }));
      }

      if (parsed.pendingWhitelist) {
        const guildEntries = Object.entries(parsed.pendingWhitelist);
        this.pendingWhitelist = new Map(guildEntries.map(([guildId, users]) => {
          const userEntries = Object.entries(users || {}).map(([userId, entry]) => {
            const approvers = Array.isArray(entry.approvers) ? entry.approvers : [];
            return [userId, {
              approvers: new Set(approvers),
              createdAt: entry.createdAt || Date.now(),
              requestedBy: entry.requestedBy || null
            }];
          });
          return [guildId, new Map(userEntries)];
        }));
      }

      if (parsed.emergencyMode) {
        this.emergencyMode = new Map(Object.entries(parsed.emergencyMode).map(([guildId, value]) => (
          [guildId, !!value]
        )));
      }

      if (parsed.recoveryMappings) {
        this.recoveryMappings = new Map(Object.entries(parsed.recoveryMappings).map(([guildId, entry]) => {
          const safeEntry = entry && typeof entry === 'object' ? entry : {};
          const channels = new Map(Object.entries(safeEntry.channels || {}));
          const roles = new Map(Object.entries(safeEntry.roles || {}));
          return [guildId, { channels, roles }];
        }));
      }

      console.log(`Anti-nuke data loaded from file: ${path.basename(loadedFrom)}`);
      if (loadedFrom !== this.DATA_FILE) {
        try {
          await this.saveDataToFile();
          console.log(`Anti-nuke data migrated to local state file: ${path.basename(this.DATA_FILE)}`);
        } catch (migrateError) {
          console.error('Failed to migrate anti-nuke state file:', migrateError);
        }
      }
    } catch (error) {
      console.log('No existing anti-nuke data found, starting fresh');
    }
  }

  // Save persistent data
  async saveData() {
    const db = this.stateBackend === 'db' ? this.getStateDb() : null;
    if (db && this.stateBackend === 'db') {
      await this.saveDataToDb(db);
      return;
    }
    await this.saveDataToFile();
  }

  async saveDataToFile() {
    return enqueueStateFileSave(this.DATA_FILE, async () => {
      try {
        await fs.mkdir(path.dirname(this.DATA_FILE), { recursive: true });
      } catch (e) {
        void e;
      }

      const beastModeActions = {};
      for (const [guildId, userMap] of this.beastModeActions.entries()) {
        beastModeActions[guildId] = {};
        for (const [userId, entry] of userMap.entries()) {
          beastModeActions[guildId][userId] = {
            actions: Array.isArray(entry.actions) ? entry.actions : [],
            lastLevel: entry.lastLevel || null
          };
        }
      }

      const beastModeTracker = {};
      for (const [guildId, userMap] of this.beastModeTracker.entries()) {
        beastModeTracker[guildId] = Object.fromEntries(userMap);
      }

      const pendingWhitelist = {};
      for (const [guildId, userMap] of this.pendingWhitelist.entries()) {
        pendingWhitelist[guildId] = {};
        for (const [userId, entry] of userMap.entries()) {
          pendingWhitelist[guildId][userId] = {
            approvers: Array.from(entry.approvers || []),
            createdAt: entry.createdAt,
            requestedBy: entry.requestedBy || null
          };
        }
      }

      const whitelistByGuild = {};
      for (const [guildId, userSet] of this.whitelistByGuild.entries()) {
        whitelistByGuild[guildId] = Array.from(userSet || []);
      }

      const quarantineAssignments = {};
      for (const [guildId, userMap] of this.quarantineAssignments.entries()) {
        quarantineAssignments[guildId] = {};
        for (const [userId, entry] of userMap.entries()) {
          quarantineAssignments[guildId][userId] = {
            roles: Array.isArray(entry.roles) ? entry.roles : [],
            expiresAt: entry.expiresAt || 0,
            quarantineRoleId: entry.quarantineRoleId || null
          };
        }
      }

      const recoveryMappings = {};
      for (const [guildId, mapping] of this.recoveryMappings.entries()) {
        const channels = mapping && mapping.channels ? Object.fromEntries(mapping.channels) : {};
        const roles = mapping && mapping.roles ? Object.fromEntries(mapping.roles) : {};
        recoveryMappings[guildId] = { channels, roles };
      }

      const data = {
        whitelist: Array.from(this.getAllWhitelistedUsers()),
        whitelistByGuild,
        logChannels: Object.fromEntries(this.logChannels),
        beastModeActions,
        beastModeTracker,
        pendingWhitelist,
        backups: Object.fromEntries(this.backups),
        guildConfig: Object.fromEntries(this.guildConfig),
        quarantineAssignments,
        recoveryMappings,
        emergencyLockdownUntil: Object.fromEntries(this.emergencyLockdownUntil),
        emergencyMode: Object.fromEntries(this.emergencyMode)
      };
      await this.writeStateFileAtomic(JSON.stringify(data, null, 2));
    }).catch((error) => {
      console.error('Failed to save anti-nuke data:', error);
    });
  }

  // Set up event listeners
  setupEventListeners() {
    this.client.on('guildBanAdd', (ban) => this.handleBan(ban));
    this.client.on('guildMemberRemove', (member) => this.handleKick(member));
    this.client.on('channelDelete', (channel) => this.handleChannelDelete(channel));
    this.client.on('roleDelete', (role) => this.handleRoleDelete(role));
    this.client.on('guildMemberAdd', (member) => this.handleMemberAdd(member));
    this.client.on('webhooksUpdate', (channel) => this.handleWebhookUpdate(channel));
    this.client.on('guildAuditLogEntryCreate', (entry, guild) => this.handleAuditLogEntry(entry, guild));
  }

  getGuildMap(store, guildId) {
    if (!store.has(guildId)) {
      store.set(guildId, new Map());
    }
    return store.get(guildId);
  }

  getGuildList(store, guildId) {
    if (!store.has(guildId)) {
      store.set(guildId, []);
    }
    return store.get(guildId);
  }

  async resolveLogChannel(guild) {
    if (!guild || !guild.id) return null;
    const logChannelId = this.logChannels.get(guild.id);
    if (!logChannelId) return null;
    let channel = guild.channels && guild.channels.cache
      ? guild.channels.cache.get(logChannelId)
      : null;
    if (!channel && guild.channels && typeof guild.channels.fetch === 'function') {
      channel = await guild.channels.fetch(logChannelId).catch(() => null);
    }
    if (!channel || typeof channel.send !== 'function') return null;
    return channel;
  }

  getRecoveryMapping(guildId) {
    if (!this.recoveryMappings.has(guildId)) {
      this.recoveryMappings.set(guildId, { channels: new Map(), roles: new Map() });
    }
    const entry = this.recoveryMappings.get(guildId);
    if (!entry.channels) entry.channels = new Map();
    if (!entry.roles) entry.roles = new Map();
    return entry;
  }

  getWindowCount(timestamps, windowMs, now = Date.now()) {
    if (!Array.isArray(timestamps) || timestamps.length === 0) return 0;
    const cutoff = now - windowMs;
    let count = 0;
    for (let i = timestamps.length - 1; i >= 0; i -= 1) {
      if (timestamps[i] >= cutoff) {
        count += 1;
      } else {
        break;
      }
    }
    return count;
  }

  recordWebhookAudit(guildId, logId, now = Date.now()) {
    if (!guildId || !logId) return false;
    const guildMap = this.getGuildMap(this.webhookAuditTracker, guildId);
    if (guildMap.has(logId)) return false;
    guildMap.set(logId, now);
    return true;
  }

  recordProcessedAuditAction(guildId, logId, now = Date.now()) {
    if (!guildId || !logId) return true;
    const guildMap = this.getGuildMap(this.auditActionTracker, guildId);
    if (guildMap.has(logId)) return false;
    guildMap.set(logId, now);
    return true;
  }

  getAuditTargetId(entry) {
    if (!entry) return null;
    if (entry.target && entry.target.id) return String(entry.target.id);
    if (entry.targetId) return String(entry.targetId);
    if (entry.extra && entry.extra.targetId) return String(entry.extra.targetId);
    return null;
  }

  async sleep(ms) {
    if (!ms || ms <= 0) return;
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  getRateLimitDelayMs(error) {
    const retryAfterRaw = error?.retryAfter
      ?? error?.retry_after
      ?? error?.data?.retry_after
      ?? error?.rawError?.retry_after;
    const retryAfter = Number(retryAfterRaw);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return retryAfter > 1000 ? Math.round(retryAfter) : Math.round(retryAfter * 1000);
    }

    const status = Number(error?.status || error?.code);
    const msg = String(error?.message || '').toLowerCase();
    if (status === 429 || msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('429')) {
      return 1000;
    }
    return 0;
  }

  formatActionLabel(actionType) {
    const labels = {
      ban: 'ban',
      kick: 'kick',
      channelDelete: 'channel deletion',
      roleDelete: 'role deletion',
      webhookCreate: 'webhook creation',
      botAdd: 'bot addition',
      prune: 'member prune',
      ban_stack: 'ban stack'
    };
    return labels[actionType] || actionType;
  }

  createTraceId() {
    return `AN-${crypto.randomBytes(4).toString('hex')}`.toUpperCase();
  }

  getGuildConfig(guildId) {
    const stored = this.guildConfig.get(guildId) || {};
    const merged = {
      ...this.DEFAULT_CONFIG,
      ...stored,
      quarantine: {
        ...this.DEFAULT_CONFIG.quarantine,
        ...(stored.quarantine || {})
      }
    };
    const now = Date.now();
    merged.strictActive = merged.strictMode || (merged.autoStrictUntil && merged.autoStrictUntil > now);
    return merged;
  }

  setGuildConfig(guildId, updates) {
    const current = this.getGuildConfig(guildId);
    const next = {
      ...current,
      ...updates,
      quarantine: {
        ...current.quarantine,
        ...(updates.quarantine || {})
      }
    };
    this.guildConfig.set(guildId, next);
    this.saveData();
    return next;
  }

  setStrictMode(guildId, enabled, durationMs = null) {
    const updates = { strictMode: enabled };
    if (enabled && durationMs) {
      updates.autoStrictUntil = Date.now() + durationMs;
    } else if (!enabled && !durationMs) {
      updates.autoStrictUntil = 0;
    }
    return this.setGuildConfig(guildId, updates);
  }

  setAggressiveBan(guildId, enabled) {
    return this.setGuildConfig(guildId, { aggressiveBan: enabled });
  }

  setQuarantineOptions(guildId, options) {
    return this.setGuildConfig(guildId, { quarantine: options });
  }

  setAutoStrict(guildId, durationMs) {
    return this.setGuildConfig(guildId, { autoStrictUntil: Date.now() + durationMs });
  }

  applyAutoStrict(guildId, reason = 'auto_strict') {
    if (!this.AUTO_STRICT_DURATION) return null;
    const config = this.getGuildConfig(guildId);
    if (config.strictMode) return config;
    const wasActive = config.strictActive;
    const updated = this.setAutoStrict(guildId, this.AUTO_STRICT_DURATION);
    if (!wasActive) {
      this.logAction(guildId, {
        type: 'strict_mode_enabled',
        executorId: this.client?.user?.id || null,
        durationMinutes: Math.round(this.AUTO_STRICT_DURATION / 60000),
        actionTaken: 'auto',
        notes: reason
      });
    }
    return updated;
  }

  getEncryptionKey() {
    if (!this.ENCRYPTION_KEY) return null;
    return crypto.createHash('sha256').update(this.ENCRYPTION_KEY).digest();
  }

  encryptSnapshot(snapshot) {
    const key = this.getEncryptionKey();
    if (!key) {
      if (this.REQUIRE_BACKUP_ENCRYPTION || !this.ALLOW_UNENCRYPTED_BACKUPS) {
        throw new Error('Backup encryption key is required. Set ANTINUKE_ENCRYPTION_KEY or explicitly allow plaintext backups with ANTINUKE_ALLOW_UNENCRYPTED_BACKUPS=true');
      }
      return {
        encrypted: false,
        payload: snapshot
      };
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(snapshot), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      encrypted: true,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: data.toString('base64')
    };
  }

  decryptSnapshot(entry) {
    if (!entry || !entry.encrypted) return entry && entry.payload ? entry.payload : null;
    const key = this.getEncryptionKey();
    if (!key || !entry.data || !entry.iv || !entry.tag) return null;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(entry.data, 'base64')),
        decipher.final()
      ]);
      return JSON.parse(decrypted.toString('utf8'));
    } catch (error) {
      return null;
    }
  }

  generateBackupId(guildId) {
    const suffix = crypto.randomBytes(3).toString('hex');
    return `bk_${guildId}_${Date.now()}_${suffix}`;
  }

  normalizeBackupStore(store, guildId) {
    if (!store) return { latestId: null, full: [], incremental: [] };

    if (store.roles && store.channels) {
      const entry = this.normalizeBackupEntry({
        id: this.generateBackupId(guildId),
        type: 'full',
        timestamp: store.timestamp || Date.now(),
        payload: { roles: store.roles || [], channels: store.channels || [] }
      });
      return { latestId: entry.id, full: [entry], incremental: [] };
    }

    const full = Array.isArray(store.full) ? store.full.map(entry => this.normalizeBackupEntry(entry)) : [];
    const incremental = Array.isArray(store.incremental) ? store.incremental.map(entry => this.normalizeBackupEntry(entry)) : [];
    const all = [...full, ...incremental];
    const latest = all.sort((a, b) => b.timestamp - a.timestamp)[0] || null;

    return {
      latestId: store.latestId || (latest ? latest.id : null),
      full,
      incremental
    };
  }

  normalizeBackupEntry(entry) {
    if (!entry) return null;
    const normalized = { ...entry };
    if (!normalized.id) {
      normalized.id = `bk_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
    }
    if (!normalized.timestamp) {
      normalized.timestamp = Date.now();
    }
    if (!normalized.type) {
      normalized.type = 'full';
    }
    if (!normalized.counts && (normalized.payload || normalized.roles || normalized.channels)) {
      const payload = normalized.payload || { roles: normalized.roles || [], channels: normalized.channels || [] };
      normalized.counts = {
        roles: payload.roles ? payload.roles.length : 0,
        channels: payload.channels ? payload.channels.length : 0,
        threads: payload.threads ? payload.threads.length : 0,
        emojis: payload.emojis ? payload.emojis.length : 0,
        stickers: payload.stickers ? payload.stickers.length : 0,
        bans: payload.bans ? payload.bans.length : 0
      };
      if (!normalized.payload) {
        normalized.payload = payload;
      }
    }
    if (normalized.encrypted && !normalized.payload) {
      normalized.payload = null;
    }
    return normalized;
  }

  getBackupStore(guildId) {
    if (!this.backups.has(guildId)) {
      this.backups.set(guildId, { latestId: null, full: [], incremental: [] });
    }
    const store = this.backups.get(guildId);
    const normalized = this.normalizeBackupStore(store, guildId);
    this.backups.set(guildId, normalized);
    return normalized;
  }

  pruneBackupStore(store) {
    if (!store) return;
    store.full = store.full.sort((a, b) => b.timestamp - a.timestamp).slice(0, this.BACKUP_RETENTION_FULL);
    store.incremental = store.incremental.sort((a, b) => b.timestamp - a.timestamp).slice(0, this.BACKUP_RETENTION_INCREMENTAL);
    const all = [...store.full, ...store.incremental];
    const latest = all.sort((a, b) => b.timestamp - a.timestamp)[0];
    store.latestId = latest ? latest.id : null;
  }

  getBackupSnapshot(guildId, backupId = null) {
    const store = this.getBackupStore(guildId);
    const targetId = backupId || store.latestId;
    if (!targetId) return null;
    const entry = [...store.full, ...store.incremental].find(b => b.id === targetId);
    if (!entry) return null;
    if (entry.payload) return entry.payload;
    const decrypted = this.decryptSnapshot(entry);
    if (decrypted) {
      entry.payload = decrypted;
    }
    return decrypted;
  }

  listBackups(guildId) {
    const store = this.getBackupStore(guildId);
    return [...store.full, ...store.incremental]
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  exportLogHistory(guildId, limit = 200) {
    const history = this.logHistory.get(guildId) || [];
    return history.slice(-limit);
  }

  cleanupSimulatedActions(guildId, userId) {
    const guildTracker = this.actionTracker.get(guildId);
    if (guildTracker && guildTracker.has(userId)) {
      const actions = guildTracker.get(userId).filter(action => !action.details?.simulated);
      if (actions.length) {
        guildTracker.set(userId, actions);
      } else {
        guildTracker.delete(userId);
      }
    }

    const guildActions = this.beastModeActions.get(guildId);
    if (guildActions && guildActions.has(userId)) {
      const entry = guildActions.get(userId);
      const filtered = (entry.actions || []).filter(action => !action.simulated);
      if (filtered.length) {
        entry.actions = filtered;
        const score = filtered.reduce((sum, action) => sum + (this.POINTS[action.type] || 0), 0);
        const scoreMap = this.getGuildMap(this.beastModeTracker, guildId);
        scoreMap.set(userId, score);
        entry.lastLevel = this.getScoreLevel(score);
        guildActions.set(userId, entry);
      } else {
        guildActions.delete(userId);
        const scoreMap = this.getGuildMap(this.beastModeTracker, guildId);
        scoreMap.delete(userId);
      }
    }

    this.saveData();
  }

  storeLogHistory(guildId, record) {
    const history = this.getGuildList(this.logHistory, guildId);
    history.push(record);
    if (history.length > this.LOG_HISTORY_LIMIT) {
      history.splice(0, history.length - this.LOG_HISTORY_LIMIT);
    }
  }

  scheduleRapidActionCheck(guildId, userId, actionType) {
    const key = `${guildId}:${userId}:${actionType}`;
    if (this.rapidActionTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.rapidActionTimers.delete(key);
      this.checkRapidActions(guildId, userId, actionType, Date.now());
    }, 500);
    this.rapidActionTimers.set(key, timer);
  }

  getGuildMemberCount(guildId) {
    const guild = this.client && this.client.guilds && this.client.guilds.cache
      ? this.client.guilds.cache.get(guildId)
      : null;
    if (!guild) return null;
    if (Number.isFinite(guild.memberCount)) return guild.memberCount;
    if (guild.members && guild.members.cache && Number.isFinite(guild.members.cache.size)) {
      return guild.members.cache.size;
    }
    return null;
  }

  getThresholdScale(guildId) {
    const memberCount = this.getGuildMemberCount(guildId);
    if (!Number.isFinite(memberCount)) return 1;
    for (const entry of this.THRESHOLD_SCALES) {
      if (memberCount >= entry.minMembers) return entry.scale;
    }
    return 1;
  }

  scaleThresholdCount(count, scale, min = 1, max = null) {
    const scaled = Math.max(min, Math.ceil(count * scale));
    if (Number.isFinite(max)) return Math.min(max, scaled);
    return scaled;
  }

  getScaledThresholds(guildId) {
    const scale = this.getThresholdScale(guildId);
    const base = this.THRESHOLDS;
    const scaleCount = (value, min, max) => this.scaleThresholdCount(value, scale, min, max);
    return {
      scale,
      thresholds: {
        ban: {
          ...base.ban,
          count: scaleCount(base.ban.count, 2),
          stackCount: base.ban.stackCount ? scaleCount(base.ban.stackCount, 3) : undefined
        },
        kick: { ...base.kick, count: scaleCount(base.kick.count, 2) },
        channelDelete: { ...base.channelDelete, count: scaleCount(base.channelDelete.count, 2) },
        roleDelete: { ...base.roleDelete, count: scaleCount(base.roleDelete.count, 2) },
        webhookCreate: { ...base.webhookCreate, count: scaleCount(base.webhookCreate.count, 3) },
        emergency: Array.isArray(base.emergency)
          ? base.emergency.map(t => ({ ...t, count: scaleCount(t.count, 5) }))
          : [],
        massBanLockdown: {
          ...base.massBanLockdown,
          count: scaleCount(base.massBanLockdown.count, 20)
        }
      }
    };
  }

  isWhitelistBypassAllowed(guildId, userId) {
    if (!this.isProtectedUser(userId, guildId)) return false;
    const config = this.getGuildConfig(guildId);
    const emergencyActive = this.emergencyMode.get(guildId) || false;
    if (config.strictActive || config.strictForce) {
      return true;
    }
    if (emergencyActive && config.emergencyForceProtect) {
      return true;
    }
    return false;
  }

  getActionConfidence(actions = []) {
    if (!actions.length) return 0.4;
    const audited = actions.filter(action => action.details && action.details.auditLogId).length;
    const ratio = audited / actions.length;
    let confidence = 0.5 + ratio * 0.4;
    if (actions.length >= 5) confidence += 0.05;
    return Math.min(1, Math.max(0, confidence));
  }

  getConfidenceThreshold(config) {
    if (config.strictActive || config.strictForce) return 0;
    if (config.aggressiveBan) return this.AGGRESSIVE_ACTION_THRESHOLD;
    return config.autoActionThreshold || this.AUTO_ACTION_THRESHOLD;
  }

  async requestAdminConfirmation(guild, context) {
    let targetChannel = await this.resolveLogChannel(guild);

    if (!targetChannel) {
      if (!this.LOG_DM_ID) return false;
      try {
        const owner = await this.client.users.fetch(this.LOG_DM_ID);
        targetChannel = await owner.createDM();
      } catch (error) {
        return false;
      }
    }

    const confirmId = `antinuke_confirm_${context.traceId}`;
    const cancelId = `antinuke_cancel_${context.traceId}`;

    const embed = new EmbedBuilder()
      .setColor(this.COLORS.orange)
      .setTitle('🛑 Anti-Nuke Confirmation Required')
      .setDescription(context.description)
      .addFields(
        { name: 'Server', value: guild.name, inline: true },
        { name: 'Action', value: context.actionLabel, inline: true },
        { name: 'Trace ID', value: context.traceId, inline: true }
      )
      .setFooter({ text: `Confirm within ${Math.round(this.EMERGENCY_CONFIRM_WINDOW / 1000)}s` })
      .setTimestamp();

    if (context.details) {
      embed.addFields({ name: 'Details', value: context.details, inline: false });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(confirmId)
        .setLabel('Approve Action')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(cancelId)
        .setLabel('Ignore')
        .setStyle(ButtonStyle.Secondary)
    );

    const message = await targetChannel.send({ embeds: [embed], components: [row] });

    return new Promise((resolve) => {
      const collector = message.createMessageComponentCollector({
        time: this.EMERGENCY_CONFIRM_WINDOW
      });

      collector.on('collect', async (interaction) => {
        const member = interaction.member;
        const hasPerms = member && member.permissions && member.permissions.has;
        const isLogDm = interaction.user && interaction.user.id === this.LOG_DM_ID;
        if (!isLogDm && (!hasPerms || !member.permissions.has(PermissionsBitField.Flags.Administrator))) {
          await interaction.reply({ embeds: [buildErrorEmbed('Administrator permission required.')], flags: 64 });
          return;
        }

        if (interaction.customId === confirmId) {
          await interaction.update({ content: '✅ Approved. Executing action...', embeds: [], components: [] });
          collector.stop('confirmed');
          resolve(true);
        } else if (interaction.customId === cancelId) {
          await interaction.update({ content: '❌ Action ignored.', embeds: [], components: [] });
          collector.stop('cancelled');
          resolve(false);
        }
      });

      collector.on('end', async (_collected, reason) => {
        if (reason === 'confirmed' || reason === 'cancelled') return;
        await message.edit({ content: '⏰ Confirmation timed out. Action ignored.', embeds: [], components: [] }).catch((e) => {
          console.error('Failed to update confirmation timeout message', e);
        });
        resolve(false);
      });
    });
  }

  canActOnMember(guild, member) {
    if (!member) return { allowed: false, reason: 'member_not_found' };
    if (member.id === this.client.user.id) return { allowed: false, reason: 'target_is_bot' };
    if (member.id === guild.ownerId) return { allowed: false, reason: 'target_is_owner' };

    const botMember = guild.members.me;
    if (botMember && member.roles && botMember.roles) {
      const targetTop = member.roles.highest;
      const botTop = botMember.roles.highest;
      if (targetTop && botTop && targetTop.comparePositionTo(botTop) >= 0) {
        return { allowed: false, reason: 'target_above_bot' };
      }
    }

    if (typeof member.bannable === 'boolean' && !member.bannable) {
      return { allowed: false, reason: 'not_bannable' };
    }

    return { allowed: true };
  }

  async ensureQuarantineRole(guild, preserveView) {
    const existing = guild.roles.cache.find(role => role.name === 'ANTINUKE_QUARANTINE');
    if (existing) {
      if (preserveView) {
        const perms = new PermissionsBitField(existing.permissions.bitfield);
        if (!perms.has(PermissionsBitField.Flags.ViewChannel)) {
          await existing.setPermissions([
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.ReadMessageHistory
          ]).catch((e) => {
            console.error('Failed to update quarantine role view permissions', e);
          });
        }
      }
      return existing;
    }

    const permissions = preserveView
      ? [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory]
      : [];
    return await guild.roles.create({
      name: 'ANTINUKE_QUARANTINE',
      permissions,
      reason: 'Anti-nuke quarantine role'
    });
  }

  async applyQuarantine(guild, member, options = {}) {
    const { preserveView, durationMs, traceId, actionLabel, confidence, evidenceRefs, whitelisted } = options;
    const role = await this.ensureQuarantineRole(guild, preserveView);
    if (!role) {
      throw new Error('Failed to create quarantine role');
    }

    const currentRoles = member.roles.cache
      .filter(r => r.id !== guild.id)
      .map(r => r.id);

    const guildAssignments = this.getGuildMap(this.quarantineAssignments, guild.id);
    guildAssignments.set(member.id, {
      roles: currentRoles,
      expiresAt: Date.now() + durationMs,
      quarantineRoleId: role.id
    });
    this.saveData();

    await member.roles.set([role.id], 'Anti-nuke quarantine').catch(() => { throw new Error('Failed to apply quarantine'); });

    this.logAction(guild.id, {
      type: 'quarantine_applied',
      userId: member.id,
      roleId: role.id,
      traceId,
      confidence,
      evidenceRefs,
      whitelisted,
      actionTaken: actionLabel || 'quarantine',
      result: 'applied'
    });
  }

  async restoreQuarantine(guild, userId, reason = 'quarantine_expired') {
    const assignments = this.quarantineAssignments.get(guild.id);
    if (!assignments) return false;
    const entry = assignments.get(userId);
    if (!entry) return false;

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return false;

    const config = this.getGuildConfig(guild.id);
    const emergencyActive = this.emergencyMode.get(guild.id) || false;
    if (config.strictActive || emergencyActive) {
      return false;
    }

    await member.roles.set(entry.roles, 'Anti-nuke quarantine release').catch(() => { throw new Error('Failed to restore roles'); });
    assignments.delete(userId);
    if (assignments.size === 0) {
      this.quarantineAssignments.delete(guild.id);
    }
    this.saveData();

    this.logAction(guild.id, {
      type: 'quarantine_removed',
      userId,
      actionTaken: reason,
      result: 'restored'
    });
    return true;
  }

  async performProtectiveAction(guild, member, context) {
    const config = this.getGuildConfig(guild.id);
    const emergencyActive = this.emergencyMode.get(guild.id) || false;
    const traceId = context.traceId || this.createTraceId();
    const mode = config.quarantine && config.quarantine.mode ? config.quarantine.mode : 'quarantine';
    const forceBan = !!context.forceBan;
    const forceQuarantine = typeof context.forceQuarantine === 'boolean' ? context.forceQuarantine : null;
    const shouldQuarantine = forceQuarantine !== null ? forceQuarantine : mode !== 'ban';
    const shouldBan = forceBan
      || mode === 'ban'
      || mode === 'quarantine_ban'
      || config.aggressiveBan
      || config.strictActive
      || emergencyActive;

    // VULN-11: Consolidated Hierarchy Guard — Verify bot position before ANY punishment.
    const canAct = this.canActOnMember(guild, member);
    if (!canAct.allowed) {
      this.logAction(guild.id, {
        type: 'protection_blocked_hierarchy',
        userId: member.id,
        traceId,
        confidence: context.confidence,
        whitelisted: context.whitelisted,
        actionTaken: 'none',
        result: `blocked_hierarchy:${canAct.reason}`,
        severity: 'CRITICAL',
        notes: `Bot is powerless against ${member.user.tag} (${canAct.reason}). Manual intervention required!`
      });
      return;
    }

    if (shouldQuarantine) {
      try {
        await this.applyQuarantine(guild, member, {
          preserveView: config.quarantine.preserveView,
          durationMs: config.quarantine.durationMs,
          traceId,
          actionLabel: context.actionLabel,
          confidence: context.confidence,
          evidenceRefs: context.evidenceRefs,
          whitelisted: context.whitelisted
        });
      } catch (error) {
        this.logAction(guild.id, {
          type: 'quarantine_failed',
          userId: member.id,
          traceId,
          confidence: context.confidence,
          evidenceRefs: context.evidenceRefs,
          whitelisted: context.whitelisted,
          error: error.message,
          actionTaken: context.actionLabel || 'quarantine',
          result: 'failed'
        });
      }
    }

    if (shouldBan) {
      try {
        // Defensive check: re-verify bannable flag immediately before call to avoid stale state races.
        if (typeof member.bannable === 'boolean' && !member.bannable) {
          throw new Error('Member is not bannable (stale state)');
        }
        await member.ban({ reason: context.reason || 'Anti-nuke protection' });
        this.logAction(guild.id, {
          type: context.successType || 'protective_ban',
          userId: member.id,
          traceId,
          confidence: context.confidence,
          evidenceRefs: context.evidenceRefs,
          whitelisted: context.whitelisted,
          actionTaken: context.actionLabel || 'ban',
          result: 'banned'
        });
        this.resetUserScore(guild.id, member.id, 'protective_ban');
      } catch (error) {
        this.logAction(guild.id, {
          type: context.failType || 'protective_ban_failed',
          userId: member.id,
          traceId,
          confidence: context.confidence,
          evidenceRefs: context.evidenceRefs,
          whitelisted: context.whitelisted,
          error: error.message,
          actionTaken: context.actionLabel || 'ban',
          result: 'failed'
        });
      }
    }
  }

  // Track user action
  trackAction(guildId, userId, actionType, details = {}) {
    if (!guildId || !userId) return;
    const now = typeof details.timestamp === 'number' ? details.timestamp : Date.now();
    this.getGuildConfig(guildId);
    const whitelisted = this.isProtectedUser(userId, guildId);
    const bypassWhitelist = this.isWhitelistBypassAllowed(guildId, userId);
    const scoreDetails = { ...details, whitelisted, whitelistBypassAllowed: bypassWhitelist };
    const traceId = details.traceId || this.createTraceId();
    const guildTracker = this.getGuildMap(this.actionTracker, guildId);
    const userActions = guildTracker.get(userId) || [];

    userActions.push({
      type: actionType,
      timestamp: now,
      details: {
        ...details,
        traceId,
        whitelisted,
        whitelistBypassAllowed: bypassWhitelist
      }
    });

    const cutoff = now - this.BEAST_MODE_WINDOW;
    const trimmed = userActions.filter(action =>
      action.timestamp >= cutoff
    );

    if (trimmed.length === 0) {
      guildTracker.delete(userId);
    } else {
      guildTracker.set(userId, trimmed);
    }

    // Update beast mode score
    const beastResult = this.updateBeastModeScore(guildId, userId, actionType, now, scoreDetails);

    if (!details.simulated) {
      this.scheduleRapidActionCheck(guildId, userId, actionType);
    }

    const targetUserId = details && details.targetId ? details.targetId : undefined;
    if (!details.silent) {
      this.logAction(guildId, {
        type: actionType,
        userId,
        targetUserId,
        points: this.POINTS[actionType] || 0,
        score: beastResult ? beastResult.score : this.getUserScore(guildId, userId),
        scoreBefore: beastResult ? beastResult.previousScore : undefined,
        scoreAfter: beastResult ? beastResult.score : undefined,
        ...details,
        whitelisted,
        whitelistBypassAllowed: bypassWhitelist,
        traceId
      });
    }

    return beastResult;
  }

  // Update beast mode score
  updateBeastModeScore(guildId, userId, actionType, now = Date.now(), details = {}) {
    const points = this.POINTS[actionType] || 0;
    if (!points) return null;

    const whitelisted = !!details.whitelisted;
    const whitelistBypassAllowed = !!details.whitelistBypassAllowed;

    const guildActions = this.getGuildMap(this.beastModeActions, guildId);
    const entry = guildActions.get(userId) || { actions: [], lastLevel: null };
    entry.actions.push({
      type: actionType,
      timestamp: now,
      auditLogId: details.auditLogId || null,
      simulated: !!details.simulated
    });

    const cutoff = now - this.BEAST_MODE_WINDOW;
    entry.actions = entry.actions.filter(action =>
      action.timestamp >= cutoff
    );

    const score = entry.actions.reduce((sum, action) => sum + (this.POINTS[action.type] || 0), 0);
    const guildScores = this.getGuildMap(this.beastModeTracker, guildId);
    const previousScore = guildScores.get(userId) || 0;
    guildScores.set(userId, score);

    const level = this.getScoreLevel(score);
    const prevLevel = entry.lastLevel;

    if (level !== prevLevel) {
      if (!details.simulated) {
        if (level === 'warning') {
          this.logAction(guildId, {
            type: 'beast_mode_warning',
            userId,
            score,
            whitelisted,
            whitelistBypassAllowed,
            traceId: details.traceId
          });
        } else if (level === 'danger') {
          this.logAction(guildId, {
            type: 'beast_mode_danger',
            userId,
            score,
            whitelisted,
            whitelistBypassAllowed,
            traceId: details.traceId
          });
        }
      }
      entry.lastLevel = level === 'safe' ? null : level;
    }

    guildActions.set(userId, entry);

    const triggered = level === 'critical';
    if (triggered) {
      this.handleBeastModeTrigger(guildId, userId, score, { simulated: !!details.simulated }).catch((e) => {
        console.error('Beast mode trigger failed:', e);
      });
    }

    if (!details.simulated) {
      this.saveData();
    }
    return {
      score,
      level,
      points,
      previousScore,
      triggered
    };
  }

  // Get score level for logging
  getScoreLevel(score) {
    if (score >= this.BEAST_MODE_THRESHOLD) return 'critical';
    if (score >= this.BEAST_MODE_DANGER) return 'danger';
    if (score >= this.BEAST_MODE_WARN) return 'warning';
    return 'safe';
  }

  // Handle beast mode trigger
  async handleBeastModeTrigger(guildId, userId, score, meta = {}) {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return;

    if (meta.simulated) {
      this.logAction(guildId, {
        type: 'beast_mode_simulated',
        userId,
        score,
        actionTaken: 'simulated',
        result: 'simulated'
      });
      return;
    }

    const config = this.getGuildConfig(guildId);
    const traceId = this.createTraceId();
    const whitelisted = this.isProtectedUser(userId, guildId);
    const bypassWhitelist = this.isWhitelistBypassAllowed(guildId, userId);
    const actionsEntry = this.beastModeActions.get(guildId)?.get(userId);
    const evidenceRefs = actionsEntry && Array.isArray(actionsEntry.actions)
      ? actionsEntry.actions
        .map(action => action.auditLogId)
        .filter(Boolean)
        .map(id => `Audit ${id}`)
      : [];
    const confidence = evidenceRefs.length ? 0.85 : 0.75;

    if (whitelisted && !bypassWhitelist) {
      this.logAction(guildId, {
        type: 'beast_mode_whitelisted',
        userId,
        score,
        whitelisted: true,
        whitelistBypassAllowed: bypassWhitelist,
        traceId,
        confidence,
        evidenceRefs,
        actionTaken: 'none',
        result: 'whitelist_exempt'
      });
      return;
    }

    try {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) {
        this.logAction(guildId, {
          type: 'beast_mode_ban_failed',
          userId,
          score,
          whitelisted,
          whitelistBypassAllowed: bypassWhitelist,
          traceId,
          confidence,
          evidenceRefs,
          error: 'Member not found'
        });
        return;
      }

      const canAct = this.canActOnMember(guild, member);
      if (!canAct.allowed) {
        this.logAction(guildId, {
          type: 'beast_mode_confirm_denied',
          userId,
          score,
          whitelisted,
          whitelistBypassAllowed: bypassWhitelist,
          traceId,
          confidence,
          evidenceRefs,
          actionTaken: 'none',
          result: canAct.reason
        });
        return;
      }

      const threshold = this.getConfidenceThreshold(config);
      let approved = confidence >= threshold || config.strictForce || config.strictActive;
      if (!approved) {
        approved = await this.requestAdminConfirmation(guild, {
          traceId,
          actionLabel: 'Beast Mode',
          description: `Beast mode threshold reached (${score} points).`,
          details: `Confidence ${Math.round(confidence * 100)}% (threshold ${Math.round(threshold * 100)}%).`
        });
      }

      if (!approved) {
        this.logAction(guildId, {
          type: 'beast_mode_confirm_denied',
          userId,
          score,
          whitelisted,
          whitelistBypassAllowed: bypassWhitelist,
          traceId,
          confidence,
          evidenceRefs,
          actionTaken: 'none',
          result: 'confirmation_denied'
        });
        return;
      }

      await this.performProtectiveAction(guild, member, {
        reason: 'Anti-nuke: Beast mode threshold reached',
        actionType: 'beast_mode',
        actionLabel: 'Beast Mode',
        traceId,
        confidence,
        evidenceRefs,
        score,
        whitelisted,
        successType: 'beast_mode_ban',
        failType: 'beast_mode_ban_failed'
      });
    } catch (error) {
      this.logAction(guildId, {
        type: 'beast_mode_ban_failed',
        userId,
        score,
        whitelisted,
        whitelistBypassAllowed: bypassWhitelist,
        traceId,
        confidence,
        evidenceRefs,
        error: error.message
      });
    }
  }

  // Check for rapid actions
  checkRapidActions(guildId, userId, actionType, now = Date.now(), meta = {}) {
    const guildTracker = this.actionTracker.get(guildId);
    if (!guildTracker) return;
    const userActions = guildTracker.get(userId);
    if (!userActions) return;

    const { thresholds } = this.getScaledThresholds(guildId);
    const threshold = thresholds[actionType];
    if (!threshold) return;

    // Count recent actions
    const recentActions = userActions.filter(action =>
      action.type === actionType && (now - action.timestamp) <= threshold.time
    );

    if (recentActions.length >= threshold.count) {
      const confidence = this.getActionConfidence(recentActions);
      const evidenceRefs = recentActions
        .map(action => action.details && action.details.auditLogId)
        .filter(Boolean)
        .map(id => `Audit ${id}`);
      this.handleRapidAction(guildId, userId, actionType, recentActions, {
        confidence,
        evidenceRefs,
        simulated: meta.simulated
      });
    }

    // Check stacking detection for bans
    if (actionType === 'ban' && threshold.stackCount) {
      const stackActions = userActions.filter(action =>
        action.type === 'ban' && (now - action.timestamp) <= threshold.stackTime
      );

      if (stackActions.length >= threshold.stackCount) {
        const confidence = this.getActionConfidence(stackActions);
        const evidenceRefs = stackActions
          .map(action => action.details && action.details.auditLogId)
          .filter(Boolean)
          .map(id => `Audit ${id}`);
        this.handleRapidAction(guildId, userId, 'ban_stack', stackActions, {
          confidence,
          evidenceRefs,
          simulated: meta.simulated
        });
      }
    }
  }

  // Handle rapid action detection
  async handleRapidAction(guildId, userId, actionType, actions, meta = {}) {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return;

    const config = this.getGuildConfig(guildId);
    const traceId = meta.traceId || this.createTraceId();
    const confidence = typeof meta.confidence === 'number' ? meta.confidence : this.getActionConfidence(actions);
    const evidenceRefs = meta.evidenceRefs || [];
    const simulated = meta.simulated || actions.some(action => action.details && action.details.simulated);

    if (simulated) {
      this.logAction(guildId, {
        type: 'rapid_action_simulated',
        userId,
        actionType,
        count: actions.length,
        traceId,
        confidence,
        evidenceRefs,
        actionTaken: 'simulated',
        result: 'simulated'
      });
      return;
    }

    const whitelisted = this.isProtectedUser(userId, guildId);
    const bypassWhitelist = this.isWhitelistBypassAllowed(guildId, userId);
    if (whitelisted && !bypassWhitelist) {
      this.logAction(guildId, {
        type: 'rapid_action_whitelisted',
        userId,
        actionType,
        count: actions.length,
        whitelisted: true,
        whitelistBypassAllowed: bypassWhitelist,
        confidence,
        evidenceRefs,
        traceId,
        actionTaken: 'none',
        result: 'whitelist_exempt'
      });
      return;
    }

    const user = await guild.members.fetch(userId).catch(() => null);
    if (!user) {
      this.logAction(guildId, {
        type: 'rapid_action_ban_failed',
        userId,
        actionType,
        count: actions.length,
        whitelisted,
        whitelistBypassAllowed: bypassWhitelist,
        traceId,
        confidence,
        evidenceRefs,
        error: 'Member not found'
      });
      return;
    }

    const canAct = this.canActOnMember(guild, user);
    if (!canAct.allowed) {
      this.logAction(guildId, {
        type: 'rapid_action_ignored',
        userId,
        actionType,
        count: actions.length,
        whitelisted,
        whitelistBypassAllowed: bypassWhitelist,
        traceId,
        confidence,
        evidenceRefs,
        actionTaken: 'none',
        result: canAct.reason
      });
      return;
    }

    const threshold = this.getConfidenceThreshold(config);
    let approved = confidence >= threshold || config.strictForce || config.strictActive;
    if (!approved) {
      approved = await this.requestAdminConfirmation(guild, {
        traceId,
        actionLabel: `Rapid ${this.formatActionLabel(actionType)}`,
        description: `Rapid ${this.formatActionLabel(actionType)} detected (${actions.length} actions).`,
        details: `Confidence ${Math.round(confidence * 100)}% (threshold ${Math.round(threshold * 100)}%).`
      });
    }

    if (!approved) {
      this.logAction(guildId, {
        type: 'rapid_action_confirm_denied',
        userId,
        actionType,
        count: actions.length,
        whitelisted,
        whitelistBypassAllowed: bypassWhitelist,
        traceId,
        confidence,
        evidenceRefs,
        actionTaken: 'none',
        result: 'confirmation_denied'
      });
      return;
    }

    this.applyAutoStrict(guildId, `rapid_${actionType}`);

    await this.performProtectiveAction(guild, user, {
      reason: `Anti-nuke: Rapid ${actionType} detected`,
      actionType: 'rapid_action',
      actionLabel: `Rapid ${this.formatActionLabel(actionType)}`,
      traceId,
      confidence,
      evidenceRefs,
      count: actions.length,
      whitelisted,
      successType: 'rapid_action_ban',
      failType: 'rapid_action_ban_failed'
    });
  }

  async waitForAuditLog(guild, type, targetId, maxAgeMs = 5000) {
    if (!this.processedAuditEntries) this.processedAuditEntries = new Set();
    const start = Date.now();
    const baseLimit = Math.max(6, Number(this.AUDIT_LOG_FETCH_LIMIT || 6));
    const maxLimit = Math.max(baseLimit, Number(this.AUDIT_LOG_MAX_FETCH_LIMIT || 60));
    const attemptPlan = [
      { delay: 0, limit: baseLimit },
      { delay: 350, limit: Math.min(maxLimit, Math.max(baseLimit * 2, 12)) },
      { delay: 1000, limit: Math.min(maxLimit, Math.max(baseLimit * 4, 24)) },
      { delay: 1800, limit: maxLimit }
    ];
    const wantedTargetId = targetId ? String(targetId) : null;

    for (const attempt of attemptPlan) {
      if (attempt.delay > 0) await this.sleep(attempt.delay);

      let auditLogs = null;
      try {
        // Fetch logs with specific type filter to reduce junk.
        auditLogs = await guild.fetchAuditLogs({ limit: attempt.limit, type });
      } catch (error) {
        const retryDelay = this.getRateLimitDelayMs(error);
        if (retryDelay > 0) {
          await this.sleep(retryDelay);
          continue;
        }
        continue;
      }
      if (!auditLogs || !auditLogs.entries) continue;

      const entries = Array.from(auditLogs.entries.values())
        .filter(Boolean)
        .sort((a, b) => Number(b.createdTimestamp || 0) - Number(a.createdTimestamp || 0));

      for (const entry of entries) {
        if (!entry || !entry.id) continue;

        // D-01: Audit Log Deduplication. 
        // Prevents using the same entry for multiple event triggers (framing vuln).
        if (this.processedAuditEntries.has(entry.id)) continue;

        if (wantedTargetId) {
          const entryTargetId = this.getAuditTargetId(entry);
          if (!entryTargetId || entryTargetId !== wantedTargetId) continue;
        }

        const createdTs = Number(entry.createdTimestamp || 0);
        if (!createdTs) continue;
        if ((start - createdTs) > (maxAgeMs + attempt.delay + 1000)) continue;

        // Mark as processed so it can't be used for another event.
        this.processedAuditEntries.add(entry.id);
        
        // TTL for the cache (cleanup after 1 minute)
        setTimeout(() => this.processedAuditEntries.delete(entry.id), 60000);

        return entry;
      }
    }
    return null;
  }

  async getRecentAuditExecutor(guild, type, targetId, maxAgeMs = 5000) {
    const entry = await this.waitForAuditLog(guild, type, targetId, maxAgeMs);
    return entry && entry.executor ? entry.executor : null;
  }

  // Handle ban events
  async handleBan(ban) {
    const eventTime = Date.now(); // Capture time immediately
    const guild = ban.guild;

    const entry = await this.waitForAuditLog(guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    const executor = entry && entry.executor ? entry.executor : null;

    if (!executor || executor.id === this.client.user.id) return;
    if (!this.recordProcessedAuditAction(guild.id, entry ? entry.id : null, eventTime)) return;

    this.trackAction(guild.id, executor.id, 'ban', {
      targetId: ban.user.id,
      auditLogId: entry ? entry.id : null,
      traceId: this.createTraceId(),
      timestamp: eventTime // Use the precise event time
    });
    const banTimestamps = this.recordBan(guild.id, eventTime);
    this.checkMassBanLockdown(guild.id, banTimestamps, eventTime);
    this.checkEmergencyThresholds(guild.id, banTimestamps, eventTime);
  }

  // Handle kick events
  async handleKick(member) {
    const eventTime = Date.now();
    const guild = member.guild;

    const entry = await this.waitForAuditLog(guild, AuditLogEvent.MemberKick, member.id);
    const executor = entry && entry.executor ? entry.executor : null;

    // If there's no recent kick audit entry for this member, treat it as a normal leave
    if (!executor) return;
    if (executor.id === this.client.user.id) return;
    if (!this.recordProcessedAuditAction(guild.id, entry ? entry.id : null, eventTime)) return;

    this.trackAction(guild.id, executor.id, 'kick', {
      targetId: member.id,
      auditLogId: entry ? entry.id : null,
      traceId: this.createTraceId(),
      timestamp: eventTime
    });
  }

  // Handle channel deletion
  async handleChannelDelete(channel) {
    const eventTime = Date.now();
    const guild = channel.guild;

    const entry = await this.waitForAuditLog(guild, AuditLogEvent.ChannelDelete, channel.id);
    const executor = entry && entry.executor ? entry.executor : null;

    if (!executor || executor.id === this.client.user.id) return;

    this.trackAction(guild.id, executor.id, 'channelDelete', {
      channelId: channel.id,
      channelName: channel.name,
      auditLogId: entry ? entry.id : null,
      traceId: this.createTraceId(),
      timestamp: eventTime
    });
  }

  // Handle role deletion
  async handleRoleDelete(role) {
    const eventTime = Date.now();
    const guild = role.guild;

    const entry = await this.waitForAuditLog(guild, AuditLogEvent.RoleDelete, role.id);
    const executor = entry && entry.executor ? entry.executor : null;

    if (!executor || executor.id === this.client.user.id) return;

    this.trackAction(guild.id, executor.id, 'roleDelete', {
      roleId: role.id,
      roleName: role.name,
      auditLogId: entry ? entry.id : null,
      traceId: this.createTraceId(),
      timestamp: eventTime
    });
  }

  // Handle member add (bot detection + anti-raid join flood)
  async handleMemberAdd(member) {
    const eventTime = Date.now();
    const guild = member.guild;

    // Anti-raid join flood detection (humans only)
    if (!member.user.bot) {
      const timestamps = this.getGuildList(this.joinTracker, guild.id);
      timestamps.push(eventTime);
      const { thresholds } = this.getScaledThresholds(guild.id);
      const joinThreshold = thresholds.joinRaid || this.THRESHOLDS.joinRaid;
      const cutoff = eventTime - (joinThreshold.time || 15000);
      while (timestamps.length && timestamps[0] < cutoff) timestamps.shift();

      if (!this.emergencyMode.get(guild.id) && timestamps.length >= joinThreshold.count) {
        try {
          await this.handleEmergencyMode(guild.id, {
            reason: 'join_raid',
            count: timestamps.length,
            threshold: joinThreshold
          });
        } catch (e) {
          console.error('Failed to activate join-raid emergency mode', e);
        }
      }
      return;
    }

    const entry = await this.waitForAuditLog(guild, AuditLogEvent.BotAdd, member.id);
    const executor = entry && entry.executor ? entry.executor : null;

    if (!executor || executor.id === this.client.user.id) return;

    const beastResult = this.trackAction(guild.id, executor.id, 'botAdd', {
      botId: member.id,
      botTag: member.user.tag,
      auditLogId: entry ? entry.id : null,
      traceId: this.createTraceId(),
      timestamp: eventTime
    });

    // If beast mode is triggered, ban both user and bot
    if (beastResult && beastResult.triggered) {
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
    const eventTime = Date.now();
    const guild = channel.guild;
    const entry = await this.waitForAuditLog(guild, AuditLogEvent.WebhookCreate, null, 15000); // Longer window for webhooks
    if (!entry || !entry.executor || entry.executor.id === this.client.user.id) return;
    const targetChannelId = entry.target?.channelId || entry.extra?.channel?.id || null;
    if (targetChannelId && targetChannelId !== channel.id) return;
    const webhookId = entry.target?.id || null;
    if (webhookId && typeof channel.fetchWebhooks === 'function') {
      const hooks = await channel.fetchWebhooks().catch(() => null);
      const hook = hooks && typeof hooks.get === 'function'
        ? hooks.get(webhookId)
        : (hooks && typeof hooks.find === 'function' ? hooks.find(h => h.id === webhookId) : null);
      if (!hook) {
        this.logAction(guild.id, {
          type: 'webhook_audit_mismatch',
          executorId: entry.executor.id,
          webhookId,
          channelId: channel.id,
          traceId: this.createTraceId(),
          actionTaken: 'none',
          result: 'not_found'
        });
        return;
      }
    }
    if (!this.recordWebhookAudit(guild.id, entry.id, eventTime)) return;

    this.trackAction(guild.id, entry.executor.id, 'webhookCreate', {
      webhookId: webhookId,
      logId: entry.id,
      auditLogId: entry.id,
      channelId: channel.id,
      traceId: this.createTraceId(),
      timestamp: eventTime
    });
  }

  recordBan(guildId, now = Date.now()) {
    const timestamps = this.getGuildList(this.banTracker, guildId);
    timestamps.push(now);
    const cutoff = now - this.BAN_DAY_WINDOW;
    while (timestamps.length && timestamps[0] < cutoff) {
      timestamps.shift();
    }
    return timestamps;
  }

  checkMassBanLockdown(guildId, banTimestamps, now = Date.now(), meta = {}) {
    const { thresholds } = this.getScaledThresholds(guildId);
    const massThreshold = thresholds.massBanLockdown || this.THRESHOLDS.massBanLockdown;
    const count = this.getWindowCount(banTimestamps, massThreshold.time || this.BAN_WINDOW, now);
    if (count < massThreshold.count) return;
    if (meta.simulated) {
      this.handleMassBanLockdown(guildId, count, meta);
      return;
    }
    const lastTrigger = this.lastMassBanLockdown.get(guildId) || 0;
    if (now - lastTrigger < this.MASS_BAN_COOLDOWN) return;
    this.lastMassBanLockdown.set(guildId, now);
    this.handleMassBanLockdown(guildId, count, meta);
  }

  // Check emergency thresholds
  checkEmergencyThresholds(guildId, banTimestamps, now = Date.now(), meta = {}) {
    const { thresholds } = this.getScaledThresholds(guildId);
    const emergencyThresholds = Array.isArray(thresholds.emergency) ? thresholds.emergency : this.THRESHOLDS.emergency;
    for (const threshold of emergencyThresholds) {
      const count = this.getWindowCount(banTimestamps, threshold.time, now);
      if (count >= threshold.count) {
        this.handleEmergencyMode(guildId, { count, threshold }, meta);
        break;
      }
    }
  }

  // Handle mass ban lockdown
  async handleMassBanLockdown(guildId, banCount = 0, meta = {}) {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return;

    if (meta.simulated) {
      this.logAction(guildId, {
        type: 'mass_ban_lockdown_simulated',
        banCount,
        actionTaken: 'simulated',
        result: 'simulated'
      });
      return;
    }

    const config = this.getGuildConfig(guildId);
    const traceId = this.createTraceId();
    const { thresholds } = this.getScaledThresholds(guildId);
    const massThreshold = thresholds.massBanLockdown || this.THRESHOLDS.massBanLockdown;
    const confidence = Math.min(1, 0.6 + Math.min(0.4, banCount / massThreshold.count * 0.4));
    const threshold = this.getConfidenceThreshold(config);
    let approved = confidence >= threshold || config.strictForce || config.strictActive;
    if (!approved) {
      this.logAction(guildId, {
        type: 'mass_ban_lockdown_pending',
        banCount,
        traceId,
        confidence,
        actionTaken: 'confirmation_pending'
      });
      approved = await this.requestAdminConfirmation(guild, {
        traceId,
        actionLabel: 'Mass Ban Lockdown',
        description: `Mass ban detected (${banCount} bans).`,
        details: `Confidence ${Math.round(confidence * 100)}% (threshold ${Math.round(threshold * 100)}%).`
      });
    }
    if (!approved) {
      this.logAction(guildId, {
        type: 'mass_ban_lockdown_confirm_denied',
        banCount,
        traceId,
        confidence,
        actionTaken: 'none',
        result: 'confirmation_denied'
      });
      return;
    }

    this.applyAutoStrict(guildId, 'mass_ban_lockdown');

    try {
      // Remove dangerous permissions from all roles
      await this.removeDangerousPermissions(guild);

      this.logAction(guildId, {
        type: 'mass_ban_lockdown',
        banCount,
        success: true,
        traceId,
        confidence,
        actionTaken: 'remove_dangerous_permissions',
        result: 'applied'
      });
    } catch (error) {
      this.logAction(guildId, {
        type: 'mass_ban_lockdown_failed',
        error: error.message,
        traceId,
        confidence,
        actionTaken: 'remove_dangerous_permissions',
        result: 'failed'
      });
    }
  }

  // Handle emergency mode
  async handleEmergencyMode(guildId, details = null, meta = {}) {
    if (this.emergencyMode.get(guildId)) return; // Already in emergency mode

    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return;

    const pending = this.pendingEmergencyConfirmations.get(guildId);
    if (pending && pending.expiresAt > Date.now()) {
      return;
    }

    if (meta.simulated) {
      this.logAction(guildId, {
        type: 'emergency_mode_simulated',
        details,
        actionTaken: 'simulated',
        result: 'simulated'
      });
      return;
    }

    const config = this.getGuildConfig(guildId);
    const traceId = this.createTraceId();
    const threshold = details && details.threshold ? details.threshold : null;
    const confidence = threshold ? Math.min(1, 0.7 + (details.count / threshold.count) * 0.2) : 0.7;
    let approved = config.strictForce || config.strictActive;
    if (!approved) {
      this.pendingEmergencyConfirmations.set(guildId, {
        pending: true,
        expiresAt: Date.now() + this.EMERGENCY_CONFIRM_WINDOW
      });
      this.logAction(guildId, {
        type: 'emergency_mode_pending',
        traceId,
        confidence,
        actionTaken: 'confirmation_pending',
        details
      });
      approved = await this.requestAdminConfirmation(guild, {
        traceId,
        actionLabel: 'Emergency Mode',
        description: 'Emergency threshold reached. Approve lockdown?',
        details: threshold
          ? `${details.count}/${threshold.count} bans in ${Math.round(threshold.time / 1000)}s`
          : `Confidence ${Math.round(confidence * 100)}%`
      });
    }
    this.pendingEmergencyConfirmations.delete(guildId);
    if (!approved) {
      this.logAction(guildId, {
        type: 'emergency_mode_confirm_denied',
        traceId,
        confidence,
        actionTaken: 'none',
        result: 'confirmation_denied',
        details
      });
      return;
    }

    this.applyAutoStrict(guildId, 'emergency_mode');

    try {
      // Remove all permissions except
      // LOCKDOWN ORDER: Permissions stripped FIRST (immediate), then backup (takes time).
      await this.removeDangerousPermissions(guild, { reason: 'Anti-Nuke Emergency Mode (Attack detected)' });
      await this.createBackup(guild, { reason: 'Anti-Nuke Emergency Mode (Attack detected)' });

      // Lock down @everyone
      const everyoneRole = guild.roles.everyone;
      await everyoneRole.setPermissions([
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.ReadMessageHistory
      ]);

      // Disable all invites
      await this.disableAllInvites(guild);

      this.emergencyMode.set(guildId, true);
      const lockdownUntil = Date.now() + this.EMERGENCY_LOCKDOWN_DURATION;
      this.emergencyLockdownUntil.set(guildId, lockdownUntil);

      this.logAction(guildId, {
        type: 'emergency_mode',
        success: true,
        details,
        traceId,
        confidence,
        backupId: backup ? backup.id : null,
        lockdownUntil,
        actionTaken: 'lockdown',
        result: 'activated'
      });

      // Send critical alert
      const detailText = details && details.threshold
        ? `${details.count}/${details.threshold.count} bans in ${Math.round(details.threshold.time / 1000)}s`
        : 'Emergency mode activated due to critical attack threshold';
      await this.sendCriticalAlert(guild, `Emergency mode activated: ${detailText}`);

    } catch (error) {
      this.logAction(guildId, {
        type: 'emergency_mode_failed',
        error: error.message,
        traceId,
        confidence,
        actionTaken: 'lockdown',
        result: 'failed'
      });
    }
  }

  // Remove dangerous permissions
  async removeDangerousPermissions(guild, emergencyMode = false) {
    const roles = Array.from(guild.roles.cache.values()).filter(role => !role.managed);
    const batchSize = 5;

    const tasks = roles.map(role => async () => {
      if (!role.editable) return;
      try {
        const currentPerms = new PermissionsBitField(role.permissions.bitfield);
        let newPerms = currentPerms.remove(this.DANGEROUS_PERMISSIONS);
        if (emergencyMode) {
          const keep = new PermissionsBitField();
          if (currentPerms.has(PermissionsBitField.Flags.ViewChannel)) {
            keep.add(PermissionsBitField.Flags.ViewChannel);
          }
          if (currentPerms.has(PermissionsBitField.Flags.ReadMessageHistory)) {
            keep.add(PermissionsBitField.Flags.ReadMessageHistory);
          }
          newPerms = keep;
        }
        if (newPerms.bitfield === currentPerms.bitfield) return;
        await role.setPermissions(newPerms);
      } catch (error) {
        console.error('Failed to update role permissions during lockdown', { roleId: role.id, error });
      }
    });

    for (let i = 0; i < tasks.length; i += batchSize) {
      const batch = tasks.slice(i, i + batchSize);
      await Promise.all(batch.map(fn => fn()));
    }
  }

  // Create backup
  async createBackup(guild, options = {}) {
    if (!guild || !guild.id) {
      throw new Error('Invalid guild context for backup creation');
    }

    const type = options.type || 'full';
    const manual = !!options.manual;
    const executorId = options.executorId || null;

    const toArray = (source) => {
      if (!source) return [];
      if (Array.isArray(source)) return source;
      if (typeof source.values === 'function') return Array.from(source.values());
      if (typeof source.map === 'function') return source.map(item => item);
      if (typeof source.forEach === 'function') {
        const out = [];
        source.forEach((value) => out.push(value));
        return out;
      }
      return [];
    };

    const isThreadType = (channelType) => channelType === 10 || channelType === 11 || channelType === 12;

    const serializeOverwrites = (channel) => toArray(channel && channel.permissionOverwrites && channel.permissionOverwrites.cache).map(overwrite => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: overwrite && overwrite.allow && overwrite.allow.bitfield != null
        ? overwrite.allow.bitfield.toString()
        : '0',
      deny: overwrite && overwrite.deny && overwrite.deny.bitfield != null
        ? overwrite.deny.bitfield.toString()
        : '0'
    }));

    const serializeChannel = (channel) => {
      const rawTags = Array.isArray(channel && channel.availableTags) ? channel.availableTags : [];
      const availableTags = rawTags.map(tag => ({
        id: tag && tag.id ? String(tag.id) : null,
        name: tag && tag.name ? String(tag.name) : 'tag',
        moderated: !!(tag && tag.moderated),
        emojiId: tag && tag.emojiId ? String(tag.emojiId) : null,
        emojiName: tag && tag.emojiName ? String(tag.emojiName) : null
      }));

      const defaultReactionEmoji = channel && channel.defaultReactionEmoji
        ? {
          emojiId: channel.defaultReactionEmoji.emojiId ? String(channel.defaultReactionEmoji.emojiId) : null,
          emojiName: channel.defaultReactionEmoji.emojiName ? String(channel.defaultReactionEmoji.emojiName) : null
        }
        : null;

      return {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        position: channel.position,
        parentId: channel.parentId,
        topic: channel.topic != null ? channel.topic : null,
        nsfw: channel.nsfw != null ? !!channel.nsfw : null,
        rateLimitPerUser: Number.isFinite(channel.rateLimitPerUser) ? channel.rateLimitPerUser : null,
        bitrate: Number.isFinite(channel.bitrate) ? channel.bitrate : null,
        userLimit: Number.isFinite(channel.userLimit) ? channel.userLimit : null,
        rtcRegion: channel.rtcRegion != null ? channel.rtcRegion : null,
        videoQualityMode: channel.videoQualityMode != null ? channel.videoQualityMode : null,
        defaultAutoArchiveDuration: Number.isFinite(channel.defaultAutoArchiveDuration) ? channel.defaultAutoArchiveDuration : null,
        defaultThreadRateLimitPerUser: Number.isFinite(channel.defaultThreadRateLimitPerUser) ? channel.defaultThreadRateLimitPerUser : null,
        defaultSortOrder: channel.defaultSortOrder != null ? channel.defaultSortOrder : null,
        defaultForumLayout: channel.defaultForumLayout != null ? channel.defaultForumLayout : null,
        defaultReactionEmoji,
        availableTags,
        permissionOverwrites: serializeOverwrites(channel)
      };
    };

    const serializeThread = (thread) => ({
      id: thread.id,
      name: thread.name,
      type: thread.type,
      parentId: thread.parentId || null,
      archived: !!thread.archived,
      autoArchiveDuration: Number.isFinite(thread.autoArchiveDuration) ? thread.autoArchiveDuration : null,
      rateLimitPerUser: Number.isFinite(thread.rateLimitPerUser) ? thread.rateLimitPerUser : null,
      locked: !!thread.locked,
      invitable: thread.invitable != null ? !!thread.invitable : null,
      createdTimestamp: Number.isFinite(thread.createdTimestamp) ? thread.createdTimestamp : null
    });

    const roleItems = toArray(guild.roles && guild.roles.cache);
    const baseChannelItems = toArray(guild.channels && guild.channels.cache);
    const threadById = new Map();
    const channelItems = [];

    for (const channel of baseChannelItems) {
      if (!channel || !channel.id) continue;
      if (isThreadType(channel.type)) {
        threadById.set(channel.id, serializeThread(channel));
        continue;
      }
      channelItems.push(channel);
    }

    if (guild.channels && typeof guild.channels.fetchActiveThreads === 'function') {
      try {
        const activeThreads = await guild.channels.fetchActiveThreads();
        const activeList = toArray(activeThreads && activeThreads.threads);
        for (const thread of activeList) {
          if (!thread || !thread.id) continue;
          if (!threadById.has(thread.id)) {
            threadById.set(thread.id, serializeThread(thread));
          }
        }
      } catch (e) {
        console.error('Backup: failed to fetch active threads', { guildId: guild.id, error: e });
      }
    }

    let bans = [];
    if (guild.bans && typeof guild.bans.fetch === 'function') {
      try {
        const fetchedBans = await guild.bans.fetch();
        bans = toArray(fetchedBans).map((entry) => ({
          userId: entry && entry.user && entry.user.id ? String(entry.user.id) : null,
          reason: entry && entry.reason ? String(entry.reason) : null
        })).filter(entry => !!entry.userId);
      } catch (e) {
        console.error('Backup: failed to fetch ban list', { guildId: guild.id, error: e });
      }
    }

    let onboarding = null;
    if (typeof guild.fetchOnboarding === 'function') {
      try {
        const onboardingData = await guild.fetchOnboarding();
        if (onboardingData) {
          onboarding = typeof onboardingData.toJSON === 'function'
            ? onboardingData.toJSON()
            : { ...onboardingData };
        }
      } catch (e) {
        console.error('Backup: failed to fetch onboarding configuration', { guildId: guild.id, error: e });
      }
    }

    const emojiItems = toArray(guild.emojis && guild.emojis.cache);
    const stickerItems = toArray(guild.stickers && guild.stickers.cache);

    const guildMeta = {
      id: guild.id,
      name: guild.name || null,
      description: guild.description != null ? guild.description : null,
      preferredLocale: guild.preferredLocale != null ? guild.preferredLocale : null,
      verificationLevel: guild.verificationLevel != null ? guild.verificationLevel : null,
      explicitContentFilter: guild.explicitContentFilter != null ? guild.explicitContentFilter : null,
      defaultMessageNotifications: guild.defaultMessageNotifications != null ? guild.defaultMessageNotifications : null,
      afkTimeout: Number.isFinite(guild.afkTimeout) ? guild.afkTimeout : null,
      afkChannelId: guild.afkChannelId || null,
      systemChannelId: guild.systemChannelId || null,
      rulesChannelId: guild.rulesChannelId || null,
      publicUpdatesChannelId: guild.publicUpdatesChannelId || null,
      safetyAlertsChannelId: guild.safetyAlertsChannelId || null,
      iconURL: typeof guild.iconURL === 'function' ? guild.iconURL({ forceStatic: false, size: 4096 }) : null,
      bannerURL: typeof guild.bannerURL === 'function' ? guild.bannerURL({ forceStatic: false, size: 4096 }) : null,
      splashURL: typeof guild.splashURL === 'function' ? guild.splashURL({ forceStatic: false, size: 4096 }) : null,
      discoverySplashURL: typeof guild.discoverySplashURL === 'function' ? guild.discoverySplashURL({ forceStatic: false, size: 4096 }) : null
    };

    const snapshot = {
      timestamp: Date.now(),
      guildMeta,
      roles: roleItems.map(role => ({
        id: role.id,
        name: role.name,
        permissions: role && role.permissions && role.permissions.bitfield != null
          ? role.permissions.bitfield.toString()
          : '0',
        position: role.position,
        color: role.color,
        hoist: role.hoist,
        mentionable: role.mentionable
      })),
      channels: channelItems.map(serializeChannel),
      threads: Array.from(threadById.values()),
      emojis: emojiItems.map((emoji) => ({
        id: emoji.id,
        name: emoji.name,
        animated: !!emoji.animated,
        url: typeof emoji.imageURL === 'function'
          ? emoji.imageURL({ extension: emoji.animated ? 'gif' : 'png', size: 4096, forceStatic: false })
          : null,
        roles: toArray(emoji.roles && emoji.roles.cache).map(role => role.id)
      })),
      stickers: stickerItems.map((sticker) => ({
        id: sticker.id,
        name: sticker.name || null,
        description: sticker.description || null,
        tags: sticker.tags || null,
        format: sticker.format || null,
        type: sticker.type || null,
        url: sticker.url || null
      })),
      bans,
      onboarding
    };

    const entryId = this.generateBackupId(guild.id);
    const encrypted = this.encryptSnapshot(snapshot);
    const entry = this.normalizeBackupEntry({
      id: entryId,
      type,
      timestamp: snapshot.timestamp,
      counts: {
        roles: snapshot.roles.length,
        channels: snapshot.channels.length,
        threads: (snapshot.threads || []).length,
        emojis: (snapshot.emojis || []).length,
        stickers: (snapshot.stickers || []).length,
        bans: (snapshot.bans || []).length
      },
      ...encrypted,
      payload: encrypted.encrypted ? null : snapshot
    });

    const store = this.getBackupStore(guild.id);
    if (type === 'incremental') {
      store.incremental.push(entry);
    } else {
      store.full.push(entry);
      this.lastFullBackupAt.set(guild.id, snapshot.timestamp);
    }
    store.latestId = entry.id;
    this.pruneBackupStore(store);
    this.backups.set(guild.id, store);

    const logType = manual
      ? 'manual_backup_created'
      : type === 'incremental'
        ? 'backup_incremental_created'
        : 'backup_created';

    if (this.shouldLogBackupAction(guild.id, { type: logType, manual })) {
      this.logAction(guild.id, {
        type: logType,
        executorId,
        backupId: entry.id,
        rolesCount: snapshot.roles.length,
        channelsCount: snapshot.channels.length,
        threadsCount: (snapshot.threads || []).length,
        emojisCount: (snapshot.emojis || []).length,
        stickersCount: (snapshot.stickers || []).length,
        bansCount: (snapshot.bans || []).length,
        encrypted: entry.encrypted || false
      });
    }
    this.saveData();
    return entry;
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
        { name: 'Time', value: formatUtcDate(), inline: true }
      )
      .setTimestamp();

    // Send to log DM
    if (this.LOG_DM_ID) {
      try {
        const owner = await this.client.users.fetch(this.LOG_DM_ID);
        await owner.send({ embeds: [embed] });
      } catch (error) {
        // DM might be disabled
      }
    }

    // Send to log channel
    const logChannel = await this.resolveLogChannel(guild);
    if (logChannel) {
      await logChannel.send({ embeds: [embed] }).catch((e) => {
        console.error('Failed to send anti-nuke log message', e);
      });
    }
  }

  isBackupActionType(actionType) {
    return actionType === 'backup_created'
      || actionType === 'backup_incremental_created'
      || actionType === 'manual_backup_created';
  }

  isCriticalActionType(actionType) {
    return [
      'beast_mode_ban',
      'beast_mode_ban_failed',
      'rapid_action_ban',
      'rapid_action_ban_failed',
      'prune_ban',
      'prune_ban_failed',
      'bot_beast_mode_ban',
      'bot_beast_mode_ban_failed',
      'emergency_mode',
      'emergency_mode_failed',
      'emergency_mode_pending',
      'emergency_mode_confirm_denied',
      'mass_ban_lockdown_failed',
      'mass_ban_lockdown',
      'mass_ban_lockdown_pending',
      'mass_ban_lockdown_confirm_denied',
      'protective_ban',
      'protective_ban_failed'
    ].includes(actionType);
  }

  shouldLogBackupAction(guildId, backupMeta = {}) {
    if (backupMeta.manual) return true;
    if (!this.LOG_AUTOMATIC_BACKUPS) return false;

    const backupType = backupMeta.type || '';
    const isIncremental = backupType === 'backup_incremental_created';
    if (isIncremental && !this.LOG_INCREMENTAL_BACKUPS) return false;

    const now = Date.now();
    if (isIncremental) {
      const suppressWindow = Number.isFinite(this.BACKUP_INCREMENTAL_AFTER_FULL_SUPPRESS_MS)
        ? Math.max(0, this.BACKUP_INCREMENTAL_AFTER_FULL_SUPPRESS_MS)
        : 900000;
      const lastFullTs = this.lastFullBackupAt.get(guildId);
      if (lastFullTs && (now - lastFullTs) < suppressWindow) {
        return false;
      }
    }

    const dedupeWindow = Number.isFinite(this.BACKUP_LOG_DEDUPE_WINDOW_MS)
      ? Math.max(60000, this.BACKUP_LOG_DEDUPE_WINDOW_MS)
      : 180000;
    const previous = this.lastBackupNotification.get(guildId);
    if (previous && (now - previous.timestamp) < dedupeWindow) {
      return false;
    }
    this.lastBackupNotification.set(guildId, {
      timestamp: now,
      type: backupType || null
    });
    return true;
  }

  shouldSendOwnerDmForAction(actionData = {}, context = {}) {
    if (!this.LOG_DM_ID) return false;

    const mode = this.LOG_DM_MODE === 'all' || this.LOG_DM_MODE === 'critical'
      ? this.LOG_DM_MODE
      : 'off';
    if (mode === 'off') return false;

    const actionType = actionData.type || '';
    const isBackup = this.isBackupActionType(actionType);
    const isCritical = this.isCriticalActionType(actionType);

    if (isBackup && !this.LOG_DM_INCLUDE_BACKUPS) return false;
    if (!isCritical && !this.LOG_DM_INCLUDE_NON_CRITICAL) return false;
    if (mode === 'critical' && !isCritical) return false;

    const channelAttempted = context.channelAttempted === true;
    const channelSent = context.channelSent === true;
    const channelFailed = context.channelFailed === true;

    if (!this.LOG_DM_DUPLICATE_WITH_CHANNEL) {
      if (channelAttempted && channelSent && !channelFailed) return false;
      if (channelAttempted && channelFailed) return true;
    }

    return true;
  }

  // Log action
  async logAction(guildId, actionData) {
    const guildCache = this.client && this.client.guilds && this.client.guilds.cache;
    if (!guildCache || typeof guildCache.get !== 'function') return;
    const guild = guildCache.get(guildId);
    if (!guild) return;

    const traceId = actionData.traceId || this.createTraceId();
    const timestamp = Date.now();
    const record = {
      traceId,
      timestamp,
      guildId,
      actionType: actionData.type,
      executorId: actionData.executorId || actionData.userId || null,
      targetUserId: actionData.targetUserId || null,
      scoreBefore: actionData.scoreBefore,
      scoreAfter: actionData.scoreAfter,
      confidence: actionData.confidence,
      evidenceRefs: actionData.evidenceRefs || null,
      actionTaken: actionData.actionTaken || null,
      result: actionData.result || null,
      notes: actionData.notes || null,
      preState: actionData.preState || null,
      postState: actionData.postState || null,
      payload: actionData
    };
    this.storeLogHistory(guildId, record);

    const embed = new EmbedBuilder()
      .setColor(this.getColorForAction(actionData))
      .setTitle(this.getTitleForAction(actionData))
      .setDescription(this.getDescriptionForAction(actionData))
      .addFields(
        { name: 'Server', value: guild.name, inline: true },
        { name: 'Server ID', value: guild.id, inline: true },
        { name: 'Action', value: actionData.type, inline: true },
        { name: 'Trace ID', value: traceId, inline: true },
        { name: 'Time', value: `<t:${Math.floor(timestamp / 1000)}:R>`, inline: true }
      )
      .setTimestamp();

    if (actionData.whitelisted) {
      embed.addFields({ name: 'Whitelist', value: 'WHITELISTED', inline: true });
    }

    if (typeof actionData.confidence === 'number') {
      embed.addFields({ name: 'Confidence', value: `${Math.round(actionData.confidence * 100)}%`, inline: true });
    }

    if (actionData.actionTaken) {
      embed.addFields({ name: 'Action Taken', value: actionData.actionTaken, inline: true });
    }

    if (actionData.result) {
      embed.addFields({ name: 'Result', value: actionData.result, inline: true });
    }

    if (typeof actionData.scoreBefore === 'number' || typeof actionData.scoreAfter === 'number') {
      embed.addFields({
        name: 'Beast Score',
        value: `${actionData.scoreBefore ?? 'N/A'} → ${actionData.scoreAfter ?? actionData.score ?? 'N/A'}`,
        inline: true
      });
    }

    if (actionData.evidenceRefs && actionData.evidenceRefs.length) {
      embed.addFields({
        name: 'Evidence',
        value: actionData.evidenceRefs.slice(0, 5).join('\n'),
        inline: false
      });
    }

    const userFieldIds = [
      { key: 'userId', label: 'User' },
      { key: 'executorId', label: 'Executor' },
      { key: 'targetUserId', label: 'Target' }
    ];

    for (const field of userFieldIds) {
      const id = actionData[field.key];
      if (!id) continue;
      const user = await this.client.users.fetch(id).catch(() => null);
      if (user) {
        embed.addFields({ name: field.label, value: `${user.tag} (${user.id})`, inline: false });
      } else {
        embed.addFields({ name: field.label, value: `${id}`, inline: false });
      }
    }

    if (actionData.channelId) {
      embed.addFields({ name: 'Channel', value: `<#${actionData.channelId}> (${actionData.channelId})`, inline: false });
    }

    if (actionData.roleId) {
      embed.addFields({ name: 'Role', value: `<@&${actionData.roleId}> (${actionData.roleId})`, inline: false });
    }

    if (actionData.botId) {
      embed.addFields({ name: 'Bot', value: `${actionData.botTag || actionData.botId} (${actionData.botId})`, inline: false });
    }

    // Send to log channel first; DM acts as fallback/secondary route based on policy.
    let channelAttempted = false;
    let channelSent = false;
    let channelFailed = false;
    const logChannel = await this.resolveLogChannel(guild);
    if (logChannel && typeof logChannel.send === 'function') {
      channelAttempted = true;
      try {
        await logChannel.send({ embeds: [embed] });
        channelSent = true;
      } catch (e) {
        channelFailed = true;
        console.error('Failed to send anti-nuke log message', e);
      }
    }

    if (this.shouldSendOwnerDmForAction(actionData, { channelAttempted, channelSent, channelFailed })) {
      try {
        const owner = await this.client.users.fetch(this.LOG_DM_ID);
        if (owner && typeof owner.send === 'function') {
          await owner.send({ embeds: [embed] });
        }
      } catch (_error) {
        // DM might be disabled
      }
    }
  }
  // Get color for action type
  getColorForAction(action) {
    if (action && action.whitelisted) {
      return this.COLORS.yellow;
    }
    switch (action.type) {
      case 'beast_mode_ban':
      case 'beast_mode_ban_failed':
      case 'rapid_action_ban':
      case 'rapid_action_ban_failed':
      case 'prune_ban':
      case 'prune_ban_failed':
      case 'bot_beast_mode_ban':
      case 'bot_beast_mode_ban_failed':
      case 'emergency_mode':
      case 'emergency_mode_failed':
      case 'emergency_mode_pending':
      case 'emergency_mode_confirm_denied':
      case 'mass_ban_lockdown_failed':
      case 'mass_ban_lockdown':
      case 'mass_ban_lockdown_pending':
      case 'mass_ban_lockdown_confirm_denied':
      case 'protective_ban':
      case 'protective_ban_failed':
        return this.COLORS.critical;
      case 'beast_mode_danger':
      case 'ban':
      case 'kick':
      case 'channelDelete':
      case 'roleDelete':
      case 'webhookCreate':
      case 'botAdd':
      case 'prune':
      case 'quarantine_applied':
      case 'quarantine_failed':
      case 'rapid_action_confirm_denied':
      case 'rapid_action_ignored':
      case 'beast_mode_confirm_denied':
      case 'rapid_action_simulated':
      case 'beast_mode_simulated':
        return this.COLORS.orange;
      case 'beast_mode_warning':
      case 'beast_mode_whitelisted':
      case 'rapid_action_whitelisted':
      case 'prune_whitelisted':
      case 'whitelist_pending':
        return this.COLORS.yellow;
      case 'backup_created':
      case 'backup_incremental_created':
      case 'manual_backup_created':
      case 'emergency_recover':
      case 'whitelist_add':
      case 'whitelist_remove':
      case 'log_channel_configured':
      case 'score_reset':
      case 'beast_mode_reset':
      case 'quarantine_removed':
      case 'strict_mode_enabled':
      case 'strict_mode_disabled':
      case 'aggressive_ban_enabled':
      case 'aggressive_ban_disabled':
      case 'quarantine_options_updated':
      case 'export_logs':
      case 'mass_ban_lockdown_simulated':
      case 'emergency_mode_simulated':
      case 'simulation_run':
        return this.COLORS.green;
      default:
        return this.COLORS.blue;
    }
  }

  // Get title for action type
  getTitleForAction(action) {
    switch (action.type) {
      case 'ban':
        return '⚠️ Ban Detected';
      case 'kick':
        return '⚠️ Kick Detected';
      case 'channelDelete':
        return '⚠️ Channel Deleted';
      case 'roleDelete':
        return '⚠️ Role Deleted';
      case 'webhookCreate':
        return '⚠️ Webhook Created';
      case 'botAdd':
        return '⚠️ Bot Added';
      case 'prune':
        return '⚠️ Member Prune Detected';
      case 'protective_ban':
        return '🔴 Protective Ban';
      case 'protective_ban_failed':
        return '⚠️ Protective Ban Failed';
      case 'quarantine_applied':
        return '🛑 Quarantine Applied';
      case 'quarantine_removed':
        return '✅ Quarantine Removed';
      case 'quarantine_failed':
        return '⚠️ Quarantine Failed';
      case 'beast_mode_ban':
        return '🔴 Beast Mode Ban';
      case 'beast_mode_ban_failed':
        return '⚠️ Beast Mode Ban Failed';
      case 'beast_mode_confirm_denied':
        return '🟠 Beast Mode Confirmation Denied';
      case 'beast_mode_simulated':
        return '🧪 Beast Mode Simulated';
      case 'rapid_action_ban':
        return '🔴 Rapid Action Ban';
      case 'rapid_action_ban_failed':
        return '⚠️ Rapid Action Ban Failed';
      case 'rapid_action_confirm_denied':
        return '🟠 Rapid Action Confirmation Denied';
      case 'rapid_action_ignored':
        return '🟠 Rapid Action Ignored';
      case 'rapid_action_simulated':
        return '🧪 Rapid Action Simulated';
      case 'beast_mode_warning':
        return '🟡 Beast Mode Warning';
      case 'beast_mode_danger':
        return '🟠 Beast Mode Danger';
      case 'beast_mode_whitelisted':
        return '🟡 Beast Mode (Whitelisted)';
      case 'rapid_action_whitelisted':
        return '🟡 Rapid Action (Whitelisted)';
      case 'prune_ban':
        return '🔴 Prune Ban';
      case 'prune_ban_failed':
        return '⚠️ Prune Ban Failed';
      case 'prune_whitelisted':
        return '🟡 Prune (Whitelisted)';
      case 'bot_beast_mode_ban':
        return '🔴 Bot Banned (Beast Mode)';
      case 'bot_beast_mode_ban_failed':
        return '⚠️ Bot Ban Failed (Beast Mode)';
      case 'emergency_mode':
        return '🚨 EMERGENCY MODE ACTIVATED';
      case 'emergency_mode_failed':
        return '⚠️ Emergency Mode Failed';
      case 'emergency_mode_pending':
        return '🟠 Emergency Mode Pending Approval';
      case 'emergency_mode_confirm_denied':
        return '🟠 Emergency Mode Denied';
      case 'emergency_mode_simulated':
        return '🧪 Emergency Mode Simulated';
      case 'mass_ban_lockdown':
        return '🚨 MASS BAN LOCKDOWN';
      case 'mass_ban_lockdown_failed':
        return '⚠️ Mass Ban Lockdown Failed';
      case 'mass_ban_lockdown_pending':
        return '🟠 Mass Ban Lockdown Pending';
      case 'mass_ban_lockdown_confirm_denied':
        return '🟠 Mass Ban Lockdown Denied';
      case 'mass_ban_lockdown_simulated':
        return '🧪 Mass Ban Lockdown Simulated';
      case 'backup_created':
        return '💾 Backup Created';
      case 'backup_incremental_created':
        return '💾 Incremental Backup Created';
      case 'manual_backup_created':
        return '💾 Manual Backup Created';
      case 'emergency_recover':
        return '✅ Emergency Recovery';
      case 'emergency_recover_failed':
        return '❌ Emergency Recovery Failed';
      case 'whitelist_pending':
        return '🟡 Whitelist Pending Approval';
      case 'whitelist_add':
        return '✅ Whitelist Approved';
      case 'whitelist_remove':
        return '➖ Whitelist Removed';
      case 'log_channel_configured':
        return '📝 Log Channel Configured';
      case 'score_reset':
        return '🔄 Score Reset';
      case 'beast_mode_reset':
        return '🔄 Beast Mode Reset';
      case 'strict_mode_enabled':
        return '🛑 Strict Mode Enabled';
      case 'strict_mode_disabled':
        return '✅ Strict Mode Disabled';
      case 'aggressive_ban_enabled':
        return '⚡ Aggressive Ban Enabled';
      case 'aggressive_ban_disabled':
        return '⚡ Aggressive Ban Disabled';
      case 'quarantine_options_updated':
        return '🛡️ Quarantine Options Updated';
      case 'export_logs':
        return '📤 Anti-Nuke Logs Exported';
      case 'simulation_run':
        return '🧪 Simulation Run';
      default:
        return '🔵 Anti-Nuke Action';
    }
  }

  // Get description for action type
  getDescriptionForAction(action) {
    switch (action.type) {
      case 'ban':
        return `Ban detected${action.targetId || action.targetUserId ? ` (target <@${action.targetId || action.targetUserId}>)` : ''}.`;
      case 'kick':
        return `Kick detected${action.targetId || action.targetUserId ? ` (target <@${action.targetId || action.targetUserId}>)` : ''}.`;
      case 'channelDelete':
        return `Channel deleted${action.channelName ? `: **${action.channelName}**` : ''}.`;
      case 'roleDelete':
        return `Role deleted${action.roleName ? `: **${action.roleName}**` : ''}.`;
      case 'webhookCreate':
        return 'Webhook created.';
      case 'botAdd':
        return `Bot added${action.botTag ? `: **${action.botTag}**` : ''}.`;
      case 'prune':
        return `Member prune detected${action.removed ? ` (${action.removed} members)` : ''}.`;
      case 'protective_ban':
        return `Protective ban executed for ${action.actionTaken || 'anti-nuke trigger'}.`;
      case 'protective_ban_failed':
        return `Failed to execute protective ban. ${action.error || ''}`.trim();
      case 'quarantine_applied':
        return 'User placed in quarantine role.';
      case 'quarantine_removed':
        return 'Quarantine role removed and roles restored.';
      case 'quarantine_failed':
        return `Failed to apply quarantine. ${action.error || ''}`.trim();
      case 'beast_mode_ban':
        return `User reached beast mode threshold (${action.score} points) and was banned.`;
      case 'beast_mode_ban_failed':
        return `Failed to ban user at ${action.score} points. ${action.error || ''}`.trim();
      case 'beast_mode_confirm_denied':
        return 'Beast mode protective action denied by admins.';
      case 'beast_mode_simulated':
        return `Simulated beast mode trigger at ${action.score} points.`;
      case 'rapid_action_ban':
        return `User performed ${action.count} rapid ${this.formatActionLabel(action.actionType)} actions.`;
      case 'rapid_action_ban_failed':
        return `Failed to ban user after rapid ${this.formatActionLabel(action.actionType)} detection. ${action.error || ''}`.trim();
      case 'rapid_action_confirm_denied':
        return `Rapid ${this.formatActionLabel(action.actionType)} action denied by admins.`;
      case 'rapid_action_ignored':
        return `Rapid ${this.formatActionLabel(action.actionType)} action ignored (${action.result || 'policy'}).`;
      case 'rapid_action_simulated':
        return `Simulated rapid ${this.formatActionLabel(action.actionType)} (${action.count} actions).`;
      case 'beast_mode_warning':
        return `User reached ${action.score} points (warning threshold).`;
      case 'beast_mode_danger':
        return `User reached ${action.score} points (danger threshold).`;
      case 'beast_mode_whitelisted':
        return `User reached beast mode threshold (${action.score} points) but is whitelisted.`;
      case 'rapid_action_whitelisted':
        return `User triggered rapid action detection (${action.count} ${this.formatActionLabel(action.actionType)}) but is whitelisted.`;
      case 'prune_ban':
        return `Executor banned for member prune${action.removed ? ` (${action.removed} removed)` : ''}.`;
      case 'prune_ban_failed':
        return `Failed to ban executor for member prune. ${action.error || ''}`.trim();
      case 'prune_whitelisted':
        return `Member prune detected but executor is whitelisted${action.removed ? ` (${action.removed} removed)` : ''}.`;
      case 'bot_beast_mode_ban':
        return `Bot banned after beast mode trigger (${action.botTag || action.botId}).`;
      case 'bot_beast_mode_ban_failed':
        return `Failed to ban bot after beast mode trigger. ${action.error || ''}`.trim();
      case 'emergency_mode':
        return action.details && action.details.threshold
          ? `Emergency mode activated (${action.details.count}/${action.details.threshold.count} bans in ${Math.round(action.details.threshold.time / 1000)}s).`
          : 'Critical attack threshold reached. Server locked down.';
      case 'emergency_mode_pending':
        return 'Emergency mode requires admin confirmation before lockdown.';
      case 'emergency_mode_confirm_denied':
        return 'Emergency mode lockdown denied by admins.';
      case 'emergency_mode_simulated':
        return 'Simulated emergency mode trigger.';
      case 'emergency_mode_failed':
        return `Failed to activate emergency mode. ${action.error || ''}`.trim();
      case 'mass_ban_lockdown':
        return `Mass ban detected (${action.banCount} bans). All dangerous permissions removed.`;
      case 'mass_ban_lockdown_failed':
        return `Failed to apply mass ban lockdown. ${action.error || ''}`.trim();
      case 'mass_ban_lockdown_pending':
        return `Mass ban lockdown pending admin confirmation (${action.banCount} bans).`;
      case 'mass_ban_lockdown_confirm_denied':
        return 'Mass ban lockdown denied by admins.';
      case 'mass_ban_lockdown_simulated':
        return `Simulated mass ban lockdown (${action.banCount} bans).`;
      case 'backup_created':
        return `Server backup created: ${action.rolesCount} roles, ${action.channelsCount} channels.`;
      case 'backup_incremental_created':
        return `Incremental backup created: ${action.rolesCount} roles, ${action.channelsCount} channels.`;
      case 'manual_backup_created':
        return 'Manual backup created by administrator.';
      case 'emergency_recover':
        return 'Emergency recovery completed. Permissions restored.';
      case 'emergency_recover_failed':
        return `Emergency recovery failed. ${action.error || ''}`.trim();
      case 'whitelist_pending':
        return `Whitelist request pending: ${action.approvals}/${action.required} approvals.`;
      case 'whitelist_add':
        return 'User added to whitelist after admin approval.';
      case 'whitelist_remove':
        return 'User removed from whitelist.';
      case 'log_channel_configured':
        return `Log channel set to <#${action.channelId}>.`;
      case 'score_reset':
        return action.targetUserId ? 'Beast mode score reset for user.' : 'Beast mode scores reset for all users.';
      case 'beast_mode_reset':
        return `Beast mode score reset${action.reason ? ` (${action.reason})` : ''}.`;
      case 'strict_mode_enabled':
        return 'Strict mode enabled.';
      case 'strict_mode_disabled':
        return 'Strict mode disabled.';
      case 'aggressive_ban_enabled':
        return 'Aggressive ban mode enabled.';
      case 'aggressive_ban_disabled':
        return 'Aggressive ban mode disabled.';
      case 'quarantine_options_updated':
        return 'Quarantine configuration updated.';
      case 'export_logs':
        return `Anti-nuke logs exported (${action.count || 0} entries).`;
      case 'simulation_run': {
        const count = typeof action.count === 'number' ? action.count : 0;
        const label = action.actionType ? this.formatActionLabel(action.actionType) : 'actions';
        const windowText = action.windowSeconds ? `${action.windowSeconds}s` : 'unknown window';
        return `Simulated ${count} ${label} actions over ${windowText}.`;
      }
      default:
        return 'Anti-nuke action detected.';
    }
  }

  async refreshSharedGlobalState() {
    if (this.stateBackend !== 'db') return;
    const db = this.getStateDb();
    if (!db) return;
    try {
      const row = await db.get('SELECT payload, updated_at FROM antinuke_state WHERE key = ?', 'global');
      if (!row || !row.payload) return;
      const updatedAt = Number(row.updated_at) || 0;
      if (updatedAt && updatedAt <= this.lastGlobalStateUpdatedAt) return;
      const payload = JSON.parse(row.payload);
      if (payload && Array.isArray(payload.whitelist)) {
        this.whitelist = new Set(payload.whitelist);
      }
      if (updatedAt) this.lastGlobalStateUpdatedAt = updatedAt;
    } catch (e) {
      console.error('Failed to refresh anti-nuke global state:', e);
    }
  }

  // Start automated tasks
  startAutomatedTasks() {
    // Cleanup task - runs every hour
    setInterval(() => {
      this.cleanupOldData();
    }, 3600000); // 1 hour

    // Incremental backups - runs hourly, offset from full backup cadence to avoid overlap spam.
    const incrementalIntervalMs = 3600000;
    const incrementalStartOffsetMs = Number.parseInt(
      process.env.ANTINUKE_INCREMENTAL_BACKUP_START_OFFSET_MS || '300000',
      10
    );
    const normalizedIncrementalOffsetMs = Number.isFinite(incrementalStartOffsetMs)
      ? Math.max(0, incrementalStartOffsetMs)
      : 300000;
    setTimeout(() => {
      this.createIncrementalBackups();
      setInterval(() => {
        this.createIncrementalBackups();
      }, incrementalIntervalMs);
    }, incrementalIntervalMs + normalizedIncrementalOffsetMs);

    // Backup task - runs every 6 hours
    setInterval(() => {
      this.createAutomaticBackups();
    }, 21600000); // 6 hours

    const refreshMs = Number.parseInt(process.env.ANTINUKE_STATE_REFRESH_MS || '60000', 10);
    if (this.stateBackend === 'db' && refreshMs > 0) {
      setInterval(() => {
        this.refreshSharedGlobalState().catch(e => {
          console.error('Failed to refresh shared anti-nuke state:', e);
        });
      }, refreshMs);
    }

    console.log('⏰ Automated tasks started (cleanup + backups)');
  }

  // Clean up old data
  cleanupOldData() {
    const now = Date.now();
    const oneDayAgo = now - this.BEAST_MODE_WINDOW;

    // Clean action tracker
    for (const guildTracker of this.actionTracker.values()) {
      for (const [userId, actions] of guildTracker) {
        const filteredActions = actions.filter(action => action.timestamp > oneDayAgo);
        if (filteredActions.length === 0) {
          guildTracker.delete(userId);
        } else {
          guildTracker.set(userId, filteredActions);
        }
      }
    }

    // Clean beast mode actions + scores
    for (const [guildId, userMap] of this.beastModeActions.entries()) {
      const scoreMap = this.getGuildMap(this.beastModeTracker, guildId);
      for (const [userId, entry] of userMap.entries()) {
        const trimmed = (entry.actions || []).filter(action => action.timestamp > oneDayAgo);
        if (trimmed.length === 0) {
          userMap.delete(userId);
          scoreMap.delete(userId);
        } else {
          entry.actions = trimmed;
          const score = trimmed.reduce((sum, action) => sum + (this.POINTS[action.type] || 0), 0);
          scoreMap.set(userId, score);
          const level = this.getScoreLevel(score);
          entry.lastLevel = level === 'safe' ? null : level;
          userMap.set(userId, entry);
        }
      }
      if (userMap.size === 0) {
        this.beastModeActions.delete(guildId);
      }
      if (scoreMap.size === 0) {
        this.beastModeTracker.delete(guildId);
      }
    }

    // Clean ban tracker (24h window)
    for (const [guildId, timestamps] of this.banTracker.entries()) {
      const filtered = timestamps.filter(ts => ts > now - this.BAN_DAY_WINDOW);
      if (filtered.length === 0) {
        this.banTracker.delete(guildId);
      } else {
        this.banTracker.set(guildId, filtered);
      }
    }

    // Clean join tracker (raid window)
    const joinWindow = this.THRESHOLDS.joinRaid && this.THRESHOLDS.joinRaid.time
      ? this.THRESHOLDS.joinRaid.time
      : 15000;
    for (const [guildId, timestamps] of this.joinTracker.entries()) {
      const filtered = timestamps.filter(ts => ts > now - joinWindow);
      if (filtered.length === 0) {
        this.joinTracker.delete(guildId);
      } else {
        this.joinTracker.set(guildId, filtered);
      }
    }

    // Clean webhook audit tracker
    for (const [guildId, logMap] of this.webhookAuditTracker.entries()) {
      for (const [logId, ts] of logMap.entries()) {
        if (now - ts > this.WEBHOOK_DEDUPE_WINDOW) {
          logMap.delete(logId);
        }
      }
      if (logMap.size === 0) {
        this.webhookAuditTracker.delete(guildId);
      }
    }

    // Clean processed audit action dedupe tracker
    for (const [guildId, logMap] of this.auditActionTracker.entries()) {
      for (const [logId, ts] of logMap.entries()) {
        if (now - ts > this.AUDIT_ACTION_DEDUPE_WINDOW) {
          logMap.delete(logId);
        }
      }
      if (logMap.size === 0) {
        this.auditActionTracker.delete(guildId);
      }
    }

    // Clean pending whitelist requests
    for (const [guildId, pending] of this.pendingWhitelist.entries()) {
      for (const [userId, entry] of pending.entries()) {
        if (now - entry.createdAt > this.PENDING_WHITELIST_TTL) {
          pending.delete(userId);
        }
      }
      if (pending.size === 0) {
        this.pendingWhitelist.delete(guildId);
      }
    }

    // Restore expired quarantine assignments
    for (const [guildId, assignments] of this.quarantineAssignments.entries()) {
      for (const [userId, entry] of assignments.entries()) {
        if (entry.expiresAt && entry.expiresAt <= now) {
          const guild = this.client.guilds.cache.get(guildId);
          if (guild) {
            this.restoreQuarantine(guild, userId, 'quarantine_expired').catch((e) => {
              console.error('Failed to restore quarantine roles', e);
            });
          } else {
            assignments.delete(userId);
          }
        }
      }
      if (assignments.size === 0) {
        this.quarantineAssignments.delete(guildId);
      }
    }

    console.log('🧹 Anti-nuke data cleanup completed');
  }

  // Create automatic backups
  async createAutomaticBackups() {
    for (const guild of this.client.guilds.cache.values()) {
      try {
        await this.createBackup(guild, { type: 'full' });
      } catch (error) {
        console.error(`Failed to create backup for ${guild.name}:`, error);
      }
    }

    console.log('💾 Automatic backups completed');
  }

  // Create incremental backups
  async createIncrementalBackups() {
    for (const guild of this.client.guilds.cache.values()) {
      try {
        await this.createBackup(guild, { type: 'incremental' });
      } catch (error) {
        console.error(`Failed to create incremental backup for ${guild.name}:`, error);
      }
    }
  }

  // Check if user is owner
  isOwner(userId) {
    return userId === this.OWNER_ID;
  }

  getGuildWhitelistSet(guildId, create = false) {
    if (!guildId) return null;
    if (!this.whitelistByGuild.has(guildId)) {
      if (!create) return null;
      this.whitelistByGuild.set(guildId, new Set());
    }
    return this.whitelistByGuild.get(guildId);
  }

  getAllWhitelistedUsers() {
    const union = new Set(this.whitelist);
    for (const users of this.whitelistByGuild.values()) {
      for (const userId of users || []) union.add(userId);
    }
    return union;
  }

  isProtectedUser(userId, guildId = null) {
    if (!userId) return false;
    if (this.client && this.client.user && userId === this.client.user.id) return true;
    return this.isWhitelisted(userId, guildId);
  }

  // Check if user is whitelisted
  isWhitelisted(userId, guildId = null) {
    if (!userId) return false;
    if (guildId) {
      const users = this.getGuildWhitelistSet(guildId, false);
      return !!(users && users.has(userId));
    }
    return this.getAllWhitelistedUsers().has(userId);
  }

  // Add to whitelist
  addToWhitelist(guildIdOrUserId, maybeUserId) {
    let guildId = null;
    let userId = null;
    if (maybeUserId !== undefined && maybeUserId !== null) {
      guildId = guildIdOrUserId;
      userId = maybeUserId;
    } else {
      userId = guildIdOrUserId;
    }

    if (!userId) return;

    if (guildId) {
      const guildWhitelist = this.getGuildWhitelistSet(guildId, true);
      guildWhitelist.add(userId);
    } else {
      this.whitelist.add(userId);
    }

    for (const guildPending of this.pendingWhitelist.values()) {
      guildPending.delete(userId);
    }
    this.saveData();
  }

  // Remove from whitelist
  removeFromWhitelist(guildIdOrUserId, maybeUserId) {
    let guildId = null;
    let userId = null;
    if (maybeUserId !== undefined && maybeUserId !== null) {
      guildId = guildIdOrUserId;
      userId = maybeUserId;
    } else {
      userId = guildIdOrUserId;
    }

    if (!userId) return;

    if (guildId) {
      const guildWhitelist = this.getGuildWhitelistSet(guildId, false);
      if (guildWhitelist) {
        guildWhitelist.delete(userId);
        if (guildWhitelist.size === 0) this.whitelistByGuild.delete(guildId);
      }
      const guildPending = this.pendingWhitelist.get(guildId);
      if (guildPending) {
        guildPending.delete(userId);
        if (guildPending.size === 0) this.pendingWhitelist.delete(guildId);
      }
    } else {
      this.whitelist.delete(userId);
      for (const guildPending of this.pendingWhitelist.values()) {
        guildPending.delete(userId);
      }
      for (const [gId, guildUsers] of this.whitelistByGuild.entries()) {
        guildUsers.delete(userId);
        if (guildUsers.size === 0) this.whitelistByGuild.delete(gId);
      }
    }

    this.saveData();
  }

  // Get whitelist
  getWhitelist(guildId = null) {
    if (!guildId) return Array.from(this.getAllWhitelistedUsers());
    const guildWhitelist = this.getGuildWhitelistSet(guildId, false);
    if (!guildWhitelist) return [];
    return Array.from(guildWhitelist);
  }

  getPendingWhitelist(guildId) {
    const guildPending = this.pendingWhitelist.get(guildId);
    if (!guildPending) return [];
    return Array.from(guildPending.entries()).map(([userId, entry]) => ({
      userId,
      approvals: entry.approvers ? entry.approvers.size : 0,
      required: this.WHITELIST_APPROVALS_REQUIRED,
      createdAt: entry.createdAt,
      requestedBy: entry.requestedBy || null
    }));
  }

  requestWhitelistAdd(guildId, userId, approverId) {
    if (!guildId || !userId || !approverId) {
      return { status: 'invalid' };
    }

    if (this.isWhitelisted(userId, guildId)) {
      return { status: 'already' };
    }

    const guildPending = this.getGuildMap(this.pendingWhitelist, guildId);
    const now = Date.now();
    let entry = guildPending.get(userId);
    if (entry && now - entry.createdAt > this.PENDING_WHITELIST_TTL) {
      entry = null;
    }

    if (!entry) {
      entry = {
        approvers: new Set(),
        createdAt: now,
        requestedBy: approverId
      };
    }

    const alreadyApproved = entry.approvers.has(approverId);
    entry.approvers.add(approverId);
    const approvals = entry.approvers.size;
    const required = this.WHITELIST_APPROVALS_REQUIRED;

    if (approvals >= required) {
      this.addToWhitelist(guildId, userId);
      guildPending.delete(userId);
      return {
        status: 'approved',
        approvals,
        required,
        alreadyApproved
      };
    }

    guildPending.set(userId, entry);
    this.saveData();
    return {
      status: 'pending',
      approvals,
      required,
      alreadyApproved,
      requestedBy: entry.requestedBy,
      createdAt: entry.createdAt
    };
  }

  cancelWhitelistRequest(guildId, userId) {
    const guildPending = this.pendingWhitelist.get(guildId);
    if (!guildPending) return false;
    const removed = guildPending.delete(userId);
    if (guildPending.size === 0) {
      this.pendingWhitelist.delete(guildId);
    }
    if (removed) {
      this.saveData();
    }
    return removed;
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
    const banTimestamps = this.banTracker.get(guildId) || [];
    const bansLastHour = this.getWindowCount(banTimestamps, this.BAN_WINDOW);
    const bansLastDay = this.getWindowCount(banTimestamps, this.BAN_DAY_WINDOW);
    const isEmergency = this.emergencyMode.get(guildId) || false;
    const emergencyLockdownUntil = this.emergencyLockdownUntil.get(guildId) || null;
    const backupStore = this.getBackupStore(guildId);
    const latestBackup = backupStore && backupStore.latestId
      ? [...backupStore.full, ...backupStore.incremental].find(entry => entry.id === backupStore.latestId)
      : null;
    const backupTimestamp = latestBackup ? latestBackup.timestamp : null;
    const backupRoles = latestBackup && latestBackup.counts ? latestBackup.counts.roles : 0;
    const backupChannels = latestBackup && latestBackup.counts ? latestBackup.counts.channels : 0;
    const backupThreads = latestBackup && latestBackup.counts ? latestBackup.counts.threads || 0 : 0;
    const backupEmojis = latestBackup && latestBackup.counts ? latestBackup.counts.emojis || 0 : 0;
    const backupStickers = latestBackup && latestBackup.counts ? latestBackup.counts.stickers || 0 : 0;
    const backupBans = latestBackup && latestBackup.counts ? latestBackup.counts.bans || 0 : 0;
    const backupId = latestBackup ? latestBackup.id : null;
    const backupEncrypted = latestBackup ? !!latestBackup.encrypted : false;
    const pendingWhitelist = this.pendingWhitelist.get(guildId);
    const config = this.getGuildConfig(guildId);
    const history = this.logHistory.get(guildId) || [];
    const memberCount = this.getGuildMemberCount(guildId);
    const thresholdScale = this.getThresholdScale(guildId);

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
      totalWhitelistedUsers: this.getWhitelist(guildId).length,
      bansLastHour,
      bansLastDay,
      totalActions,
      isEmergency,
      emergencyLockdownUntil,
      hasBackup: !!backupId,
      backupTimestamp,
      backupRoles,
      backupChannels,
      backupThreads,
      backupEmojis,
      backupStickers,
      backupBans,
      backupId,
      backupEncrypted,
      logChannel: this.logChannels.get(guildId) || null,
      pendingWhitelist: pendingWhitelist ? pendingWhitelist.size : 0,
      beastModeScores: guildScores ? Object.fromEntries(guildScores) : {},
      strictMode: config.strictMode,
      strictActive: config.strictActive,
      aggressiveBan: config.aggressiveBan,
      quarantineMode: config.quarantine?.mode || 'quarantine',
      quarantinePreserveView: config.quarantine?.preserveView || false,
      quarantineDuration: config.quarantine?.durationMs || this.QUARANTINE_DURATION,
      autoActionThreshold: config.autoActionThreshold || this.AUTO_ACTION_THRESHOLD,
      logHistoryCount: history.length,
      memberCount,
      thresholdScale,
      beastModeWindow: this.BEAST_MODE_WINDOW
    };
  }

  // Get user score
  getUserScore(guildId, userId) {
    const guildScores = this.beastModeTracker.get(guildId);
    if (guildScores && guildScores.has(userId)) {
      return guildScores.get(userId) || 0;
    }
    const guildActions = this.beastModeActions.get(guildId);
    const entry = guildActions ? guildActions.get(userId) : null;
    if (!entry) return 0;
    const score = (entry.actions || []).reduce((sum, action) => sum + (this.POINTS[action.type] || 0), 0);
    const scores = this.getGuildMap(this.beastModeTracker, guildId);
    scores.set(userId, score);
    return score;
  }

  getRecentBeastActions(guildId, userId, limit = 8) {
    const guildActions = this.beastModeActions.get(guildId);
    if (!guildActions) return [];
    const entry = guildActions.get(userId);
    if (!entry || !Array.isArray(entry.actions)) return [];
    const sorted = [...entry.actions].sort((a, b) => b.timestamp - a.timestamp);
    return sorted.slice(0, limit).map(action => ({
      type: action.type,
      timestamp: action.timestamp,
      points: this.POINTS[action.type] || 0
    }));
  }

  resetUserScore(guildId, userId, reason = null) {
    const guildScores = this.beastModeTracker.get(guildId);
    if (guildScores) {
      guildScores.set(userId, 0);
    }
    const guildActions = this.beastModeActions.get(guildId);
    if (guildActions) {
      guildActions.delete(userId);
    }
    this.saveData();

    if (reason) {
      this.logAction(guildId, {
        type: 'beast_mode_reset',
        userId,
        reason
      });
    }
  }

  // Reset scores
  resetScores(guildId, userId = null) {
    if (userId) {
      this.resetUserScore(guildId, userId, 'manual_reset');
      return;
    }

    const guildScores = this.beastModeTracker.get(guildId);
    if (guildScores) guildScores.clear();
    const guildActions = this.beastModeActions.get(guildId);
    if (guildActions) guildActions.clear();
    this.saveData();
  }

  // Emergency recovery
  async emergencyRecover(guildId, backupId = null, options = {}) {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) {
      throw new Error('Guild not found');
    }

    const force = !!options.force;
    const executorId = options.executorId || null;
    const sourceGuildId = options.sourceGuildId ? String(options.sourceGuildId) : guildId;
    const isCrossGuildRecover = sourceGuildId !== guildId;

    if (isCrossGuildRecover && !this.isOwner(executorId)) {
      throw new Error('Cross-server recovery is restricted to the bot owner.');
    }

    const lockdownUntil = this.emergencyLockdownUntil.get(guildId) || null;
    if (!isCrossGuildRecover) {
      if (!force && this.emergencyMode.get(guildId) && lockdownUntil && Date.now() < lockdownUntil) {
        if (!this.isOwner(executorId)) {
          throw new Error('Emergency lockdown is still active; only the bot owner can recover early.');
        }
      }
      if (!force && !this.emergencyMode.get(guildId)) {
        throw new Error('Server is not in emergency mode');
      }
    }

    const snapshot = this.getBackupSnapshot(sourceGuildId, backupId);
    if (!snapshot) {
      throw new Error('Backup not found');
    }

    const traceId = options.traceId || this.createTraceId();

    try {
      const toArray = (source) => {
        if (!source) return [];
        if (Array.isArray(source)) return source;
        if (typeof source.values === 'function') return Array.from(source.values());
        if (typeof source.forEach === 'function') {
          const out = [];
          source.forEach((value) => out.push(value));
          return out;
        }
        return [];
      };

      const isThreadType = (channelType) => channelType === 10 || channelType === 11 || channelType === 12;

      const toImageBuffer = async (url) => {
        if (!url || typeof fetch !== 'function') return null;
        try {
          const response = await fetch(url);
          if (!response || !response.ok) return null;
          const arrayBuffer = await response.arrayBuffer();
          return Buffer.from(arrayBuffer);
        } catch (_e) {
          return null;
        }
      };

      let rolesRestored = 0;
      let rolesCreated = 0;
      let rolesSkipped = 0;
      let rolesFailed = 0;
      let channelsRestored = 0;
      let channelsFailed = 0;
      let channelsMissing = 0;
      let channelsCreated = 0;
      let channelsReused = 0;
      let threadsCreated = 0;
      let threadsFailed = 0;
      let threadsMissing = 0;
      let emojisRestored = 0;
      let emojisFailed = 0;
      let stickersRestored = 0;
      let stickersFailed = 0;
      let bansRestored = 0;
      let bansFailed = 0;
      let onboardingRestored = false;
      let guildMetaRestored = false;

      const recoveryMapping = this.getRecoveryMapping(guildId);
      const mapRoleId = (rawId) => {
        if (!rawId) return rawId;
        const mapped = recoveryMapping && recoveryMapping.roles ? recoveryMapping.roles.get(String(rawId)) : null;
        return mapped || String(rawId);
      };
      const mapChannelId = (rawId) => {
        if (!rawId) return rawId;
        const mapped = recoveryMapping && recoveryMapping.channels ? recoveryMapping.channels.get(String(rawId)) : null;
        return mapped || String(rawId);
      };
      const resolveOverwriteTargetId = (overwrite) => {
        if (!overwrite || !overwrite.id) return null;
        const rawType = overwrite.type;
        const normalizedType = rawType === 0 || rawType === 'role' ? 'role' : rawType === 1 || rawType === 'member' ? 'member' : null;
        if (normalizedType === 'role') {
          const mappedRoleId = mapRoleId(overwrite.id);
          return guild.roles && guild.roles.cache && guild.roles.cache.has(mappedRoleId)
            ? mappedRoleId
            : null;
        }
        return String(overwrite.id);
      };
      const sourceEveryoneRoleId = snapshot && snapshot.guildMeta && snapshot.guildMeta.id
        ? String(snapshot.guildMeta.id)
        : String(sourceGuildId);
      if (recoveryMapping && recoveryMapping.roles && guild.roles && guild.roles.everyone) {
        recoveryMapping.roles.set(sourceEveryoneRoleId, String(guild.roles.everyone.id));
        recoveryMapping.roles.set(String(sourceGuildId), String(guild.roles.everyone.id));
      }

      if (options.restoreGuildMeta !== false && snapshot.guildMeta && typeof guild.edit === 'function') {
        try {
          const meta = snapshot.guildMeta;
          const guildEditPayload = {};
          if (meta.name) guildEditPayload.name = meta.name;
          if (meta.description !== undefined) guildEditPayload.description = meta.description;
          if (meta.preferredLocale !== undefined) guildEditPayload.preferredLocale = meta.preferredLocale;
          if (meta.verificationLevel !== undefined) guildEditPayload.verificationLevel = meta.verificationLevel;
          if (meta.explicitContentFilter !== undefined) guildEditPayload.explicitContentFilter = meta.explicitContentFilter;
          if (meta.defaultMessageNotifications !== undefined) guildEditPayload.defaultMessageNotifications = meta.defaultMessageNotifications;
          if (Number.isFinite(meta.afkTimeout)) guildEditPayload.afkTimeout = meta.afkTimeout;
          if (meta.afkChannelId) guildEditPayload.afkChannel = mapChannelId(meta.afkChannelId);
          if (meta.systemChannelId) guildEditPayload.systemChannel = mapChannelId(meta.systemChannelId);
          if (meta.rulesChannelId) guildEditPayload.rulesChannel = mapChannelId(meta.rulesChannelId);
          if (meta.publicUpdatesChannelId) guildEditPayload.publicUpdatesChannel = mapChannelId(meta.publicUpdatesChannelId);
          if (meta.safetyAlertsChannelId) guildEditPayload.safetyAlertsChannel = mapChannelId(meta.safetyAlertsChannelId);

          if (options.restoreGuildAssets !== false) {
            const [icon, banner, splash, discoverySplash] = await Promise.all([
              toImageBuffer(meta.iconURL),
              toImageBuffer(meta.bannerURL),
              toImageBuffer(meta.splashURL),
              toImageBuffer(meta.discoverySplashURL)
            ]);
            if (icon) guildEditPayload.icon = icon;
            if (banner) guildEditPayload.banner = banner;
            if (splash) guildEditPayload.splash = splash;
            if (discoverySplash) guildEditPayload.discoverySplash = discoverySplash;
          }

          if (Object.keys(guildEditPayload).length > 0) {
            await guild.edit(guildEditPayload);
            guildMetaRestored = true;
          }
        } catch (e) {
          console.error('Emergency recover: failed to restore guild metadata', { guildId, sourceGuildId, error: e });
        }
      }

      // Restore roles (permissions in batches; positions in a bulk call)
      const rolePermissionTasks = [];
      const positionUpdates = [];
      const sortedRoles = [...(snapshot.roles || [])].sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
      for (const roleData of sortedRoles) {
        if (!roleData || !roleData.id) continue;
        const isSourceEveryone = String(roleData.id) === sourceEveryoneRoleId;

        let role = isSourceEveryone && guild.roles && guild.roles.everyone
          ? guild.roles.everyone
          : guild.roles.cache.get(roleData.id);
        if (!role && recoveryMapping && recoveryMapping.roles) {
          const mappedRoleId = recoveryMapping.roles.get(roleData.id);
          if (mappedRoleId) {
            role = guild.roles.cache.get(mappedRoleId) || null;
          }
        }

        if (!role && !isSourceEveryone && options.recreateMissingRoles !== false && guild.roles && typeof guild.roles.create === 'function') {
          try {
            role = await guild.roles.create({
              name: roleData.name || 'Recovered Role',
              color: roleData.color,
              hoist: !!roleData.hoist,
              mentionable: !!roleData.mentionable,
              permissions: roleData.permissions || '0',
              reason: `Recovered from anti-nuke backup (${sourceGuildId})`
            });
            rolesCreated++;
          } catch (e) {
            console.error('Emergency recover: failed to recreate role', { roleId: roleData.id, error: e });
          }
        }

        if (role && recoveryMapping && recoveryMapping.roles) {
          recoveryMapping.roles.set(String(roleData.id), String(role.id));
        }

        if (!role) continue;
        if (!role.editable) {
          rolesSkipped++;
          continue;
        }

        rolePermissionTasks.push(async () => {
          try {
            await role.edit({
              name: roleData.name || role.name,
              color: roleData.color,
              hoist: !!roleData.hoist,
              mentionable: !!roleData.mentionable,
              permissions: roleData.permissions || role.permissions
            });
            rolesRestored++;
          } catch (e) {
            rolesFailed++;
            console.error('Emergency recover: failed to restore role permissions', { roleId: role.id, error: e });
          }
        });

        // @everyone cannot be moved; avoid position edit to prevent 50013
        if (role.id !== guild.id && Number.isFinite(roleData.position)) {
          positionUpdates.push({ role, position: roleData.position });
        }
      }

      const roleBatchSize = 5;
      for (let i = 0; i < rolePermissionTasks.length; i += roleBatchSize) {
        const batch = rolePermissionTasks.slice(i, i + roleBatchSize);
        await Promise.all(batch.map(fn => fn()));
      }

      if (positionUpdates.length && guild.roles && typeof guild.roles.setPositions === 'function') {
        try {
          await guild.roles.setPositions(positionUpdates);
        } catch (e) {
          console.error('Emergency recover: failed to restore role positions', { error: e });
        }
      }

      // Restore channel permissions
      for (const channelData of snapshot.channels || []) {
        if (!channelData || isThreadType(channelData.type)) continue;

        let channel = guild.channels.cache.get(channelData.id);
        if (!channel && recoveryMapping && recoveryMapping.channels) {
          const mappedId = recoveryMapping.channels.get(channelData.id);
          if (mappedId) {
            channel = guild.channels.cache.get(mappedId);
            if (channel) {
              channelsReused++;
            } else {
              recoveryMapping.channels.delete(channelData.id);
            }
          }
        }
        try {
          const overwritePayload = (channelData.permissionOverwrites || [])
            .filter(ow => ow && ow.id)
            .map(ow => ({
              id: resolveOverwriteTargetId(ow),
              allow: ow.allow,
              deny: ow.deny,
              type: ow.type
            }))
            .filter(ow => !!ow.id);

          if (!channel && options.recreateMissingChannels !== false) {
            try {
              const createPayload = {
                name: channelData.name || 'recovered-channel',
                type: channelData.type
              };
              if (Number.isFinite(channelData.position)) createPayload.position = channelData.position;
              if (channelData.parentId) {
                const parent = guild.channels.cache.get(mapChannelId(channelData.parentId));
                if (parent) createPayload.parent = parent;
              }
              if (channelData.topic != null) createPayload.topic = channelData.topic;
              if (channelData.nsfw != null) createPayload.nsfw = channelData.nsfw;
              if (channelData.rateLimitPerUser != null) createPayload.rateLimitPerUser = channelData.rateLimitPerUser;
              if (channelData.bitrate != null) createPayload.bitrate = channelData.bitrate;
              if (channelData.userLimit != null) createPayload.userLimit = channelData.userLimit;
              if (channelData.rtcRegion != null) createPayload.rtcRegion = channelData.rtcRegion;
              if (channelData.videoQualityMode != null) createPayload.videoQualityMode = channelData.videoQualityMode;
              if (channelData.defaultAutoArchiveDuration != null) createPayload.defaultAutoArchiveDuration = channelData.defaultAutoArchiveDuration;
              if (channelData.defaultThreadRateLimitPerUser != null) createPayload.defaultThreadRateLimitPerUser = channelData.defaultThreadRateLimitPerUser;
              if (channelData.defaultSortOrder != null) createPayload.defaultSortOrder = channelData.defaultSortOrder;
              if (channelData.defaultForumLayout != null) createPayload.defaultForumLayout = channelData.defaultForumLayout;
              if (channelData.defaultReactionEmoji != null) createPayload.defaultReactionEmoji = channelData.defaultReactionEmoji;
              if (Array.isArray(channelData.availableTags) && channelData.availableTags.length) {
                createPayload.availableTags = channelData.availableTags.map(tag => ({
                  name: tag.name || 'tag',
                  moderated: !!tag.moderated,
                  emojiId: tag.emojiId || null,
                  emojiName: tag.emojiName || null
                }));
              }
              if (overwritePayload.length) createPayload.permissionOverwrites = overwritePayload;

              channel = await guild.channels.create(createPayload);
              channelsCreated++;
              if (recoveryMapping && recoveryMapping.channels) {
                recoveryMapping.channels.set(channelData.id, channel.id);
              }
            } catch (e) {
              channelsFailed++;
              console.error('Emergency recover: failed to recreate channel', { channelId: channelData.id, error: e });
              continue;
            }
          }

          if (!channel) {
            channelsMissing++;
            continue;
          }

          // Apply full overwrite set in a single request to avoid a mid-run "public channel" state.
          // This replaces channel overwrites without first deleting them one-by-one.
          if (channel.permissionOverwrites && typeof channel.permissionOverwrites.set === 'function') {
            await channel.permissionOverwrites.set(overwritePayload);
          }
          channelsRestored++;
        } catch (e) {
          channelsFailed++;
          console.error('Emergency recover: failed to restore channel overwrites', {
            channelId: channel && channel.id ? channel.id : channelData.id,
            error: e
          });
        }
      }

      if (options.restoreThreads !== false) {
        for (const threadData of snapshot.threads || []) {
          if (!threadData || !threadData.parentId) {
            threadsMissing++;
            continue;
          }

          const mappedParentId = mapChannelId(threadData.parentId);
          const parent = mappedParentId ? guild.channels.cache.get(mappedParentId) : null;
          if (!parent || !parent.threads || typeof parent.threads.create !== 'function') {
            threadsMissing++;
            continue;
          }

          try {
            const threadPayload = {
              name: threadData.name || 'Recovered Thread',
              reason: `Recovered from anti-nuke backup (${sourceGuildId})`
            };
            if (threadData.autoArchiveDuration != null) threadPayload.autoArchiveDuration = threadData.autoArchiveDuration;
            if (threadData.rateLimitPerUser != null) threadPayload.rateLimitPerUser = threadData.rateLimitPerUser;
            if (threadData.type != null && threadData.type !== 10) threadPayload.type = threadData.type;
            if (threadData.invitable != null) threadPayload.invitable = !!threadData.invitable;
            if (parent.type === 15) {
              threadPayload.message = { content: 'Recovered forum post placeholder.' };
            }

            const thread = await parent.threads.create(threadPayload);
            threadsCreated++;
            if (recoveryMapping && recoveryMapping.channels && thread && thread.id && threadData.id) {
              recoveryMapping.channels.set(String(threadData.id), String(thread.id));
            }
          } catch (e) {
            threadsFailed++;
            console.error('Emergency recover: failed to recreate thread', { threadId: threadData.id, error: e });
          }
        }
      }

      if (options.restoreAssets !== false) {
        if (guild.emojis && typeof guild.emojis.create === 'function') {
          const existingEmojiNames = new Set(toArray(guild.emojis.cache).map(emoji => emoji.name).filter(Boolean));
          for (const emojiData of snapshot.emojis || []) {
            if (!emojiData || !emojiData.name || !emojiData.url) continue;
            if (existingEmojiNames.has(emojiData.name)) continue;
            try {
              const roleIds = (emojiData.roles || [])
                .map(roleId => mapRoleId(roleId))
                .filter(roleId => guild.roles.cache.has(roleId));
              await guild.emojis.create({
                attachment: emojiData.url,
                name: emojiData.name,
                roles: roleIds.length ? roleIds : undefined,
                reason: `Recovered from anti-nuke backup (${sourceGuildId})`
              });
              existingEmojiNames.add(emojiData.name);
              emojisRestored++;
            } catch (e) {
              emojisFailed++;
              console.error('Emergency recover: failed to recreate emoji', { emojiName: emojiData.name, error: e });
            }
          }
        }

        if (guild.stickers && typeof guild.stickers.create === 'function') {
          const existingStickerNames = new Set(toArray(guild.stickers.cache).map(sticker => sticker.name).filter(Boolean));
          for (const stickerData of snapshot.stickers || []) {
            if (!stickerData || !stickerData.name || !stickerData.url || !stickerData.tags) continue;
            if (existingStickerNames.has(stickerData.name)) continue;
            try {
              await guild.stickers.create({
                file: stickerData.url,
                name: stickerData.name,
                description: stickerData.description || undefined,
                tags: stickerData.tags,
                reason: `Recovered from anti-nuke backup (${sourceGuildId})`
              });
              existingStickerNames.add(stickerData.name);
              stickersRestored++;
            } catch (e) {
              stickersFailed++;
              console.error('Emergency recover: failed to recreate sticker', { stickerName: stickerData.name, error: e });
            }
          }
        }
      }

      if (options.restoreBans !== false && guild.bans && typeof guild.bans.fetch === 'function' && typeof guild.bans.create === 'function') {
        let existingBanIds = new Set();
        try {
          const fetchedBans = await guild.bans.fetch();
          existingBanIds = new Set(toArray(fetchedBans).map(entry => entry && entry.user && entry.user.id).filter(Boolean));
        } catch (e) {
          console.error('Emergency recover: failed to fetch current bans', { error: e });
        }

        for (const banData of snapshot.bans || []) {
          if (!banData || !banData.userId) continue;
          if (existingBanIds.has(banData.userId)) continue;
          try {
            await guild.bans.create(banData.userId, {
              reason: banData.reason || `Recovered from anti-nuke backup (${sourceGuildId})`
            });
            existingBanIds.add(banData.userId);
            bansRestored++;
          } catch (e) {
            bansFailed++;
            console.error('Emergency recover: failed to restore ban', { userId: banData.userId, error: e });
          }
        }
      }

      if (options.restoreOnboarding !== false && snapshot.onboarding && typeof guild.editOnboarding === 'function') {
        try {
          const onboardingPayload = JSON.parse(JSON.stringify(snapshot.onboarding));
          if (Array.isArray(onboardingPayload.defaultChannelIds)) {
            onboardingPayload.defaultChannelIds = onboardingPayload.defaultChannelIds.map(mapChannelId).filter(Boolean);
          }
          if (Array.isArray(onboardingPayload.prompts)) {
            onboardingPayload.prompts = onboardingPayload.prompts.map((prompt) => {
              if (!prompt || !Array.isArray(prompt.options)) return prompt;
              const nextOptions = prompt.options.map((opt) => {
                if (!opt) return opt;
                const next = { ...opt };
                if (Array.isArray(next.channelIds)) {
                  next.channelIds = next.channelIds.map(mapChannelId).filter(Boolean);
                }
                if (Array.isArray(next.roleIds)) {
                  next.roleIds = next.roleIds.map(mapRoleId).filter(Boolean);
                }
                return next;
              });
              return { ...prompt, options: nextOptions };
            });
          }
          await guild.editOnboarding(onboardingPayload);
          onboardingRestored = true;
        } catch (e) {
          console.error('Emergency recover: failed to restore onboarding configuration', { error: e });
        }
      }

      // Disable emergency mode
      this.emergencyMode.delete(guildId);
      this.emergencyLockdownUntil.delete(guildId);
      this.saveData();

      this.logAction(guildId, {
        type: 'emergency_recover',
        success: true,
        traceId,
        backupId: backupId || this.getBackupStore(sourceGuildId).latestId,
        sourceGuildId,
        actionTaken: 'restore_backup',
        result: 'recovered'
      });

      return {
        success: true,
        sourceGuildId,
        isCrossGuildRecover,
        rolesRestored,
        rolesCreated,
        rolesSkipped,
        rolesFailed,
        channelsRestored,
        channelsFailed,
        channelsMissing,
        channelsCreated,
        channelsReused,
        threadsCreated,
        threadsFailed,
        threadsMissing,
        emojisRestored,
        emojisFailed,
        stickersRestored,
        stickersFailed,
        bansRestored,
        bansFailed,
        onboardingRestored,
        guildMetaRestored
      };

    } catch (error) {
      this.logAction(guildId, {
        type: 'emergency_recover_failed',
        error: error.message,
        traceId,
        sourceGuildId,
        backupId: backupId || null,
        actionTaken: 'restore_backup',
        result: 'failed'
      });

      throw error;
    }
  }
}

module.exports = AntiNuke;
