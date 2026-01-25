# 🔄 Anti-Nuke Rollback Integration Guide

## 📋 Overview

The rollback system provides complete restoration capabilities for all anti-nuke actions. When anti-nuke triggers, it records the exact state before and after actions, allowing perfect restoration.

## 🚀 Quick Setup

### 1. Initialize the Rollback System

```javascript
// In your main bot file or anti-nuke initialization
const AntiNukeWithRollback = require('./lib/antinuke-with-rollback');

// Create instance
const antiNuke = new AntiNukeWithRollback();

// Initialize on bot ready
client.once('ready', async () => {
    await antiNuke.init();
    console.log('🔄 Anti-nuke with rollback ready!');
});
```

### 2. Update Your Anti-Nuke Actions

Replace your existing anti-nuke action calls with the tracked versions:

```javascript
// Instead of: await guild.members.ban(target, reason);
// Use: await antiNuke.trackBan(guild, executor, target);

// Instead of: await target.kick(reason);
// Use: await antiNuke.trackKick(guild, executor, target);

// Instead of: await channel.delete();
// Use: await antiNuke.trackChannelDelete(guild, executor, channel);

// Instead of: await role.delete();
// Use: await antiNuke.trackRoleDelete(guild, executor, role);

// For emergency lockdown:
// Use: await antiNuke.trackEmergencyLockdown(guild, executor);

// For bot addition:
// Use: await antiNuke.trackBotAdd(guild, executor, bot);

// For webhook creation:
// Use: await antiNuke.trackWebhookCreate(guild, executor, webhook);

// For member prune:
// Use: await antiNuke.trackMemberPrune(guild, executor, prunedMembers);
```

## 🎯 Complete Integration Example

Here's how to integrate with your existing ban protection:

```javascript
// Your existing ban protection logic
async function handleBanProtection(guild, banEvent) {
    const executor = banEvent.executor;
    const target = banEvent.target;
    
    // Your existing detection logic
    if (shouldBanExecutor(executor, target)) {
        // Record state BEFORE action
        await antiNuke.trackBan(guild, executor, target);
        
        // Execute your anti-nuke action
        await executor.ban({ reason: 'Anti-nuke: Mass ban detected' });
        
        // Record state AFTER action (automatically handled by trackBan)
        console.log(`🔄 Anti-nuke ban recorded with rollback capability`);
    }
}
```

## 📊 What Gets Tracked

### ✅ **Fully Reversible Actions:**
- **Bans** → Unbans the user
- **Channel Deletion** → Recreates channel with all settings
- **Role Deletion** → Recreates role with all permissions
- **Role Permissions** → Restores exact permissions
- **Emergency Lockdown** → Restores all permissions
- **Bot Addition** → Removes the added bot
- **Webhook Creation** → Deletes created webhooks

### ⚠️ **Partially Reversible Actions:**
- **Kicks** → Cannot restore kicked members (Discord API limitation)
- **Member Prune** → Cannot restore pruned members (Discord API limitation)

## 🛠️ Rollback Command Usage

### Command: `/antinuke_rollback`

**Owner Only:** Only user ID `1381692847018868778` can use this command.

**Features:**
- Shows confirmation dialog with action details
- Displays what will be reverted
- Provides detailed success/failure report
- Handles errors gracefully

**Example Output:**
```
🔄 Anti-Nuke Rollback Confirmation
⚠️ WARNING: This will rollback 5 anti-nuke actions in Your Server.

Actions to Rollback: 5
Oldest Action: 2 hours ago
Newest Action: 30 minutes ago

Action Types:
• ban
• channel_delete
• role_delete
• emergency_lockdown
• bot_add
```

## 💾 Data Storage

### File Location
```
src/data/antinuke_rollback.json
```

### Data Structure
```json
{
  "guildId": {
    "guildId": "123456789",
    "guildName": "Your Server",
    "actions": [
      {
        "actionType": "ban",
        "timestamp": 1640995200000,
        "preState": { ... },
        "postState": { ... },
        "reverted": false
      }
    ]
  }
}
```

### Persistence Features
- ✅ Automatic saving after each action
- ✅ Loads on bot restart
- ✅ Cleanup after successful rollback
- ✅ Memory efficient storage

## 🔧 Advanced Usage

### Check Rollback Status
```javascript
const status = antiNuke.getRollbackStatus(guild.id);
console.log(status);
// Output: { hasActions: true, totalActions: 3, actions: [...] }
```

### Manual State Recording
```javascript
// For custom anti-nuke actions
antiNuke.rollback.recordPreActionState(guild, 'custom_action', targetData);
// ... your action here ...
antiNuke.rollback.recordPostActionState(guild, 'custom_action', targetData);
```

### Owner Verification
```javascript
if (!antiNuke.isOwner(interaction.user.id)) {
    return interaction.reply('❌ Owner only!');
}
```

## 🚨 Important Notes

### Security
- Only the specified owner ID can rollback
- Rollback actions are logged
- Cannot rollback already reverted actions

### Limitations
- Cannot restore kicked/pruned members (Discord API)
- Channel recreation may have different ID
- Role recreation may have different ID

### Best Practices
- Initialize rollback system early
- Use tracking wrappers for all actions
- Test rollback functionality regularly
- Monitor rollback data file size

## 🎯 Integration Checklist

- [ ] Initialize `AntiNukeWithRollback`
- [ ] Replace anti-nuke actions with tracked versions
- [ ] Register `/antinuke_rollback` command
- [ ] Create `src/data` directory
- [ ] Test rollback functionality
- [ ] Monitor console logs for rollback events

## 📞 Support

If you encounter issues:

1. Check console logs for `🔄` messages
2. Verify `src/data/antinuke_rollback.json` exists
3. Ensure proper initialization order
4. Test with small actions first

The rollback system is designed to be robust and handles errors gracefully. Your anti-nuke protection will continue working even if rollback fails! 🛡️
