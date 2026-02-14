const fs = require('fs').promises;
const path = require('path');

class AntiNukeRollback {
  constructor() {
    this.rollbackData = new Map(); // guildId -> rollback data
    this.ROLLBACK_FILE = path.join(__dirname, '../data/antinuke_rollback.json');
    this.ROLLBACK_FILE_BAK = `${this.ROLLBACK_FILE}.bak`;
    this.OWNER_ID = process.env.ANTINUKE_OWNER_ID || process.env.OWNER_ID || null;
    this._saveQueue = Promise.resolve();
  }

  async ensureDataDir() {
    try {
      await fs.mkdir(path.dirname(this.ROLLBACK_FILE), { recursive: true });
    } catch (e) {
      void e;
    }
  }

  // Initialize rollback system
  async init() {
    try {
      const data = await fs.readFile(this.ROLLBACK_FILE, 'utf8');
      let parsed = null;
      try {
        parsed = JSON.parse(data);
      } catch (parseErr) {
        console.error('Failed to parse rollback data file; attempting backup recovery.', parseErr);
        const corruptPath = `${this.ROLLBACK_FILE}.corrupt-${Date.now()}`;
        try {
          await fs.rename(this.ROLLBACK_FILE, corruptPath);
        } catch (renameErr) {
          void renameErr;
        }
        const backupData = await fs.readFile(this.ROLLBACK_FILE_BAK, 'utf8');
        parsed = JSON.parse(backupData);
        console.warn('Recovered rollback state from backup file.');
      }
      this.rollbackData = new Map(Object.entries(parsed));
      console.log('🔄 Anti-nuke rollback system loaded');
    } catch (error) {
      console.log('🔄 No existing rollback data found, starting fresh');
      this.rollbackData = new Map();
    }
  }

  // Save rollback data to file
  async saveRollbackData() {
    this._saveQueue = this._saveQueue.then(async () => {
      try {
        await this.ensureDataDir();
        const data = Object.fromEntries(this.rollbackData);
        const serialized = JSON.stringify(data, null, 2);
        const tmpPath = `${this.ROLLBACK_FILE}.tmp`;
        await fs.writeFile(tmpPath, serialized, 'utf8');
        try {
          await fs.copyFile(this.ROLLBACK_FILE, this.ROLLBACK_FILE_BAK);
        } catch (copyErr) {
          void copyErr;
        }
        try {
          await fs.rename(tmpPath, this.ROLLBACK_FILE);
        } catch (renameErr) {
          if (renameErr && (renameErr.code === 'EEXIST' || renameErr.code === 'EPERM')) {
            try {
              await fs.unlink(this.ROLLBACK_FILE);
            } catch (unlinkErr) {
              void unlinkErr;
            }
            await fs.rename(tmpPath, this.ROLLBACK_FILE);
          } else {
            throw renameErr;
          }
        }
      } catch (error) {
        console.error('❌ Failed to save rollback data:', error);
      }
    });

    return this._saveQueue;
  }

  // Record state before anti-nuke action
  async recordPreActionState(guild, actionType, targetData) {
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
      reverted: false
    };

    const guildData = this.rollbackData.get(guildId);
    guildData.actions.push(rollbackEntry);
    
    console.log(`🔄 Recorded pre-action state for ${actionType} in ${guild.name}`);
    await this.saveRollbackData();
  }

  // Record state after anti-nuke action
  async recordPostActionState(guild, actionType, targetData) {
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

    switch (actionType) {
      case 'ban':
      case 'kick':
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

    const remapContext = {
      roleIdMap: new Map(),
      channelIdMap: new Map()
    };

    // Process actions in reverse order (last first)
    for (let i = guildData.actions.length - 1; i >= 0; i--) {
      const action = guildData.actions[i];
      
      if (action.reverted) {
        continue; // Skip already reverted actions
      }

      try {
        const result = await this.rollbackAction(guild, action, client, remapContext);
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
  async rollbackAction(guild, action, _client, remapContext = null) {
    const { actionType, preState } = action;

    switch (actionType) {
      case 'ban':
        return await this.rollbackBan(guild, preState);
      
      case 'kick':
        return await this.rollbackKick(guild, preState);
      
      case 'channel_delete':
        return await this.rollbackChannelDelete(guild, preState, remapContext);
      
      case 'role_delete':
        return await this.rollbackRoleDelete(guild, preState, remapContext);
      
      case 'role_permissions':
        return await this.rollbackRolePermissions(guild, preState, remapContext);
      
      case 'emergency_lockdown':
        return await this.rollbackEmergencyLockdown(guild, preState, remapContext);
      
      case 'bot_add':
        return await this.rollbackBotAdd(guild, preState);
      
      case 'webhook_create':
        return await this.rollbackWebhookCreate(guild, preState);
      
      case 'member_prune':
        return await this.rollbackMemberPrune(guild, preState);
      
      default:
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

  rememberRoleMapping(oldId, newId, remapContext) {
    if (!remapContext || !oldId || !newId || oldId === newId) return;
    remapContext.roleIdMap.set(oldId, newId);
  }

  rememberChannelMapping(oldId, newId, remapContext) {
    if (!remapContext || !oldId || !newId || oldId === newId) return;
    remapContext.channelIdMap.set(oldId, newId);
  }

  resolveRole(guild, roleData, remapContext) {
    if (!guild || !roleData) return null;
    const mappedId = remapContext && remapContext.roleIdMap ? remapContext.roleIdMap.get(roleData.id) : null;
    let role = mappedId ? guild.roles.cache.get(mappedId) : null;
    if (!role && roleData.id) role = guild.roles.cache.get(roleData.id);
    if (!role && roleData.name) role = guild.roles.cache.find(r => r.name === roleData.name);
    if (role && roleData.id) this.rememberRoleMapping(roleData.id, role.id, remapContext);
    return role || null;
  }

  resolveChannel(guild, channelData, remapContext) {
    if (!guild || !channelData) return null;
    const mappedId = remapContext && remapContext.channelIdMap ? remapContext.channelIdMap.get(channelData.id) : null;
    let channel = mappedId ? guild.channels.cache.get(mappedId) : null;
    if (!channel && channelData.id) channel = guild.channels.cache.get(channelData.id);
    if (!channel && channelData.name != null && channelData.type != null) {
      channel = guild.channels.cache.find(ch =>
        ch.name === channelData.name
        && ch.type === channelData.type
      ) || null;
    }
    if (channel && channelData.id) this.rememberChannelMapping(channelData.id, channel.id, remapContext);
    return channel || null;
  }

  remapOverwriteId(id, remapContext) {
    if (!id || !remapContext || !remapContext.roleIdMap) return id;
    return remapContext.roleIdMap.get(id) || id;
  }

  async withRetries(fn, delays = [0, 300, 1200]) {
    let lastError = null;
    for (let i = 0; i < delays.length; i++) {
      const delay = delays[i];
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      try {
        return await fn();
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError || new Error('Operation failed after retries');
  }

  async applyFailSafeChannelLock(channel, guildId) {
    if (!channel || !channel.permissionOverwrites || !guildId) return;
    await this.withRetries(() => channel.permissionOverwrites.create(guildId, {
      ViewChannel: false,
      SendMessages: false,
      Connect: false
    }));
  }

  async rollbackChannelDelete(guild, preState, remapContext = null) {
    if (!preState.channel) {
      return { success: false, error: 'No channel data to restore' };
    }

    let newChannel = null;
    try {
      const mappedParentId = remapContext && remapContext.channelIdMap
        ? (remapContext.channelIdMap.get(preState.channel.parentId) || preState.channel.parentId)
        : preState.channel.parentId;
      const existing = guild.channels.cache.find(ch =>
        ch.name === preState.channel.name
        && ch.type === preState.channel.type
        && (ch.parentId || null) === (mappedParentId || null)
      );
      if (existing) {
        this.rememberChannelMapping(preState.channel.id, existing.id, remapContext);
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
      newChannel = await this.withRetries(() => guild.channels.create(channelData));
      
      // Restore parent category
      if (mappedParentId) {
        const parent = guild.channels.cache.get(mappedParentId);
        if (parent) {
          await this.withRetries(() => newChannel.setParent(parent));
        }
      }

      // Restore permission overwrites
      for (const overwrite of preState.channel.permissionOverwrites || []) {
        await this.withRetries(() => newChannel.permissionOverwrites.create(this.remapOverwriteId(overwrite.id, remapContext), {
          allow: overwrite.allow,
          deny: overwrite.deny
        }));
      }

      this.rememberChannelMapping(preState.channel.id, newChannel.id, remapContext);

      return { success: true, action: 'Restored channel', target: preState.channel.name };
    } catch (error) {
      if (newChannel) {
        try {
          await this.applyFailSafeChannelLock(newChannel, guild.id);
        } catch (lockErr) {
          console.error('Failed applying fail-safe lock to partially restored channel:', lockErr);
        }
      }
      return { success: false, error: `Failed to restore channel: ${error.message}` };
    }
  }

  async rollbackRoleDelete(guild, preState, remapContext = null) {
    if (!preState.role) {
      return { success: false, error: 'No role data to restore' };
    }

    try {
      const existing = guild.roles.cache.find(r => r.name === preState.role.name);
      if (existing) {
        this.rememberRoleMapping(preState.role.id, existing.id, remapContext);
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

      const createdRole = await guild.roles.create(roleData);
      this.rememberRoleMapping(preState.role.id, createdRole.id, remapContext);
      return { success: true, action: 'Restored role', target: preState.role.name };
    } catch (error) {
      return { success: false, error: `Failed to restore role: ${error.message}` };
    }
  }

  async rollbackRolePermissions(guild, preState, remapContext = null) {
    if (!preState.roles) {
      return { success: false, error: 'No role data to restore' };
    }

    try {
      let restored = 0;
      let failed = 0;
      const tasks = [];
      const positionUpdates = [];

      for (const roleData of preState.roles) {
        const role = this.resolveRole(guild, roleData, remapContext);
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

  async rollbackEmergencyLockdown(guild, preState, remapContext = null) {
    if (!preState.roles) {
      return { success: false, error: 'No emergency data to restore' };
    }

    try {
      // Restore role permissions in batches
      const tasks = [];
      let failed = 0;
      for (const roleData of preState.roles) {
        const role = this.resolveRole(guild, roleData, remapContext);
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
      let channelOverwriteFailures = 0;
      for (const channelData of preState.channels || []) {
        const channel = this.resolveChannel(guild, channelData, remapContext);
        if (channel) {
          const overwritePayload = (channelData.permissionOverwrites || [])
            .filter(ow => ow && ow.id)
            .map(ow => ({
              id: this.remapOverwriteId(ow.id, remapContext),
              allow: ow.allow,
              deny: ow.deny,
              type: ow.type
            }));

          // Apply full overwrite set in a single request to avoid a mid-run "public channel" state.
          try {
            await this.withRetries(() => channel.permissionOverwrites.set(overwritePayload));
          } catch (e) {
            channelOverwriteFailures++;
            try {
              await this.applyFailSafeChannelLock(channel, guild.id);
            } catch (lockErr) {
              console.error('Failed applying fail-safe lock after overwrite restore failure:', lockErr);
            }
          }
        }
      }

      if (failed > 0 || channelOverwriteFailures > 0) {
        const issues = [];
        if (failed > 0) issues.push(`${failed} role permission updates`);
        if (channelOverwriteFailures > 0) issues.push(`${channelOverwriteFailures} channel overwrite sets`);
        return { success: false, error: `Failed to restore ${issues.join(' and ')}` };
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
  isOwner(userId, guild = null) {
    if (!userId) return false;
    if (this.OWNER_ID) return userId === this.OWNER_ID;
    if (guild && guild.ownerId) return guild.ownerId === userId;
    return false;
  }
}

module.exports = AntiNukeRollback;
