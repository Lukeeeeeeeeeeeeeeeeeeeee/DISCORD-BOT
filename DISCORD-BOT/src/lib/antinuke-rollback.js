const fs = require('fs').promises;
const path = require('path');

const rollbackSaveQueuesByPath = new Map();

function enqueueRollbackSave(filePath, task) {
  const key = path.resolve(filePath);
  const previous = rollbackSaveQueuesByPath.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(task);
  rollbackSaveQueuesByPath.set(key, next);
  return next;
}

class AntiNukeRollback {
  constructor() {
    this.rollbackData = new Map(); // guildId -> rollback data
    this.ROLLBACK_FILE = path.join(__dirname, '../data/antinuke_rollback.json');
    this.OWNER_ID = process.env.OWNER_ID || null;
    this.ROLLBACK_TTL_MS = Number.parseInt(process.env.ANTINUKE_ROLLBACK_TTL_MS || `${7 * 24 * 60 * 60 * 1000}`, 10);
    this.ROLLBACK_MAX_ACTIONS_PER_GUILD = Number.parseInt(process.env.ANTINUKE_ROLLBACK_MAX_ACTIONS || '200', 10);
    this.ROLLBACK_MAX_GUILDS = Number.parseInt(process.env.ANTINUKE_ROLLBACK_MAX_GUILDS || '250', 10);
  }

  async ensureDataDir() {
    try {
      await fs.mkdir(path.dirname(this.ROLLBACK_FILE), { recursive: true });
    } catch (e) {
      void e;
    }
  }

  getRollbackFileCandidates() {
    const candidates = [
      this.ROLLBACK_FILE,
      `${this.ROLLBACK_FILE}.tmp`
    ].map(filePath => path.resolve(filePath));
    return Array.from(new Set(candidates));
  }

  async writeRollbackFileAtomic(payload) {
    const tmpFile = `${this.ROLLBACK_FILE}.tmp`;
    const handle = await fs.open(tmpFile, 'w');
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
    await fs.rename(tmpFile, this.ROLLBACK_FILE);

    // Best-effort directory sync for crash consistency.
    try {
      const dirHandle = await fs.open(path.dirname(this.ROLLBACK_FILE), 'r');
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close().catch(() => {});
      }
    } catch (_error) {
      // ignored
    }
  }

  // Initialize rollback system
  async init() {
    try {
      let parsed = null;
      let loadedFrom = null;
      let lastError = null;
      const candidates = this.getRollbackFileCandidates();

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
        throw lastError || new Error('No rollback state file could be loaded');
      }

      this.rollbackData = new Map(Object.entries(parsed || {}));
      this.pruneRollbackData();
      if (loadedFrom !== path.resolve(this.ROLLBACK_FILE)) {
        await this.saveRollbackData();
      }
      console.log('🔄 Anti-nuke rollback system loaded');
    } catch (error) {
      console.log('🔄 No existing rollback data found, starting fresh');
      this.rollbackData = new Map();
    }
  }

  normalizeGuildRollbackData(guildId, guildData = {}) {
    const actions = Array.isArray(guildData.actions) ? guildData.actions.filter(Boolean) : [];
    return {
      guildId,
      guildName: guildData.guildName || guildId,
      actions,
      timestamp: Number(guildData.timestamp || Date.now())
    };
  }

  pruneRollbackData(now = Date.now()) {
    const ttlMs = Number.isFinite(this.ROLLBACK_TTL_MS) && this.ROLLBACK_TTL_MS > 0
      ? this.ROLLBACK_TTL_MS
      : (7 * 24 * 60 * 60 * 1000);
    const maxActions = Number.isFinite(this.ROLLBACK_MAX_ACTIONS_PER_GUILD) && this.ROLLBACK_MAX_ACTIONS_PER_GUILD > 0
      ? this.ROLLBACK_MAX_ACTIONS_PER_GUILD
      : 200;
    const maxGuilds = Number.isFinite(this.ROLLBACK_MAX_GUILDS) && this.ROLLBACK_MAX_GUILDS > 0
      ? this.ROLLBACK_MAX_GUILDS
      : 250;
    const cutoff = now - ttlMs;

    const normalized = [];
    for (const [guildId, guildData] of this.rollbackData.entries()) {
      const safe = this.normalizeGuildRollbackData(guildId, guildData);
      const keptActions = safe.actions
        .filter(action => action && Number.isFinite(Number(action.timestamp)) && Number(action.timestamp) >= cutoff)
        .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
      const sliced = keptActions.length > maxActions
        ? keptActions.slice(keptActions.length - maxActions)
        : keptActions;
      if (!sliced.length) continue;
      safe.actions = sliced;
      safe.timestamp = Math.max(
        Number(safe.timestamp || 0),
        Number(sliced[sliced.length - 1].timestamp || 0)
      );
      normalized.push([guildId, safe]);
    }

    normalized.sort((a, b) => Number((b[1] && b[1].timestamp) || 0) - Number((a[1] && a[1].timestamp) || 0));
    this.rollbackData = new Map(normalized.slice(0, maxGuilds));
  }

  // Save rollback data to file
  async saveRollbackData() {
    return enqueueRollbackSave(this.ROLLBACK_FILE, async () => {
      try {
        await this.ensureDataDir();
        this.pruneRollbackData();
        const data = Object.fromEntries(this.rollbackData);
        await this.writeRollbackFileAtomic(JSON.stringify(data, null, 2));
      } catch (error) {
        console.error('❌ Failed to save rollback data:', error);
      }
    });

  }

  normalizeCaptureActionType(actionType) {
    if (!actionType) return actionType;
    if (actionType === 'beast_mode') return 'beast_mode';
    if (typeof actionType === 'string' && actionType.startsWith('rapid_')) return 'rapid_action';
    return actionType;
  }

  // Record state before anti-nuke action
  async recordPreActionState(guild, actionType, targetData, metadata = null) {
    const guildId = guild.id;
    
    if (!this.rollbackData.has(guildId)) {
      this.rollbackData.set(guildId, {
        guildId,
        guildName: guild.name,
        actions: [],
        timestamp: Date.now()
      });
    }

    const rollbackEntry = {
      actionType,
      timestamp: Date.now(),
      preState: this.captureState(guild, actionType, targetData),
      postState: null, // Will be filled after action
      reverted: false,
      meta: metadata && typeof metadata === 'object' ? { ...metadata } : null
    };

    const guildData = this.rollbackData.get(guildId);
    guildData.actions.push(rollbackEntry);
    guildData.timestamp = rollbackEntry.timestamp;
    
    console.log(`🔄 Recorded pre-action state for ${actionType} in ${guild.name}`);
    await this.saveRollbackData();
  }

  // Record state after anti-nuke action
  async recordPostActionState(guild, actionType, targetData, metadata = null) {
    const guildId = guild.id;
    const guildData = this.rollbackData.get(guildId);
    
    if (!guildData) return;

    // Find the most recent action of this type that doesn't have a postState
    let action = null;
    for (let i = guildData.actions.length - 1; i >= 0; i--) {
      const a = guildData.actions[i];
      if (a.actionType === actionType && !a.postState && !a.reverted) {
        action = a;
        break;
      }
    }

    if (action) {
      action.postState = this.captureState(guild, actionType, targetData);
      if (metadata && typeof metadata === 'object') {
        action.meta = {
          ...(action.meta && typeof action.meta === 'object' ? action.meta : {}),
          ...metadata
        };
      }
      guildData.timestamp = Math.max(Number(guildData.timestamp || 0), Number(action.timestamp || Date.now()));
      console.log(`🔄 Recorded post-action state for ${actionType} in ${guild.name}`);
      await this.saveRollbackData();
    }
  }

  // Capture the current state of various elements
  captureState(guild, actionType, targetData) {
    const state = {
      timestamp: Date.now(),
      guild: {
        name: guild.name,
        icon: guild.iconURL(),
        ownerId: guild.ownerId
      }
    };

    const normalizedActionType = this.normalizeCaptureActionType(actionType);
    switch (normalizedActionType) {
      case 'ban':
      case 'kick':
      case 'beast_mode':
      case 'rapid_action':
        state.member = targetData ? {
          id: targetData.id,
          tag: targetData.user?.tag,
          roles: targetData.roles?.cache.map(r => r.id),
          joinedAt: targetData.joinedAt ? targetData.joinedAt.getTime() : null,
          nickname: targetData.nickname
        } : null;
        break;

      case 'channel_delete':
        state.channel = targetData ? {
          id: targetData.id,
          name: targetData.name,
          type: targetData.type,
          position: targetData.position,
          parentId: targetData.parentId,
          topic: targetData.topic,
          nsfw: targetData.nsfw,
          rateLimitPerUser: targetData.rateLimitPerUser,
          permissionOverwrites: Array.from(targetData.permissionOverwrites.cache.values()).map(overwrite => ({
            id: overwrite.id,
            type: overwrite.type,
            allow: overwrite.allow.bitfield.toString(),
            deny: overwrite.deny.bitfield.toString()
          }))
        } : null;
        break;

      case 'role_delete':
        state.role = targetData ? {
          id: targetData.id,
          name: targetData.name,
          color: targetData.color,
          position: targetData.position,
          permissions: targetData.permissions.bitfield.toString(),
          hoist: targetData.hoist,
          mentionable: targetData.mentionable,
          icon: targetData.iconURL(),
          emoji: targetData.emoji
        } : null;
        break;

      case 'role_permissions':
        state.roles = guild.roles.cache.map(role => ({
          id: role.id,
          name: role.name,
          permissions: role.permissions.bitfield.toString(),
          position: role.position
        }));
        break;

      case 'emergency_lockdown':
        state.roles = guild.roles.cache.map(role => ({
          id: role.id,
          name: role.name,
          permissions: role.permissions.bitfield.toString(),
          position: role.position
        }));
        state.channels = guild.channels.cache.map(channel => ({
          id: channel.id,
          name: channel.name,
          type: channel.type,
          permissionOverwrites: Array.from(channel.permissionOverwrites.cache.values()).map(overwrite => ({
            id: overwrite.id,
            type: overwrite.type,
            allow: overwrite.allow.bitfield.toString(),
            deny: overwrite.deny.bitfield.toString()
          }))
        }));
        break;

      case 'bot_add':
        state.bot = targetData ? {
          id: targetData.id,
          tag: targetData.user?.tag,
          roles: targetData.roles?.cache.map(r => r.id)
        } : null;
        break;

      case 'webhook_create':
        state.webhook = targetData ? {
          id: targetData.id,
          name: targetData.name,
          channel: targetData.channelId,
          avatar: targetData.avatarURL()
        } : null;
        break;

      case 'member_prune':
        state.prunedMembers = targetData || [];
        break;
    }

    return state;
  }

  // Rollback all actions for a guild
  async rollbackAll(guild, client) {
    const guildId = guild.id;
    const guildData = this.rollbackData.get(guildId);
    
    if (!guildData || guildData.actions.length === 0) {
      return { success: false, message: 'No anti-nuke actions to rollback.' };
    }

    console.log(`🔄 Starting rollback for ${guild.name} - ${guildData.actions.length} actions`);
    
    let results = {
      total: guildData.actions.length,
      reverted: 0,
      failed: 0,
      details: []
    };

    // Process actions in reverse order (last first)
    for (let i = guildData.actions.length - 1; i >= 0; i--) {
      const action = guildData.actions[i];
      
      if (action.reverted) {
        continue; // Skip already reverted actions
      }

      try {
        const result = await this.rollbackAction(guild, action, client);
        results.details.push(result);
        
        if (result.success) {
          action.reverted = true;
          results.reverted++;
        } else {
          results.failed++;
        }
      } catch (error) {
        console.error(`❌ Failed to rollback action ${action.actionType}:`, error);
        results.failed++;
        results.details.push({
          actionType: action.actionType,
          success: false,
          error: error.message
        });
      }
    }

    // Clear the rollback data after successful rollback
    if (results.reverted > 0) {
      this.rollbackData.delete(guildId);
      await this.saveRollbackData();
    }

    return results;
  }

  // Rollback individual action
  async rollbackAction(guild, action, _client) {
    const { actionType, preState } = action;

    switch (actionType) {
      case 'ban':
      case 'beast_mode':
        return await this.rollbackBan(guild, preState);
      
      case 'kick':
        return await this.rollbackKick(guild, preState);
      
      case 'channel_delete':
        return await this.rollbackChannelDelete(guild, preState);
      
      case 'role_delete':
        return await this.rollbackRoleDelete(guild, preState);
      
      case 'role_permissions':
        return await this.rollbackRolePermissions(guild, preState);
      
      case 'emergency_lockdown':
        return await this.rollbackEmergencyLockdown(guild, preState);
      
      case 'bot_add':
        return await this.rollbackBotAdd(guild, preState);
      
      case 'webhook_create':
        return await this.rollbackWebhookCreate(guild, preState);
      
      case 'member_prune':
        return await this.rollbackMemberPrune(guild, preState);
      
      default:
        if (typeof actionType === 'string' && actionType.startsWith('rapid_')) {
          return await this.rollbackBan(guild, preState);
        }
        return { success: false, error: `Unknown action type: ${actionType}` };
    }
  }

  // Rollback methods for each action type
  async rollbackBan(guild, preState) {
    if (!preState.member) {
      return { success: false, error: 'No member data to restore' };
    }

    try {
      // Try to unban the member
      await guild.members.unban(preState.member.id, 'Anti-nuke rollback');
      return { success: true, action: 'Unbanned member', target: preState.member.tag };
    } catch (error) {
      return { success: false, error: `Failed to unban: ${error.message}` };
    }
  }

  async rollbackKick(guild, preState) {
    if (!preState.member) {
      return { success: false, error: 'No member data to restore' };
    }

    // Note: We can't restore a kicked member unless we have an invite
    // This is a limitation of Discord API
    return { success: false, error: 'Cannot restore kicked members (Discord API limitation)' };
  }

  async rollbackChannelDelete(guild, preState) {
    if (!preState.channel) {
      return { success: false, error: 'No channel data to restore' };
    }

    try {
      const existing = guild.channels.cache.find(ch =>
        ch.name === preState.channel.name
        && ch.type === preState.channel.type
        && (ch.parentId || null) === (preState.channel.parentId || null)
      );
      if (existing) {
        return { success: true, action: 'Restored channel', target: preState.channel.name };
      }

      const channelData = {
        name: preState.channel.name,
        type: preState.channel.type,
        position: preState.channel.position,
        topic: preState.channel.topic,
        nsfw: preState.channel.nsfw,
        rateLimitPerUser: preState.channel.rateLimitPerUser
      };

      // Create the channel
      const newChannel = await guild.channels.create(channelData);
      
      // Restore parent category
      if (preState.channel.parentId) {
        const parent = guild.channels.cache.get(preState.channel.parentId);
        if (parent) {
          await newChannel.setParent(parent);
        }
      }

      // Restore permission overwrites
      for (const overwrite of preState.channel.permissionOverwrites || []) {
        await newChannel.permissionOverwrites.create(overwrite.id, {
          allow: overwrite.allow,
          deny: overwrite.deny
        });
      }

      return { success: true, action: 'Restored channel', target: preState.channel.name };
    } catch (error) {
      return { success: false, error: `Failed to restore channel: ${error.message}` };
    }
  }

  async rollbackRoleDelete(guild, preState) {
    if (!preState.role) {
      return { success: false, error: 'No role data to restore' };
    }

    try {
      const existing = guild.roles.cache.find(r => r.name === preState.role.name);
      if (existing) {
        return { success: true, action: 'Restored role', target: preState.role.name };
      }

      const roleData = {
        name: preState.role.name,
        color: preState.role.color,
        position: preState.role.position,
        permissions: preState.role.permissions,
        hoist: preState.role.hoist,
        mentionable: preState.role.mentionable
      };

      // Add icon if it exists
      if (preState.role.icon) {
        roleData.icon = preState.role.icon;
      }
      if (preState.role.emoji) {
        roleData.unicodeEmoji = preState.role.emoji;
      }

      await guild.roles.create(roleData);
      return { success: true, action: 'Restored role', target: preState.role.name };
    } catch (error) {
      return { success: false, error: `Failed to restore role: ${error.message}` };
    }
  }

  async rollbackRolePermissions(guild, preState) {
    if (!preState.roles) {
      return { success: false, error: 'No role data to restore' };
    }

    try {
      let restored = 0;
      let failed = 0;
      const tasks = [];
      const positionUpdates = [];

      for (const roleData of preState.roles) {
        const role = guild.roles.cache.get(roleData.id);
        if (!role) continue;
        tasks.push(async () => {
          try {
            await role.setPermissions(roleData.permissions);
            restored++;
          } catch (e) {
            failed++;
          }
        });
        if (role.id !== guild.id && Number.isFinite(roleData.position)) {
          positionUpdates.push({ role, position: roleData.position });
        }
      }

      const batchSize = 5;
      for (let i = 0; i < tasks.length; i += batchSize) {
        const batch = tasks.slice(i, i + batchSize);
        await Promise.all(batch.map(fn => fn()));
      }

      if (positionUpdates.length && guild.roles && typeof guild.roles.setPositions === 'function') {
        await guild.roles.setPositions(positionUpdates);
      }

      if (failed > 0) {
        return { success: false, error: `Failed to restore ${failed} roles` };
      }
      return { success: true, action: 'Restored role permissions', target: `${restored} roles` };
    } catch (error) {
      return { success: false, error: `Failed to restore role permissions: ${error.message}` };
    }
  }

  async rollbackEmergencyLockdown(guild, preState) {
    if (!preState.roles) {
      return { success: false, error: 'No emergency data to restore' };
    }

    try {
      // Restore role permissions in batches
      const tasks = [];
      let failed = 0;
      for (const roleData of preState.roles) {
        const role = guild.roles.cache.get(roleData.id);
        if (!role) continue;
        tasks.push(async () => {
          try {
            await role.setPermissions(roleData.permissions);
          } catch (e) {
            failed++;
          }
        });
      }

      const batchSize = 5;
      for (let i = 0; i < tasks.length; i += batchSize) {
        const batch = tasks.slice(i, i + batchSize);
        await Promise.all(batch.map(fn => fn()));
      }

      // Restore channel permission overwrites
      for (const channelData of preState.channels || []) {
        const channel = guild.channels.cache.get(channelData.id);
        if (channel) {
          const overwritePayload = (channelData.permissionOverwrites || [])
            .filter(ow => ow && ow.id)
            .map(ow => ({
              id: ow.id,
              allow: ow.allow,
              deny: ow.deny,
              type: ow.type
            }));

          // Apply full overwrite set in a single request to avoid a mid-run "public channel" state.
          await channel.permissionOverwrites.set(overwritePayload);
        }
      }

      if (failed > 0) {
        return { success: false, error: `Failed to restore ${failed} role permissions` };
      }
      return { success: true, action: 'Restored emergency lockdown', target: 'All permissions' };
    } catch (error) {
      return { success: false, error: `Failed to restore emergency lockdown: ${error.message}` };
    }
  }

  async rollbackBotAdd(guild, preState) {
    if (!preState.bot) {
      return { success: false, error: 'No bot data to restore' };
    }

    try {
      // Kick the bot that was added
      const bot = await guild.members.fetch(preState.bot.id).catch(() => null);
      if (bot) {
        await bot.kick('Anti-nuke rollback');
        return { success: true, action: 'Removed bot', target: preState.bot.tag };
      } else {
        return { success: false, error: 'Bot not found in server' };
      }
    } catch (error) {
      return { success: false, error: `Failed to remove bot: ${error.message}` };
    }
  }

  async rollbackWebhookCreate(guild, preState) {
    if (!preState.webhook) {
      return { success: false, error: 'No webhook data to restore' };
    }

    try {
      // Delete the webhook that was created
      const webhook = await guild.fetchWebhooks().then(webhooks => 
        webhooks.find(w => w.id === preState.webhook.id)
      );
      
      if (webhook) {
        await webhook.delete('Anti-nuke rollback');
        return { success: true, action: 'Deleted webhook', target: preState.webhook.name };
      } else {
        return { success: false, error: 'Webhook not found' };
      }
    } catch (error) {
      return { success: false, error: `Failed to delete webhook: ${error.message}` };
    }
  }

  async rollbackMemberPrune(guild, preState) {
    if (!preState.prunedMembers || preState.prunedMembers.length === 0) {
      return { success: false, error: 'No prune data to restore' };
    }

    // Note: Like kicks, we can't restore pruned members
    return { success: false, error: 'Cannot restore pruned members (Discord API limitation)' };
  }

  // Get rollback status for a guild
  getRollbackStatus(guildId) {
    this.pruneRollbackData();
    const guildData = this.rollbackData.get(guildId);
    if (!guildData) {
      return { hasActions: false, actions: [] };
    }

    return {
      hasActions: true,
      guildName: guildData.guildName,
      totalActions: guildData.actions.length,
      actions: guildData.actions.map(action => ({
        type: action.actionType,
        timestamp: action.timestamp,
        reverted: action.reverted
      })),
      oldestAction: Math.min(...guildData.actions.map(a => a.timestamp)),
      newestAction: Math.max(...guildData.actions.map(a => a.timestamp))
    };
  }

  // Check if user is owner
  isOwner(userId) {
    if (!userId) return false;
    if (this.OWNER_ID) return userId === this.OWNER_ID;
    return false;
  }
}

module.exports = AntiNukeRollback;
