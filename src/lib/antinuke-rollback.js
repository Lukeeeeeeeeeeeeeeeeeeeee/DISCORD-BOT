const fs = require('fs').promises;
const path = require('path');

class AntiNukeRollback {
  constructor() {
    this.rollbackData = new Map(); // guildId -> rollback data
    this.ROLLBACK_FILE = path.join(__dirname, '../data/antinuke_rollback.json');
    this.OWNER_ID = '1381692847018868778';
  }

  // Initialize rollback system
  async init() {
    try {
      const data = await fs.readFile(this.ROLLBACK_FILE, 'utf8');
      const parsed = JSON.parse(data);
      this.rollbackData = new Map(Object.entries(parsed));
      console.log('🔄 Anti-nuke rollback system loaded');
    } catch (error) {
      console.log('🔄 No existing rollback data found, starting fresh');
      this.rollbackData = new Map();
    }
  }

  // Save rollback data to file
  async saveRollbackData() {
    try {
      const data = Object.fromEntries(this.rollbackData);
      await fs.writeFile(this.ROLLBACK_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('❌ Failed to save rollback data:', error);
    }
  }

  // Record state before anti-nuke action
  recordPreActionState(guild, actionType, targetData) {
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
    this.saveRollbackData();
  }

  // Record state after anti-nuke action
  recordPostActionState(guild, actionType, targetData) {
    const guildId = guild.id;
    const guildData = this.rollbackData.get(guildId);
    
    if (!guildData) return;

    // Find the most recent action of this type that doesn't have a postState
    const action = guildData.actions
      .reverse()
      .find(a => a.actionType === actionType && !a.postState && !a.reverted);

    if (action) {
      action.postState = this.captureState(guild, actionType, targetData);
      console.log(`🔄 Recorded post-action state for ${actionType} in ${guild.name}`);
      this.saveRollbackData();
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
          joinedAt: targetData.joinedAt,
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
  async rollbackAction(guild, action, client) {
    const { actionType, preState } = action;

    switch (actionType) {
      case 'ban':
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

    try {
      // Note: We can't restore a kicked member unless we have an invite
      // This is a limitation of Discord API
      return { success: false, error: 'Cannot restore kicked members (Discord API limitation)' };
    } catch (error) {
      return { success: false, error: `Failed to restore member: ${error.message}` };
    }
  }

  async rollbackChannelDelete(guild, preState) {
    if (!preState.channel) {
      return { success: false, error: 'No channel data to restore' };
    }

    try {
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

      const newRole = await guild.roles.create(roleData);
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
      for (const roleData of preState.roles) {
        const role = guild.roles.cache.get(roleData.id);
        if (role) {
          await role.setPermissions(roleData.permissions);
          await role.setPosition(roleData.position);
          restored++;
        }
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
      // Restore role permissions
      for (const roleData of preState.roles) {
        const role = guild.roles.cache.get(roleData.id);
        if (role) {
          await role.setPermissions(roleData.permissions);
        }
      }

      // Restore channel permission overwrites
      for (const channelData of preState.channels || []) {
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

    try {
      // Note: Like kicks, we can't restore pruned members
      return { success: false, error: 'Cannot restore pruned members (Discord API limitation)' };
    } catch (error) {
      return { success: false, error: `Failed to restore pruned members: ${error.message}` };
    }
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
  isOwner(userId) {
    return userId === this.OWNER_ID;
  }
}

module.exports = AntiNukeRollback;
