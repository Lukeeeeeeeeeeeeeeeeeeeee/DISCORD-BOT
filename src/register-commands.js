require('dotenv').config();
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const { SlashCommandBuilder } = require('@discordjs/builders');

const econ = require('./lib/economy');
const { PURCHASE_ITEMS } = require('./constants');
const BUY_CHOICES = Object.entries(econ.ECONOMY_CONFIG.MULTIPLIERS).map(([k, v]) => ({ name: `${k} ×${v.value} (${v.days}d)`, value: k })).concat(Object.entries(PURCHASE_ITEMS).map(([k, c]) => ({ name: `${k} — ${c} pts`, value: k })));

const commands = [
  new SlashCommandBuilder().setName('recruit').setDescription('Register a recruit')
    .addUserOption(opt => opt.setName('member').setDescription('Member to recruit').setRequired(true))
    .addStringOption(opt => opt.setName('ign').setDescription('In-game name').setRequired(true)),

  new SlashCommandBuilder().setName('recruiter').setDescription('Recruiter info and actions')
    .addSubcommand(s => s.setName('info').setDescription('Show recruiter info').addUserOption(o => o.setName('member').setDescription('Recruiter to query')))
    .addSubcommand(s => s.setName('buy').setDescription('Buy recruiter items').addStringOption(o => {
      const opt = o.setName('item').setDescription('Item to purchase').setRequired(true);
      // Add choices dynamically
      return opt.addChoices(...BUY_CHOICES.map(c => ({ name: c.name, value: c.value })));
    }))
    .addSubcommand(s => s.setName('warn').setDescription('Admin: issue a warning to a recruiter').addUserOption(o => o.setName('member').setDescription('Recruiter to warn').setRequired(true)).addStringOption(o => o.setName('note').setDescription('Warning note (optional)')).addIntegerOption(o => o.setName('expires_days').setDescription('Expire after N days (optional, admin only)').setRequired(false)))
    .addSubcommand(s => s.setName('dismiss').setDescription('Admin: dismiss flags for a recruiter').addUserOption(o => o.setName('member').setDescription('Recruiter to dismiss flags for').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason for dismissal (optional)')))
    .addSubcommand(s => s.setName('warnings-revoke').setDescription('Admin: revoke warnings for a recruiter').addUserOption(o => o.setName('member').setDescription('Recruiter to revoke warnings for').setRequired(true)).addIntegerOption(o => o.setName('warning_id').setDescription('Specific warning id to revoke (optional)'))),
  new SlashCommandBuilder().setName('revoke-recruit').setDescription('Revoke a recruit and update invite channels (admin only)')
    .addUserOption(opt => opt.setName('member').setDescription('Member to revoke recruit status from').setRequired(true))
    .addStringOption(opt => opt.setName('reason').setDescription('Reason for revocation').setRequired(false)),
  new SlashCommandBuilder().setName('absent').setDescription('Set absence period for recruiting requirements (MOD+ only)')
    .addStringOption(opt => opt.setName('date').setDescription('End date for absence (YYYY-MM-DD)').setRequired(true))
    .addUserOption(opt => opt.setName('member').setDescription('Member to set absence for (optional)').setRequired(false)),
  new SlashCommandBuilder().setName('verify').setDescription('Verify a rookie (MOD+ only)')
    .addUserOption(opt => opt.setName('member').setDescription('Rookie to verify').setRequired(true)),
  new SlashCommandBuilder().setName('rookiepoints').setDescription('Manage rookie points (MOD+ only)')
    .addSubcommand(s => s.setName('add').setDescription('Add rookie points')
      .addUserOption(opt => opt.setName('member').setDescription('Rookie member').setRequired(true))
      .addNumberOption(opt => opt.setName('points').setDescription('Points to add').setRequired(true).setMinValue(0.1))),
  new SlashCommandBuilder().setName('rookie_promote').setDescription('Instantly promote a rookie (MOD+ only, for events)')
    .addUserOption(opt => opt.setName('member').setDescription('Rookie to promote').setRequired(true)),
  new SlashCommandBuilder().setName('info').setDescription('Info about a recruited member')
    .addUserOption(opt => opt.setName('member').setDescription('Member to check').setRequired(true)),

  new SlashCommandBuilder()
    .setName('dm')
    .setDescription('DM members of a role (admin only). Use preview to test.')
    .addRoleOption(opt => opt.setName('role').setDescription('Role to DM').setRequired(true))
    .addStringOption(opt => opt.setName('message').setDescription('Message to send to matching members').setRequired(true))
    .addIntegerOption(opt => opt.setName('limit').setDescription('Maximum recipients to DM (caps apply)').setRequired(false).setMinValue(1).setMaxValue(100))
    .addBooleanOption(opt => opt.setName('preview').setDescription('If true, do not send DMs; show a preview').setRequired(false)),
  new SlashCommandBuilder().setName('invite').setDescription('Create a time-limited invite link (Recruiters only)'),
  new SlashCommandBuilder().setName('recruitment_report').setDescription('Admin: show recruiting data for all recruiters (optionally filtered by region)')
    .addStringOption(opt => opt.setName('region').setDescription('Region filter (default ALL)').setRequired(false)
      .addChoices(
        { name: 'ALL', value: 'ALL' },
        { name: 'EU', value: 'EU' },
        { name: 'NA', value: 'NA' },
        { name: 'AS', value: 'AS' }
      )),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Update or show leaderboard')
    .addSubcommand(s => s.setName('show').setDescription('Show leaderboard').addStringOption(opt => opt.setName('region').setDescription('Region or all').setRequired(false)))
    .addSubcommand(s => s.setName('init').setDescription('Initialize leaderboard messages (admin only)')),
  new SlashCommandBuilder().setName('antinuke_rollback').setDescription('Rollback all anti-nuke actions (Owner only)'),

  // Anti-nuke commands
  new SlashCommandBuilder().setName('antinuke_status').setDescription('View full anti-nuke protection status (Admin only)'),
  new SlashCommandBuilder().setName('check_score').setDescription("Check user's beast mode score (Admin only)")
    .addUserOption(opt => opt.setName('user').setDescription('User to check').setRequired(true)),
  new SlashCommandBuilder().setName('reset_scores').setDescription('Reset beast mode scores (Admin only)')
    .addUserOption(opt => opt.setName('user').setDescription('User to reset (optional - resets all if not provided)')),
  new SlashCommandBuilder().setName('whitelist').setDescription('Manage anti-nuke whitelist (Admin only)')
    .addStringOption(opt => opt.setName('action').setDescription('Action to perform').setRequired(true)
      .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' }))
    .addUserOption(opt => opt.setName('user').setDescription('User to add/remove (not required for list)')),
  new SlashCommandBuilder().setName('set_log_channel').setDescription('Configure anti-nuke log channel (Admin only)')
    .addChannelOption(opt => opt.setName('channel').setDescription('Channel to set as log channel').setRequired(true)),
  new SlashCommandBuilder().setName('emergency_recover').setDescription('Recover from emergency lockdown (Admin only)'),
  new SlashCommandBuilder().setName('force_backup').setDescription('Create manual backup of server (Admin only)'),
  new SlashCommandBuilder().setName('view_backups').setDescription('View backup information (Admin only)')
];

async function registerCommands({ guildId = null, global = false } = {}) {
  const rawToken = process.env.DISCORD_TOKEN;
  const token = rawToken ? rawToken.trim().replace(/^"(.+)"$/, '$1') : null;
  if (!token) throw new Error('DISCORD_TOKEN missing — cannot register slash commands. Set DISCORD_TOKEN in .env and try again.');

  const rest = new REST({ version: '10' }).setToken(token);
  const clientId = process.env.CLIENT_ID;
  if (!clientId) throw new Error('CLIENT_ID missing — set CLIENT_ID in .env');

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
      const guildId = guildArgIndex !== -1 ? rawArgs[guildArgIndex + 1] : (process.env.GUILD_ID || null);
      await registerCommands({ guildId, global: useGlobal });
    } catch (error) {
      if (error && error.message && error.message.includes('DISCORD_TOKEN missing')) {
        console.error('DISCORD_TOKEN missing — cannot register slash commands. Set DISCORD_TOKEN in .env and try again.');
        process.exit(1);
      }
      if (error && error.message && error.message.includes('CLIENT_ID missing')) {
        console.error('CLIENT_ID missing — set CLIENT_ID in .env and try again.');
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