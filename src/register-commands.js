require('dotenv').config();
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const { SlashCommandBuilder } = require('@discordjs/builders');
const { PermissionFlagsBits } = require('discord.js');

const {
  REGIONS,
  REGION_INFO,
  PURCHASE_ITEMS,
  APPROVAL_ONLY_ITEMS
} = require('./constants');
const { ECONOMY_CONFIG, formatPointsValue } = require('./lib/economy');
const BUY_ITEM_LABELS = {
  'custom-nickname': 'Custom nickname',
  'vip': 'VIP',
  'mvp': 'MVP',
  'custom-vc': 'Custom VC',
  'custom-role': 'Custom role',
  'custom-suggestion': 'Custom suggestion'
};
const BUY_ITEM_CHOICES = [
  ...Object.entries(ECONOMY_CONFIG && ECONOMY_CONFIG.MULTIPLIERS ? ECONOMY_CONFIG.MULTIPLIERS : {})
    .map(([key, cfg]) => ({
      name: `${formatPointsValue(cfg.value)}x - ${cfg.days} days (${formatPointsValue(cfg.cost)} pts)`,
      value: key
    })),
  ...Object.entries(PURCHASE_ITEMS || {})
    .map(([key, cost]) => ({
      name: `${BUY_ITEM_LABELS[key] || key} (${formatPointsValue(cost)} pts)`,
      value: key
    })),
  ...Object.entries(APPROVAL_ONLY_ITEMS || {})
    .map(([key]) => ({
      name: `${BUY_ITEM_LABELS[key] || key} (staff approval required)`,
      value: key
    }))
];

const commands = [
  new SlashCommandBuilder().setName('recruit').setDescription('Register a recruit')
    .addUserOption(opt => opt.setName('member').setDescription('Member to recruit').setRequired(true))
    .addStringOption(opt => opt.setName('ign').setDescription('In-game name').setRequired(true))
    .addUserOption(opt => opt.setName('credit_to').setDescription('Optional recruiter to credit for this recruit').setRequired(false)),
  new SlashCommandBuilder().setName('recruits').setDescription('Admin: manage weekly recruit totals')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommandGroup(group => group
      .setName('total')
      .setDescription('Manage weekly recruit totals')
      .addSubcommand(sub => sub.setName('change').setDescription('Set weekly total recruits for a recruiter')
        .addUserOption(opt => opt.setName('member').setDescription('Recruiter to update').setRequired(true))
        .addIntegerOption(opt => opt.setName('total').setDescription('New total for this week').setRequired(true).setMinValue(0).setMaxValue(500))
        .addStringOption(opt => opt.setName('note').setDescription('Optional audit note').setRequired(false).setMaxLength(250))
      )
    ),

  new SlashCommandBuilder().setName('recruiter').setDescription('Recruiter info and actions')
    .addSubcommand(s => s.setName('info').setDescription('Show recruiter info').addUserOption(o => o.setName('member').setDescription('Recruiter to query')))
    .addSubcommand(s => s.setName('buy').setDescription('Buy recruiter items')
      .addStringOption(o => o.setName('item').setDescription('Item to purchase').setRequired(true)
        .addChoices(...BUY_ITEM_CHOICES)))
    .addSubcommand(s => s.setName('multiplier-list').setDescription('List available multipliers'))
    .addSubcommand(s => s.setName('multiplier-view').setDescription('View active multiplier').addUserOption(o => o.setName('member').setDescription('Recruiter to query')))
    .addSubcommand(s => s.setName('multiplier-active').setDescription('Show active multipliers'))
    .addSubcommand(s => s.setName('multiplier-apply').setDescription('Admin: apply a multiplier')
      .addUserOption(o => o.setName('member').setDescription('Recruiter to apply').setRequired(true))
      .addStringOption(o => o.setName('item').setDescription('Multiplier key').setRequired(true)))
    .addSubcommand(s => s.setName('multiplier-event').setDescription('Admin: create a custom event multiplier')
      .addUserOption(o => o.setName('member').setDescription('Recruiter to apply this event multiplier to').setRequired(true))
      .addNumberOption(o => o.setName('value').setDescription('Multiplier value (example: 1.75)').setRequired(true).setMinValue(1.0).setMaxValue(10.0))
      .addNumberOption(o => o.setName('cost').setDescription('Point cost charged to that recruiter').setRequired(true).setMinValue(0).setMaxValue(1000))
      .addIntegerOption(o => o.setName('duration_days').setDescription('Duration in days (optional if expiry_date is set)').setRequired(false).setMinValue(1).setMaxValue(365))
      .addStringOption(o => o.setName('expiry_date').setDescription('Exact expiry date in YYYY-MM-DD (optional)').setRequired(false))
      .addStringOption(o => o.setName('label').setDescription('Optional event label (for tracking/reporting)').setRequired(false)))
    .addSubcommand(s => s.setName('multiplier-reset').setDescription('Admin: reset a multiplier')
      .addUserOption(o => o.setName('member').setDescription('Recruiter to reset').setRequired(true)))
    .addSubcommand(s => s.setName('warn').setDescription('Admin: issue a warning to a recruiter').addUserOption(o => o.setName('member').setDescription('Recruiter to warn').setRequired(true)).addStringOption(o => o.setName('note').setDescription('Warning note (optional)')).addIntegerOption(o => o.setName('expires_days').setDescription('Expire after N days (optional, admin only)').setRequired(false)))
    .addSubcommand(s => s.setName('warnings-revoke').setDescription('Admin: revoke warnings for a recruiter').addUserOption(o => o.setName('member').setDescription('Recruiter to revoke warnings for').setRequired(true)).addIntegerOption(o => o.setName('warning_id').setDescription('Specific warning id to revoke (optional)'))),
  new SlashCommandBuilder().setName('revoke-recruit').setDescription('Revoke a recruit and update invite channels (admin only)')
    .addUserOption(opt => opt.setName('member').setDescription('Member to revoke recruit status from').setRequired(true))
    .addStringOption(opt => opt.setName('reason').setDescription('Reason for revocation').setRequired(false)),
  new SlashCommandBuilder().setName('absent').setDescription('Set absence period for recruiting requirements (MOD+ only)')
    .addStringOption(opt => opt.setName('date').setDescription('End date for absence (YYYY-MM-DD)').setRequired(true))
    .addUserOption(opt => opt.setName('member').setDescription('Member to set absence for (optional)').setRequired(false)),
  new SlashCommandBuilder().setName('rookiepoints').setDescription('Manage rookie points (MOD+ only)')
    .addSubcommand(s => s.setName('add').setDescription('Add rookie points')
      .addUserOption(opt => opt.setName('member').setDescription('Rookie member').setRequired(true))
      .addNumberOption(opt => opt.setName('points').setDescription('Points to add').setRequired(true).setMinValue(0.1)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove rookie points')
      .addUserOption(opt => opt.setName('member').setDescription('Rookie member').setRequired(true))
      .addNumberOption(opt => opt.setName('points').setDescription('Points to remove').setRequired(true).setMinValue(0.1)))
    .addSubcommand(s => s.setName('reset-all').setDescription('Reset all rookie points to 0 (admin only)')),
  new SlashCommandBuilder().setName('inactivepoints').setDescription('Manage inactive member event points (Helper+ of same team)')
    .addSubcommand(s => s.setName('add').setDescription('Add event points to an inactive member')
      .addUserOption(opt => opt.setName('member').setDescription('Inactive member').setRequired(true))
      .addNumberOption(opt => opt.setName('points').setDescription('Points to add').setRequired(true).setMinValue(0.5).setMaxValue(2)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove event points from an inactive member')
      .addUserOption(opt => opt.setName('member').setDescription('Inactive member').setRequired(true))
      .addNumberOption(opt => opt.setName('points').setDescription('Points to remove').setRequired(true).setMinValue(0.5).setMaxValue(2)))
    .addSubcommand(s => s.setName('reset-all').setDescription('Reset all inactive points to 0 (admin only)')),
  new SlashCommandBuilder().setName('rookie_promote').setDescription('Verify and promote a rookie (MOD+ only)')
    .addUserOption(opt => opt.setName('member').setDescription('Rookie to promote').setRequired(true)),
  new SlashCommandBuilder().setName('info').setDescription('Info about a recruited member')
    .addUserOption(opt => opt.setName('member').setDescription('Member to check').setRequired(true)),
  new SlashCommandBuilder()
    .setName('dm')
    .setDescription('DM members of a role or everyone (admin only). Use preview to test.')
    .addStringOption(opt => opt.setName('message').setDescription('Message to send to matching members').setRequired(true))
    .addRoleOption(opt => opt.setName('role').setDescription('Role to DM (optional if using everyone)').setRequired(false))
    .addBooleanOption(opt => opt.setName('everyone').setDescription('DM all server members (overrides role)').setRequired(false))
    .addIntegerOption(opt => opt.setName('limit').setDescription('Maximum recipients to DM (default: all unsent matches, up to 1000)').setRequired(false).setMinValue(1).setMaxValue(1000))
    .addIntegerOption(opt => opt.setName('offset').setDescription('Skip first N unsent matches (useful for resuming)').setRequired(false).setMinValue(0).setMaxValue(1000))
    .addBooleanOption(opt => opt.setName('preview').setDescription('If true, do not send DMs; show a preview').setRequired(false)),
  new SlashCommandBuilder().setName('activitycheck').setDescription('Owner-only activity checks')
    .addSubcommand(s => s.setName('role').setDescription('Assign inactive roles to members who did not react to a message')
      .addStringOption(opt => opt.setName('messageid').setDescription('Message ID to audit reactions from').setRequired(true))
      .addChannelOption(opt => opt.setName('channel').setDescription('Channel containing the message (defaults to current channel)').setRequired(false))
      .addIntegerOption(opt => opt.setName('limit').setDescription('Optional limit of matched members to process').setRequired(false).setMinValue(1).setMaxValue(5000))
      .addBooleanOption(opt => opt.setName('preview').setDescription('If true, show results without changing roles').setRequired(false))),
  new SlashCommandBuilder().setName('pathbalance').setDescription('Owner-only one-time path role balancer for staged members')
    .addBooleanOption(opt => opt.setName('all_members').setDescription('Process all guild members instead of only a source role (default false)').setRequired(false))
    .addRoleOption(opt => opt.setName('source_role').setDescription('Members in this role will be processed (default configured role)').setRequired(false))
    .addIntegerOption(opt => opt.setName('limit').setDescription('Optional cap on members to process').setRequired(false).setMinValue(1).setMaxValue(5000))
    .addBooleanOption(opt => opt.setName('preview').setDescription('Preview mode (default true)').setRequired(false))
    .addBooleanOption(opt => opt.setName('remove_source_role').setDescription('Remove source role from processed members (default true)').setRequired(false))
    .addBooleanOption(opt => opt.setName('delete_source_role').setDescription('Delete source role after completion (default true)').setRequired(false))
    .addStringOption(opt => opt.setName('confirm').setDescription('Type CONFIRM for live execution').setRequired(false)),
  new SlashCommandBuilder().setName('fixnick').setDescription('Owner-only: fix all member nicknames to REGION | IGN or 0/10 | IGN')
    .addBooleanOption(opt => opt.setName('preview').setDescription('Preview mode (default true)').setRequired(false)),
  new SlashCommandBuilder().setName('invite').setDescription('Create a time-limited invite link (Recruiters only)'),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Update or show leaderboard')
    .addSubcommand(s => s.setName('show').setDescription('Show leaderboard').addStringOption(opt => opt.setName('region').setDescription('Region or all').setRequired(false)
      .addChoices(
        { name: 'Global', value: 'GLOBAL' },
        ...(REGIONS || []).map(code => {
          const info = REGION_INFO && REGION_INFO[code] ? REGION_INFO[code] : null;
          const label = info && info.name ? info.name : code;
          const name = info && info.emoji ? `${info.emoji} ${label}` : label;
          return { name, value: code };
        })
      )))
    .addSubcommand(s => s.setName('init').setDescription('Initialize leaderboard messages (admin only)')),
  new SlashCommandBuilder().setName('status').setDescription('Admin: show bot status'),
  new SlashCommandBuilder().setName('antinuke_rollback').setDescription('Rollback all anti-nuke actions (Owner only)'),

  // Anti-nuke commands
  new SlashCommandBuilder().setName('antinuke_status').setDescription('View full anti-nuke protection status (Admin only)'),
  new SlashCommandBuilder().setName('check_score').setDescription("Check user's beast mode score (Admin only)")
    .addUserOption(opt => opt.setName('user').setDescription('User to check').setRequired(true)),
  new SlashCommandBuilder().setName('reset_scores').setDescription('Reset beast mode scores (Admin only)')
    .addUserOption(opt => opt.setName('user').setDescription('User to reset (optional - resets all if not provided)')),
  new SlashCommandBuilder().setName('whitelist').setDescription('Manage anti-nuke whitelist (List: Admin, Modify: Owner)')
    .addStringOption(opt => opt.setName('action').setDescription('Action to perform').setRequired(true)
      .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' }))
    .addUserOption(opt => opt.setName('user').setDescription('User to add/remove (not required for list)')),
  new SlashCommandBuilder().setName('set_log_channel').setDescription('Configure anti-nuke log channel (Admin only)')
    .addChannelOption(opt => opt.setName('channel').setDescription('Channel to set as log channel').setRequired(true)),
  new SlashCommandBuilder().setName('emergency_recover').setDescription('Recover or clone server from backup (Owner only)')
    .addStringOption(opt => opt.setName('backup_id').setDescription('Backup ID to restore (optional)').setRequired(false))
    .addStringOption(opt => opt.setName('source_guild_id').setDescription('Source guild backup to restore from (owner only)').setRequired(false))
    .addBooleanOption(opt => opt.setName('force').setDescription('Force recovery even if not in emergency mode (owner only)').setRequired(false)),
  new SlashCommandBuilder().setName('force_backup').setDescription('Create manual backup of server (Admin only)'),
  new SlashCommandBuilder().setName('view_backups').setDescription('View backup information (Admin only)'),
  new SlashCommandBuilder().setName('simulate_attack').setDescription('Simulate anti-nuke triggers (Owner only)')
    .addStringOption(opt => opt.setName('type').setDescription('Action type to simulate').setRequired(true)
      .addChoices(
        { name: 'ban', value: 'ban' },
        { name: 'kick', value: 'kick' },
        { name: 'channel_delete', value: 'channel_delete' },
        { name: 'role_delete', value: 'role_delete' },
        { name: 'webhook', value: 'webhook' },
        { name: 'bot_add', value: 'bot_add' },
        { name: 'prune', value: 'prune' }
      ))
    .addIntegerOption(opt => opt.setName('count').setDescription('Number of simulated actions').setRequired(true))
    .addIntegerOption(opt => opt.setName('window_seconds').setDescription('Window in seconds').setRequired(true)),
  new SlashCommandBuilder().setName('toggle_strict_mode').setDescription('Enable or disable anti-nuke strict mode (Owner only)')
    .addBooleanOption(opt => opt.setName('enabled').setDescription('Enable strict mode').setRequired(true))
    .addIntegerOption(opt => opt.setName('duration_minutes').setDescription('Optional auto-disable duration in minutes').setRequired(false)),
  new SlashCommandBuilder().setName('set_quarantine_options').setDescription('Configure anti-nuke quarantine options (Owner only)')
    .addStringOption(opt => opt.setName('mode').setDescription('Quarantine mode').setRequired(true)
      .addChoices(
        { name: 'quarantine', value: 'quarantine' },
        { name: 'quarantine_ban', value: 'quarantine_ban' },
        { name: 'ban', value: 'ban' }
      ))
    .addBooleanOption(opt => opt.setName('preserve_view').setDescription('Preserve view/read permissions during quarantine').setRequired(false))
    .addIntegerOption(opt => opt.setName('duration_hours').setDescription('Quarantine duration in hours').setRequired(false)),
  new SlashCommandBuilder().setName('toggle_aggressive_ban').setDescription('Enable or disable aggressive anti-nuke bans (Owner only)')
    .addBooleanOption(opt => opt.setName('enabled').setDescription('Enable aggressive bans').setRequired(true)),
  new SlashCommandBuilder().setName('export_logs').setDescription('Export recent anti-nuke logs (Admin only)')
    .addIntegerOption(opt => opt.setName('limit').setDescription('Number of log entries to export (max 200)').setRequired(false))
    .addStringOption(opt => opt.setName('format').setDescription('Export format').setRequired(false)
      .addChoices(
        { name: 'json', value: 'json' },
        { name: 'csv', value: 'csv' },
        { name: 'txt', value: 'txt' }
      ))
    .addIntegerOption(opt => opt.setName('chunk_size').setDescription('Split export into chunks (1-200)').setRequired(false).setMinValue(1).setMaxValue(200)),
];

async function registerCommands({ guildId = null, global = false } = {}) {
  const rawToken = process.env.DISCORD_TOKEN;
  const token = rawToken ? rawToken.trim().replace(/^"(.+)"$/, '$1') : null;
  if (!token) throw new Error('DISCORD_TOKEN missing - cannot register slash commands. Set DISCORD_TOKEN in .env and try again.');

  const rest = new REST({ version: '10' }).setToken(token);
  const clientId = process.env.CLIENT_ID;
  if (!clientId) throw new Error('CLIENT_ID missing - set CLIENT_ID in .env');

  console.log('Started refreshing application (/) commands.');
  if (global) {
    await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands.map(c => c.toJSON()) },
    );
    console.log('Successfully reloaded global application (/) commands.');
    return;
  }

  if (guildId) {
    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commands.map(c => c.toJSON()) },
    );
    console.log(`Successfully reloaded application (/) commands for guild ${guildId}.`);
    return;
  }

  throw new Error('No target specified. Provide --global or set GUILD_ID or pass --guild <id>.');
}

module.exports = { registerCommands };

if (require.main === module) {
  (async () => {
    try {
      const rawArgs = process.argv.slice(2);
      const useGlobal = rawArgs.includes('--global');
      const guildArgIndex = rawArgs.findIndex(a => a === '--guild');
      const { GUILD_ID } = require('./constants');
      const guildId = guildArgIndex !== -1 ? rawArgs[guildArgIndex + 1] : (process.env.GUILD_ID || GUILD_ID || null);
      await registerCommands({ guildId, global: useGlobal });
    } catch (error) {
      if (error && error.message && error.message.includes('DISCORD_TOKEN missing')) {
        console.error('DISCORD_TOKEN missing - cannot register slash commands. Set DISCORD_TOKEN in .env and try again.');
        process.exit(1);
      }
      if (error && error.message && error.message.includes('CLIENT_ID missing')) {
        console.error('CLIENT_ID missing - set CLIENT_ID in .env and try again.');
        process.exit(1);
      }
      if (error && error.code === 'TokenInvalid') {
        console.error('Failed to register commands: DISCORD_TOKEN is invalid. Regenerate it in the Developer Portal and update .env.');
        process.exit(1);
      }
      console.error('Failed to register commands:', error);
      process.exit(1);
    }
  })();
}
