require('dotenv').config();
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const { SlashCommandBuilder } = require('@discordjs/builders');

const econ = require('./src/lib/economy');
const { PURCHASE_ITEMS } = require('./src/constants');
const BUY_CHOICES = Object.entries(econ.ECONOMY_CONFIG.MULTIPLIERS).map(([k,v]) => ({ name: `${k} ×${v.value} (${v.days}d)`, value: k })).concat(Object.entries(PURCHASE_ITEMS).map(([k,c]) => ({ name: `${k} — ${c} pts`, value: k })));

const commands = [
  new SlashCommandBuilder().setName('recruit').setDescription('Register a recruit')
    .addUserOption(opt => opt.setName('member').setDescription('Member to recruit').setRequired(true))
    .addStringOption(opt => opt
      .setName('region')
      .setDescription('Region of the recruit')
      .setRequired(true)
      .addChoices(
        { name: 'EU', value: 'EU' },
        { name: 'NA', value: 'NA' },
        { name: 'AS', value: 'AS' }
      ))
    .addStringOption(opt=>opt.setName('ign').setDescription('In-game name').setRequired(true)),

  new SlashCommandBuilder().setName('recruiter').setDescription('Recruiter info and actions')
    .addSubcommand(s=>s.setName('info').setDescription('Show recruiter info').addUserOption(o=>o.setName('member').setDescription('Recruiter to query')))
    .addSubcommand(s=>s.setName('buy').setDescription('Buy recruiter items').addStringOption(o=>{
      const opt = o.setName('item').setDescription('Item to purchase').setRequired(true);
      // Add choices dynamically
      return opt.addChoices(...BUY_CHOICES.map(c => ({ name: c.name, value: c.value })));
    }))    .addSubcommand(s=>s.setName('multiplier-list').setDescription('List available multipliers'))
    .addSubcommand(s=>s.setName('multiplier-view').setDescription('View active multiplier (self or admin for others)').addUserOption(o=>o.setName('member').setDescription('Recruiter to check (optional)')))
    .addSubcommand(s=>s.setName('multiplier-active').setDescription('Admin: list active multipliers for the server'))
    .addSubcommand(s=>s.setName('warn').setDescription('Admin: issue a warning to a recruiter').addUserOption(o=>o.setName('member').setDescription('Recruiter to warn').setRequired(true)).addStringOption(o=>o.setName('note').setDescription('Warning note (optional)')).addIntegerOption(o=>o.setName('expires_days').setDescription('Expire after N days (optional, admin only)').setRequired(false)))
    .addSubcommand(s=>s.setName('dismiss').setDescription('Admin: dismiss flags for a recruiter').addUserOption(o=>o.setName('member').setDescription('Recruiter to dismiss flags for').setRequired(true)).addStringOption(o=>o.setName('reason').setDescription('Reason for dismissal (optional)')))
    .addSubcommand(s=>s.setName('revoke').setDescription('Admin: revoke warnings for a recruiter').addUserOption(o=>o.setName('member').setDescription('Recruiter to revoke warnings for').setRequired(true)).addIntegerOption(o=>o.setName('warning_id').setDescription('Specific warning id to revoke (optional)')))
    .addSubcommand(s=>s.setName('multiplier-apply').setDescription('Admin: apply a multiplier to a recruiter').addUserOption(o=>o.setName('member').setDescription('Recruiter to apply multiplier to').setRequired(true)).addStringOption(o=>o.setName('type').setDescription('Multiplier type').setRequired(true).addChoices(
      { name: '1.15 × (14 days)', value: 'm1.15_14d' },
      { name: '1.25 × (14 days)', value: 'm1.25_14d' },
      { name: '1.5 × (7 days)', value: 'm1.5_7d' },
      { name: '2.0 × (7 days)', value: 'm2.0_7d' }
    )))
    .addSubcommand(s=>s.setName('multiplier-reset').setDescription('Admin: reset multipliers for a recruiter').addUserOption(o=>o.setName('member').setDescription('Recruiter to reset multipliers for').setRequired(true))),
  new SlashCommandBuilder().setName('info').setDescription('Info about a recruited member')
    .addUserOption(opt=>opt.setName('member').setDescription('Member to check').setRequired(true)),
  new SlashCommandBuilder()
    .setName('dm')
    .setDescription('DM members of a role (admin only). Use preview to test.')
    .addRoleOption(opt=>opt.setName('role').setDescription('Role to DM').setRequired(true))
    .addStringOption(opt=>opt.setName('message').setDescription('Message to send to matching members').setRequired(true))
    .addIntegerOption(opt=>opt.setName('limit').setDescription('Maximum recipients to DM (caps apply)').setRequired(false).setMinValue(1).setMaxValue(100))
    .addBooleanOption(opt=>opt.setName('preview').setDescription('If true, do not send DMs; show a preview').setRequired(false)),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Update or show leaderboard')
    .addSubcommand(s=>s.setName('show').setDescription('Show leaderboard').addStringOption(opt=>opt.setName('region').setDescription('Region or all').setRequired(false)))
    .addSubcommand(s=>s.setName('init').setDescription('Initialize leaderboard messages (admin only)'))
];

// Validate token before attempting to register commands
const rawToken = process.env.DISCORD_TOKEN;
const token = rawToken ? rawToken.trim().replace(/^"(.+)"$/,'$1') : null;
if (!token) {
  console.error('DISCORD_TOKEN missing — cannot register slash commands. Set DISCORD_TOKEN in .env and try again.');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);
(async () => {
  try {
    console.log('Started refreshing application (/) commands.');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands.map(c => c.toJSON()) },
    );
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    if (error && error.code === 'TokenInvalid') {
      console.error('Failed to register commands: DISCORD_TOKEN is invalid. Regenerate it in the Developer Portal and update .env.');
      process.exit(1);
    }
    console.error(error);
  }
})();