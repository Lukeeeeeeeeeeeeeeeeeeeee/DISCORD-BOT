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

class AntiNuke {
  constructor() {
    // Configuration
    const ownerEnv = process.env.ANTINUKE_OWNER_ID || process.env.OWNER_ID;
    this.OWNER_ID = ownerEnv ? String(ownerEnv).trim() : null;
    if (!this.OWNER_ID) {
      console.warn('OWNER_ID is not configured; owner-only anti-nuke actions will be disabled.');
    }
    const logDmEnv = process.env.ANTINUKE_LOG_DM_ID;
    this.LOG_DM_ID = logDmEnv ? String(logDmEnv).trim() : (this.OWNER_ID || null);

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
    this.BEAST_MODE_DECAY_HALF_LIFE = Number.parseInt(
      process.env.ANTINUKE_BEAST_HALF_LIFE_MS || String(6 * 60 * 60 * 1000),
      10
    );
    this.BEAST_MODE_DECAY_WINDOW = Number.parseInt(
      process.env.ANTINUKE_BEAST_DECAY_WINDOW_MS || String(7 * 24 * 60 * 60 * 1000),
      10
    );
    this.BAN_WINDOW = 60 * 60 * 1000;
    this.BAN_DAY_WINDOW = 24 * 60 * 60 * 1000;
    this.WEBHOOK_DEDUPE_WINDOW = 60 * 60 * 1000;
    this.PENDING_WHITELIST_TTL = 12 * 60 * 60 * 1000;
    this.WHITELIST_APPROVALS_REQUIRED = 3;
    this.MASS_BAN_COOLDOWN = 30 * 60 * 1000;
    this.AUTO_ACTION_THRESHOLD = 0.8;
    this.AGGRESSIVE_ACTION_THRESHOLD = 0.5;
    this.AUTO_STRICT_DURATION = 30 * 60 * 1000;
    this.QUARANTINE_DURATION = 24 * 60 * 60 * 1000;
    this.AUDIT_LOG_FETCH_LIMIT = Number.parseInt(process.env.ANTINUKE_AUDIT_FETCH_LIMIT || '100', 10);
    this.BACKUP_RETENTION_FULL = 7;
    this.BACKUP_RETENTION_INCREMENTAL = 30;
    this.LOG_HISTORY_LIMIT = 200;
    this.EMERGENCY_CONFIRM_WINDOW = 30 * 1000;
    this.EMERGENCY_LOCKDOWN_DURATION = 12 * 60 * 60 * 1000;
    this.ENCRYPTION_KEY = process.env.ANTINUKE_ENCRYPTION_KEY || null;
    const requireEncEnv = process.env.ANTINUKE_REQUIRE_ENCRYPTION;
    this.REQUIRE_BACKUP_ENCRYPTION = requireEncEnv
      ? requireEncEnv.toLowerCase() === 'true'
      : true;
    if (!this.ENCRYPTION_KEY) {
      if (this.REQUIRE_BACKUP_ENCRYPTION) {
        console.warn('ANTINUKE_ENCRYPTION_KEY is missing; encrypted backups are required and will fail until configured.');
      } else {
        console.warn('ANTINUKE_ENCRYPTION_KEY is missing; backups will be stored unencrypted.');
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
    this.whitelist = new Map(); // guildId -> Set<userId>
    this.legacyWhitelist = new Set(); // legacy/global whitelist (deprecated)
    this.logChannels = new Map(); // guildId -> channelId
    this.backups = new Map(); // guildId -> backup data
    this.webhookAuditTracker = new Map(); // guildId -> Map<logId, timestamp>
    this.processedAuditEvents = new Map(); // guildId -> Map<auditLogId, timestamp>
    this.pruneTracker = new Map(); // guildId -> last prune log id
    this.pendingWhitelist = new Map(); // guildId -> Map<userId, { approvers: Set, createdAt: number, requestedBy: string }>
    this.lastMassBanLockdown = new Map(); // guildId -> timestamp
    this.guildConfig = new Map(); // guildId -> config
    this.logHistory = new Map(); // guildId -> log entries
    this.quarantineAssignments = new Map(); // guildId -> Map<userId, { roles, expiresAt, quarantineRoleId }>
    this.recoveryMappings = new Map(); // guildId -> { channels: Map<oldId, newId>, roles: Map<oldId, newId> }
    this.recoveryInFlight = new Map(); // guildId -> traceId
    this.pendingEmergencyConfirmations = new Map(); // guildId -> { pending, expiresAt }
    this.rapidActionTimers = new Map(); // key -> timeout

    // File paths
    this.DATA_FILE = path.join(__dirname, '../data/antinuke_data.json');
    this.DATA_FILE_BAK = `${this.DATA_FILE}.bak`;
    this.stateBackend = 'file';
    this.lastGlobalStateUpdatedAt = 0;
    this._saveQueue = Promise.resolve();

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
      await this.handleBanAuditEntry(entry, guild);
      return;
    }
    if (entry.action === AuditLogEvent.MemberKick) {
      await this.handleKickAuditEntry(entry, guild);
    }
  }

  async handleBanAuditEntry(entry, guild) {
    if (!entry || !guild || !entry.executor) return;
    if (entry.executor.id === this.client.user.id) return;
    if (!this.markAuditEventHandled(guild.id, entry.id)) return;
    const eventTime = Date.now();
    const targetId = entry && entry.target && entry.target.id ? entry.target.id : null;
    this.trackAction(guild.id, entry.executor.id, 'ban', {
      targetId,
      auditLogId: entry.id || null,
      traceId: this.createTraceId(),
      timestamp: eventTime
    });
    const banTimestamps = this.recordBan(guild.id, eventTime);
    this.checkMassBanLockdown(guild.id, banTimestamps, eventTime);
    this.checkEmergencyThresholds(guild.id, banTimestamps, eventTime);
  }

  async handleKickAuditEntry(entry, guild) {
    if (!entry || !guild || !entry.executor) return;
    if (entry.executor.id === this.client.user.id) return;
    if (!this.markAuditEventHandled(guild.id, entry.id)) return;
    const eventTime = Date.now();
    const targetId = entry && entry.target && entry.target.id ? entry.target.id : null;
    this.trackAction(guild.id, entry.executor.id, 'kick', {
      targetId,
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
      this.whitelist,
      this.beastModeActions,
      this.beastModeTracker,
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

    const whitelist = this.whitelist.get(guildId);
    if (whitelist && whitelist.size) {
      state.whitelist = Array.from(whitelist);
    }

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
    if (state.whitelist) {
      const entries = Array.isArray(state.whitelist) ? state.whitelist : [];
      this.whitelist.set(guildId, new Set(entries));
    }

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
            this.legacyWhitelist = new Set(payload.whitelist);
          }
          if (payload && Array.isArray(payload.legacyWhitelist)) {
            this.legacyWhitelist = new Set(payload.legacyWhitelist);
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
      this.migrateLegacyWhitelist();
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
      await db.exec('BEGIN');
      try {
        const globalPayload = JSON.stringify({ legacyWhitelist: Array.from(this.legacyWhitelist || []) });
        await db.run(
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
          await db.run(
            `INSERT INTO antinuke_state (key, payload, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
            key,
            payload,
            now
          );
        }

        await db.exec('COMMIT');
        this.lastGlobalStateUpdatedAt = now;
      } catch (e) {
        await db.exec('ROLLBACK');
        throw e;
      }
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
    this.migrateLegacyWhitelist();
    if (db && this.stateBackend === 'db') {
      await this.saveDataToDb(db);
    }
  }

  async loadDataFromFile() {
    try {
      const data = await fs.readFile(this.DATA_FILE, 'utf8');
      let parsed = null;
      try {
        parsed = JSON.parse(data);
      } catch (parseError) {
        console.error('Failed to parse anti-nuke data file; attempting backup recovery.', parseError);
        const corruptPath = `${this.DATA_FILE}.corrupt-${Date.now()}`;
        try {
          await fs.rename(this.DATA_FILE, corruptPath);
        } catch (renameErr) {
          void renameErr;
        }

        try {
          const backupData = await fs.readFile(this.DATA_FILE_BAK, 'utf8');
          parsed = JSON.parse(backupData);
          console.warn('Recovered anti-nuke state from backup file.');
        } catch (backupErr) {
          console.error('Failed to recover anti-nuke state from backup file.', backupErr);
          return;
        }
      }

      if (parsed.whitelist) {
        if (Array.isArray(parsed.whitelist)) {
          this.legacyWhitelist = new Set(parsed.whitelist);
        } else if (parsed.whitelist && typeof parsed.whitelist === 'object') {
          const entries = Object.entries(parsed.whitelist).map(([guildId, list]) => {
            const members = Array.isArray(list) ? list : [];
            return [guildId, new Set(members)];
          });
          this.whitelist = new Map(entries);
        }
      }
      if (parsed.legacyWhitelist && Array.isArray(parsed.legacyWhitelist)) {
        this.legacyWhitelist = new Set(parsed.legacyWhitelist);
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

      console.log('Anti-nuke data loaded from file');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        console.log('No existing anti-nuke data found, starting fresh');
      } else {
        console.error('Failed to load anti-nuke data from file; starting with empty state.', error);
      }
    }
  }

  // Save persistent data
  enqueueSave(task) {
    this._saveQueue = this._saveQueue
      .then(async () => {
        await task();
      })
      .catch((error) => {
        console.error('Anti-nuke save queue error:', error);
      });
    return this._saveQueue;
  }

  async saveData() {
    if (process.env.NODE_ENV === 'test' && process.env.ANTINUKE_TEST_PERSIST !== 'true') {
      return Promise.resolve();
    }
    const db = this.stateBackend === 'db' ? this.getStateDb() : null;
    if (db && this.stateBackend === 'db') {
      return this.enqueueSave(async () => {
        await this.saveDataToDb(db);
      });
    }
    return this.enqueueSave(async () => {
      await this.saveDataToFile();
    });
  }

  async saveDataToFile() {
    try {
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

      const whitelist = {};
      for (const [guildId, set] of this.whitelist.entries()) {
        whitelist[guildId] = Array.from(set || []);
      }

      const recoveryMappings = {};
      for (const [guildId, mapping] of this.recoveryMappings.entries()) {
        const channels = mapping && mapping.channels ? Object.fromEntries(mapping.channels) : {};
        const roles = mapping && mapping.roles ? Object.fromEntries(mapping.roles) : {};
        recoveryMappings[guildId] = { channels, roles };
      }

      const data = {
        whitelist,
        legacyWhitelist: Array.from(this.legacyWhitelist || []),
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
      const serialized = JSON.stringify(data, null, 2);
      const tmpPath = `${this.DATA_FILE}.tmp`;
      await fs.writeFile(tmpPath, serialized, 'utf8');
      try {
        await fs.copyFile(this.DATA_FILE, this.DATA_FILE_BAK);
      } catch (copyErr) {
        void copyErr;
      }
      try {
        await fs.rename(tmpPath, this.DATA_FILE);
      } catch (renameErr) {
        if (renameErr && (renameErr.code === 'EEXIST' || renameErr.code === 'EPERM')) {
          try {
            await fs.unlink(this.DATA_FILE);
          } catch (unlinkErr) {
            void unlinkErr;
          }
          await fs.rename(tmpPath, this.DATA_FILE);
        } else {
          throw renameErr;
        }
      }
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

  getWhitelistSet(guildId) {
    if (!guildId) return this.legacyWhitelist;
    if (!this.whitelist.has(guildId)) {
      this.whitelist.set(guildId, new Set());
    }
    return this.whitelist.get(guildId);
  }

  migrateLegacyWhitelist() {
    if (!this.legacyWhitelist || this.legacyWhitelist.size === 0) return;
    if (this.whitelist && this.whitelist.size > 0) return;
    const guilds = this.client && this.client.guilds && this.client.guilds.cache ? this.client.guilds.cache : null;
    if (!guilds || guilds.size !== 1) return;
    const guildId = guilds.keys().next().value;
    if (!guildId) return;
    this.whitelist.set(guildId, new Set(this.legacyWhitelist));
    this.legacyWhitelist.clear();
    this.saveData();
    console.log('Migrated legacy anti-nuke whitelist to guild scope', { guildId });
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

  markAuditEventHandled(guildId, logId, now = Date.now()) {
    if (!guildId || !logId) return true;
    const guildMap = this.getGuildMap(this.processedAuditEvents, guildId);
    if (guildMap.has(logId)) return false;
    guildMap.set(logId, now);
    return true;
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
      if (this.REQUIRE_BACKUP_ENCRYPTION) {
        throw new Error('Backup encryption required but ANTINUKE_ENCRYPTION_KEY is not configured');
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
        channels: payload.channels ? payload.channels.length : 0
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
        const score = this.calculateBeastModeScore(filtered, Date.now());
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
    const config = this.getGuildConfig(guildId);
    const emergencyActive = this.emergencyMode.get(guildId) || false;
    // During strict/emergency windows and active join pressure, do not relax thresholds.
    if (config.strictActive || config.strictForce || emergencyActive || this.isJoinRaidPressureActive(guildId)) {
      return 1;
    }
    for (const entry of this.THRESHOLD_SCALES) {
      if (memberCount >= entry.minMembers) return entry.scale;
    }
    return 1;
  }

  isJoinRaidPressureActive(guildId) {
    const timestamps = this.joinTracker.get(guildId);
    if (!timestamps || !timestamps.length) return false;
    const joinCfg = this.THRESHOLDS.joinRaid || { count: 12, time: 15000 };
    const windowMs = Number(joinCfg.time) || 15000;
    const threshold = Number(joinCfg.count) || 12;
    const cutoff = Date.now() - windowMs;
    let recent = 0;
    for (let i = timestamps.length - 1; i >= 0; i--) {
      if (timestamps[i] < cutoff) break;
      recent++;
    }
    const pressureThreshold = Math.max(3, Math.floor(threshold * 0.6));
    return recent >= pressureThreshold;
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
    // emergencyForceProtect intentionally inverts emergency bypass behavior:
    // when enabled, emergency mode may still act on whitelisted users.
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
    const logChannelId = this.logChannels.get(guild.id);
    let targetChannel = logChannelId ? guild.channels.cache.get(logChannelId) : null;

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

  async setMemberRolesWithRetry(member, roleIds, reason) {
    const delays = [0, 300, 1200];
    let lastError = null;
    for (let i = 0; i < delays.length; i++) {
      if (delays[i] > 0) await new Promise(resolve => setTimeout(resolve, delays[i]));
      try {
        await member.roles.set(roleIds, reason);
        return;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError || new Error('Failed to set roles');
  }

  async restoreQuarantine(guild, userId, reason = 'quarantine_expired') {
    const assignments = this.quarantineAssignments.get(guild.id);
    if (!assignments) return false;
    const entry = assignments.get(userId);
    if (!entry) return false;

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      assignments.delete(userId);
      if (assignments.size === 0) {
        this.quarantineAssignments.delete(guild.id);
      }
      this.saveData();
      return false;
    }

    const currentRoles = member.roles && member.roles.cache
      ? member.roles.cache.filter(r => r.id !== guild.id).map(r => r.id)
      : [];
    const desiredRoles = new Set([
      ...(Array.isArray(entry.roles) ? entry.roles : []),
      ...currentRoles
    ]);

    // Preserve any roles gained while quarantined, but always remove quarantine roles.
    const quarantineRoleIds = new Set();
    if (entry.quarantineRoleId) quarantineRoleIds.add(entry.quarantineRoleId);
    const cachedQuarantineRoleId = this.quarantineRoles.get(guild.id);
    if (cachedQuarantineRoleId) quarantineRoleIds.add(cachedQuarantineRoleId);
    for (const qRoleId of quarantineRoleIds) {
      desiredRoles.delete(qRoleId);
    }

    await this.setMemberRolesWithRetry(
      member,
      Array.from(desiredRoles),
      `Anti-nuke quarantine release (${reason})`
    ).catch(() => { throw new Error('Failed to restore roles'); });
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
  getBeastModeRetentionWindow() {
    const baseWindow = Number.isFinite(this.BEAST_MODE_WINDOW) ? this.BEAST_MODE_WINDOW : 24 * 60 * 60 * 1000;
    const decayWindow = Number.isFinite(this.BEAST_MODE_DECAY_WINDOW) ? this.BEAST_MODE_DECAY_WINDOW : baseWindow;
    return Math.max(baseWindow, decayWindow);
  }

  getDecayedActionPoints(action, now = Date.now()) {
    if (!action) return 0;
    const basePoints = Number.isFinite(action.points)
      ? Number(action.points)
      : (this.POINTS[action.type] || 0);
    if (!basePoints) return 0;
    const halfLife = Number.isFinite(this.BEAST_MODE_DECAY_HALF_LIFE) && this.BEAST_MODE_DECAY_HALF_LIFE > 0
      ? this.BEAST_MODE_DECAY_HALF_LIFE
      : 6 * 60 * 60 * 1000;
    const age = Math.max(0, now - (action.timestamp || now));
    const decayFactor = Math.pow(0.5, age / halfLife);
    return basePoints * decayFactor;
  }

  calculateBeastModeScore(actions, now = Date.now()) {
    if (!Array.isArray(actions) || actions.length === 0) return 0;
    const total = actions.reduce((sum, action) => sum + this.getDecayedActionPoints(action, now), 0);
    return Math.round(total * 100) / 100;
  }

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
      points,
      auditLogId: details.auditLogId || null,
      simulated: !!details.simulated
    });

    const cutoff = now - this.getBeastModeRetentionWindow();
    entry.actions = entry.actions.filter(action =>
      action.timestamp >= cutoff
    );

    const score = this.calculateBeastModeScore(entry.actions, now);
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
    const attempts = [0, 500, 1500, 3000]; // Polling intervals
    const now = Date.now();
    let lastError = null;

    for (const delay of attempts) {
      if (delay > 0) await new Promise(r => setTimeout(r, delay));

      let auditLogs = null;
      try {
        const auditFetchLimit = Number.isFinite(this.AUDIT_LOG_FETCH_LIMIT) && this.AUDIT_LOG_FETCH_LIMIT > 0
          ? Math.min(100, this.AUDIT_LOG_FETCH_LIMIT)
          : 50;
        auditLogs = await guild.fetchAuditLogs({ limit: auditFetchLimit, type });
      } catch (e) {
        lastError = e;
      }
      if (!auditLogs) continue;

      for (const entry of auditLogs.entries.values()) {
        if (!entry) continue;
        // Check target match if provided
        if (targetId && entry.target?.id !== targetId) continue;

        // Check age against the EVENT timestamp (passed as now/base time), not just current time
        // But for safe-guard, we ensure the log isn't ancient.
        // We use the createdTimestamp of the entry.
        if (now - entry.createdTimestamp > maxAgeMs + delay) continue;

        return entry;
      }
    }
    if (lastError) {
      console.error('Failed to fetch audit logs for anti-nuke event', {
        guildId: guild ? guild.id : null,
        type,
        targetId,
        error: lastError.message || String(lastError)
      });
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
    if (entry && !this.markAuditEventHandled(guild.id, entry.id)) return;

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
    if (entry && !this.markAuditEventHandled(guild.id, entry.id)) return;

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
        this.applyAutoStrict(guild.id, 'join_raid');
        this.logAction(guild.id, {
          type: 'join_raid_detected',
          count: timestamps.length,
          threshold: joinThreshold.count,
          windowMs: joinThreshold.time || 15000,
          actionTaken: 'auto_strict'
        });
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
      let hooks = null;
      try {
        hooks = await channel.fetchWebhooks();
      } catch (e) {
        this.logAction(guild.id, {
          type: 'webhook_audit_mismatch',
          executorId: entry.executor.id,
          webhookId,
          channelId: channel.id,
          traceId: this.createTraceId(),
          actionTaken: 'none',
          result: 'fetch_failed',
          error: e && e.message ? e.message : String(e)
        });
        return;
      }
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
      const ownerId = hook && hook.owner && hook.owner.id ? hook.owner.id : null;
      if (ownerId && ownerId !== entry.executor.id) {
        this.logAction(guild.id, {
          type: 'webhook_audit_mismatch',
          executorId: entry.executor.id,
          webhookId,
          channelId: channel.id,
          traceId: this.createTraceId(),
          actionTaken: 'none',
          result: 'owner_mismatch',
          notes: `Webhook owner ${ownerId} does not match executor ${entry.executor.id}`
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
      // Create backup before lockdown
      const backup = await this.createBackup(guild, { type: 'full' });

      // Remove all permissions except view channels
      await this.removeDangerousPermissions(guild, true);

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
    const type = options.type || 'full';
    const manual = !!options.manual;
    const executorId = options.executorId || null;
    const snapshot = {
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

    const entryId = this.generateBackupId(guild.id);
    const encrypted = this.encryptSnapshot(snapshot);
    const entry = this.normalizeBackupEntry({
      id: entryId,
      type,
      timestamp: snapshot.timestamp,
      counts: {
        roles: snapshot.roles.length,
        channels: snapshot.channels.length
      },
      ...encrypted,
      payload: encrypted.encrypted ? null : snapshot
    });

    const store = this.getBackupStore(guild.id);
    if (type === 'incremental') {
      store.incremental.push(entry);
    } else {
      store.full.push(entry);
    }
    store.latestId = entry.id;
    this.pruneBackupStore(store);
    this.backups.set(guild.id, store);

    const logType = manual
      ? 'manual_backup_created'
      : type === 'incremental'
        ? 'backup_incremental_created'
        : 'backup_created';

    this.logAction(guild.id, {
      type: logType,
      executorId,
      backupId: entry.id,
      rolesCount: snapshot.roles.length,
      channelsCount: snapshot.channels.length,
      encrypted: entry.encrypted || false
    });
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
    const logChannelId = this.logChannels.get(guild.id);
    if (logChannelId) {
      const logChannel = guild.channels.cache.get(logChannelId);
      if (logChannel) {
        await logChannel.send({ embeds: [embed] }).catch((e) => {
          console.error('Failed to send anti-nuke log message', e);
        });
      }
    }
  }

  // Log action
  async logAction(guildId, actionData) {
    const guild = this.client.guilds.cache.get(guildId);
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

    // Send to log channel
    const logChannelId = this.logChannels.get(guildId);
    if (logChannelId) {
      const logChannel = guild.channels.cache.get(logChannelId);
      if (logChannel) {
        await logChannel.send({ embeds: [embed] }).catch((e) => {
          console.error('Failed to send anti-nuke log message', e);
        });
      }
    }

    // Send to owner DM
    if (this.LOG_DM_ID) {
      try {
        const owner = await this.client.users.fetch(this.LOG_DM_ID);
        await owner.send({ embeds: [embed] });
      } catch (error) {
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
        this.legacyWhitelist = new Set(payload.whitelist);
      }
      if (payload && Array.isArray(payload.legacyWhitelist)) {
        this.legacyWhitelist = new Set(payload.legacyWhitelist);
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

    // Incremental backups - runs every hour
    setInterval(() => {
      this.createIncrementalBackups();
    }, 3600000);

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
    const beastCutoff = now - this.getBeastModeRetentionWindow();

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
        const trimmed = (entry.actions || []).filter(action => action.timestamp > beastCutoff);
        if (trimmed.length === 0) {
          userMap.delete(userId);
          scoreMap.delete(userId);
        } else {
          entry.actions = trimmed;
          const score = this.calculateBeastModeScore(trimmed, now);
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

    // Clean processed audit event dedupe tracker
    for (const [guildId, logMap] of this.processedAuditEvents.entries()) {
      for (const [logId, ts] of logMap.entries()) {
        if (now - ts > this.WEBHOOK_DEDUPE_WINDOW) {
          logMap.delete(logId);
        }
      }
      if (logMap.size === 0) {
        this.processedAuditEvents.delete(guildId);
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

  // Check if user is owner (env owner, with guild-owner fallback when env owner is not set)
  isOwner(userId, guildId = null) {
    if (!userId) return false;
    if (this.OWNER_ID) return userId === this.OWNER_ID;
    if (!guildId || !this.client || !this.client.guilds || !this.client.guilds.cache) return false;
    const guild = this.client.guilds.cache.get(guildId);
    return !!(guild && guild.ownerId && guild.ownerId === userId);
  }

  isProtectedUser(userId, guildId = null) {
    if (!userId) return false;
    if (this.client && this.client.user && userId === this.client.user.id) return true;
    if (guildId) {
      return this.getWhitelistSet(guildId).has(userId);
    }
    return this.legacyWhitelist.has(userId);
  }

  // Check if user is whitelisted
  isWhitelisted(userId, guildId = null) {
    if (!userId) return false;
    if (guildId) return this.getWhitelistSet(guildId).has(userId);
    return this.legacyWhitelist.has(userId);
  }

  // Add to whitelist
  addToWhitelist(guildId, userId) {
    if (!userId) return;
    if (!guildId) {
      this.legacyWhitelist.add(userId);
      this.saveData();
      return;
    }
    const set = this.getWhitelistSet(guildId);
    set.add(userId);
    const guildPending = this.pendingWhitelist.get(guildId);
    if (guildPending) guildPending.delete(userId);
    this.saveData();
  }

  // Remove from whitelist
  removeFromWhitelist(guildId, userId) {
    if (!userId) return;
    if (!guildId) {
      this.legacyWhitelist.delete(userId);
      this.saveData();
      return;
    }
    const set = this.getWhitelistSet(guildId);
    set.delete(userId);
    const guildPending = this.pendingWhitelist.get(guildId);
    if (guildPending) guildPending.delete(userId);
    this.saveData();
  }

  // Get whitelist
  getWhitelist(guildId = null) {
    if (!guildId) return Array.from(this.legacyWhitelist);
    return Array.from(this.getWhitelistSet(guildId) || []);
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
      this.saveData();
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
    const backupId = latestBackup ? latestBackup.id : null;
    const backupEncrypted = latestBackup ? !!latestBackup.encrypted : false;
    const pendingWhitelist = this.pendingWhitelist.get(guildId);
    const whitelistSet = this.getWhitelistSet(guildId);
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
      totalWhitelistedUsers: whitelistSet ? whitelistSet.size : 0,
      bansLastHour,
      bansLastDay,
      totalActions,
      isEmergency,
      emergencyLockdownUntil,
      hasBackup: !!backupId,
      backupTimestamp,
      backupRoles,
      backupChannels,
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
    const score = this.calculateBeastModeScore(entry.actions || [], Date.now());
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
      points: Number.isFinite(action.points) ? action.points : (this.POINTS[action.type] || 0)
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
    const lockdownUntil = this.emergencyLockdownUntil.get(guildId) || null;
    if (!force && this.emergencyMode.get(guildId) && lockdownUntil && Date.now() < lockdownUntil) {
      if (!this.isOwner(executorId, guildId)) {
        throw new Error('Emergency lockdown is still active; only the bot owner can recover early.');
      }
    }
    if (!force && !this.emergencyMode.get(guildId)) {
      throw new Error('Server is not in emergency mode');
    }

    const snapshot = this.getBackupSnapshot(guildId, backupId);
    if (!snapshot) {
      throw new Error('Backup not found');
    }

    const traceId = options.traceId || this.createTraceId();
    const existingRecovery = this.recoveryInFlight.get(guildId);
    if (existingRecovery) {
      throw new Error('Emergency recovery is already in progress for this guild.');
    }
    this.recoveryInFlight.set(guildId, traceId);

    try {
      let rolesRestored = 0;
      let rolesSkipped = 0;
      let rolesFailed = 0;
      let channelsRestored = 0;
      let channelsFailed = 0;
      let channelsMissing = 0;
      let channelsCreated = 0;
      let channelsReused = 0;

      const recoveryMapping = this.getRecoveryMapping(guildId);

      // Restore roles (permissions in batches; positions in a bulk call)
      const rolePermissionTasks = [];
      const positionUpdates = [];
      for (const roleData of snapshot.roles || []) {
        const role = guild.roles.cache.get(roleData.id);
        if (!role) continue;
        if (!role.editable) {
          rolesSkipped++;
          continue;
        }

        rolePermissionTasks.push(async () => {
          try {
            await role.setPermissions(roleData.permissions);
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

      // Restore channel permissions in bounded batches to reduce API storms while preserving rollback safety.
      const restoreChannel = async (channelData) => {
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
              id: ow.id,
              allow: ow.allow,
              deny: ow.deny,
              type: ow.type
            }));

          if (!channel && options.recreateMissingChannels !== false) {
            try {
              const createPayload = {
                name: channelData.name || 'recovered-channel',
                type: channelData.type
              };
              if (Number.isFinite(channelData.position)) createPayload.position = channelData.position;
              if (channelData.parentId) {
                const parent = guild.channels.cache.get(channelData.parentId);
                if (parent) createPayload.parent = parent;
              }
              if (channelData.topic != null) createPayload.topic = channelData.topic;
              if (channelData.nsfw != null) createPayload.nsfw = channelData.nsfw;
              if (channelData.rateLimitPerUser != null) createPayload.rateLimitPerUser = channelData.rateLimitPerUser;
              if (overwritePayload.length) createPayload.permissionOverwrites = overwritePayload;

              channel = await guild.channels.create(createPayload);
              channelsCreated++;
              if (recoveryMapping && recoveryMapping.channels) {
                recoveryMapping.channels.set(channelData.id, channel.id);
              }
            } catch (e) {
              channelsFailed++;
              console.error('Emergency recover: failed to recreate channel', { channelId: channelData.id, error: e });
              return;
            }
          }

          if (!channel) {
            channelsMissing++;
            return;
          }

          // Apply full overwrite set in a single request to avoid a mid-run "public channel" state.
          // This replaces channel overwrites without first deleting them one-by-one.
          await channel.permissionOverwrites.set(overwritePayload);
          channelsRestored++;
        } catch (e) {
          channelsFailed++;
          console.error('Emergency recover: failed to restore channel overwrites', {
            channelId: (channel && channel.id) ? channel.id : channelData.id,
            error: e
          });
        }
      };

      const channelBatchSizeRaw = Number.parseInt(process.env.ANTINUKE_RECOVERY_CHANNEL_CONCURRENCY || '4', 10);
      const channelBatchSize = Number.isFinite(channelBatchSizeRaw) && channelBatchSizeRaw > 0
        ? channelBatchSizeRaw
        : 4;
      const snapshotChannels = Array.isArray(snapshot.channels) ? snapshot.channels : [];
      for (let i = 0; i < snapshotChannels.length; i += channelBatchSize) {
        const batch = snapshotChannels.slice(i, i + channelBatchSize);
        await Promise.all(batch.map(channelData => restoreChannel(channelData)));
      }

      // Disable emergency mode
      this.emergencyMode.delete(guildId);
      this.emergencyLockdownUntil.delete(guildId);
      this.saveData();

      this.logAction(guildId, {
        type: 'emergency_recover',
        success: true,
        traceId,
        backupId: backupId || this.getBackupStore(guildId).latestId,
        actionTaken: 'restore_backup',
        result: 'recovered'
      });

      return {
        success: true,
        rolesRestored,
        rolesSkipped,
        rolesFailed,
        channelsRestored,
        channelsFailed,
        channelsMissing,
        channelsCreated,
        channelsReused
      };

    } catch (error) {
      this.logAction(guildId, {
        type: 'emergency_recover_failed',
        error: error.message,
        traceId,
        backupId: backupId || null,
        actionTaken: 'restore_backup',
        result: 'failed'
      });

      throw error;
    } finally {
      this.recoveryInFlight.delete(guildId);
    }
  }
}

module.exports = AntiNuke;
