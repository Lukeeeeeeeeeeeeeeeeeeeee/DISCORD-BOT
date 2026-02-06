const { EmbedBuilder } = require('discord.js');
const { hasAdministrator } = require('../lib/permissions');
const { buildErrorEmbed } = require('../lib/embeds');
const runtime = require('../lib/runtime');

const ACTION_MAP = {
  ban: 'ban',
  kick: 'kick',
  channel_delete: 'channelDelete',
  role_delete: 'roleDelete',
  webhook: 'webhookCreate',
  bot_add: 'botAdd',
  prune: 'prune'
};

module.exports = {
  data: {
    name: 'simulate_attack',
    description: 'Simulate anti-nuke triggers (Admin only)',
    options: [
      {
        name: 'type',
        description: 'Action type to simulate',
        type: 3,
        required: true,
        choices: [
          { name: 'ban', value: 'ban' },
          { name: 'kick', value: 'kick' },
          { name: 'channel_delete', value: 'channel_delete' },
          { name: 'role_delete', value: 'role_delete' },
          { name: 'webhook', value: 'webhook' },
          { name: 'bot_add', value: 'bot_add' },
          { name: 'prune', value: 'prune' }
        ]
      },
      {
        name: 'count',
        description: 'Number of simulated actions',
        type: 4,
        required: true
      },
      {
        name: 'window_seconds',
        description: 'Window in seconds',
        type: 4,
        required: true
      }
    ]
  },
  async execute(interaction) {
    if (!hasAdministrator(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Administrator permission required.')], flags: 64 });
    }

    const antiNuke = runtime.getAntiNuke();
    if (!antiNuke) {
      return interaction.reply({ embeds: [buildErrorEmbed('Anti-nuke system not initialized.')], flags: 64 });
    }

    const type = interaction.options.getString('type');
    const count = interaction.options.getInteger('count');
    const windowSeconds = interaction.options.getInteger('window_seconds');
    const mappedType = ACTION_MAP[type];

    if (!mappedType || count <= 0 || windowSeconds <= 0) {
      return interaction.reply({ embeds: [buildErrorEmbed('Invalid simulation parameters.')], flags: 64 });
    }

    if (typeof interaction.deferReply === 'function') {
      await interaction.deferReply({ flags: 64 });
    }

    const respond = (payload) => {
      if (interaction.deferred || interaction.replied) {
        if (typeof interaction.editReply === 'function') return interaction.editReply(payload);
        if (typeof interaction.followUp === 'function') return interaction.followUp(payload);
      }
      return interaction.reply(payload);
    };

    const now = Date.now();
    const spacing = Math.max(1, Math.floor((windowSeconds * 1000) / count));
    const executorId = interaction.user.id;
    const guildId = interaction.guild.id;

    for (let i = 0; i < count; i += 1) {
      const timestamp = now - (count - 1 - i) * spacing;
      antiNuke.trackAction(guildId, executorId, mappedType, {
        simulated: true,
        silent: true,
        timestamp
      });
    }

    if (mappedType === 'ban') {
      const simulated = Array(count).fill(now);
      antiNuke.checkRapidActions(guildId, executorId, mappedType, now, { simulated: true });
      antiNuke.checkMassBanLockdown(guildId, simulated, now, { simulated: true });
      antiNuke.checkEmergencyThresholds(guildId, simulated, now, { simulated: true });
    } else {
      antiNuke.checkRapidActions(guildId, executorId, mappedType, now, { simulated: true });
    }

    antiNuke.cleanupSimulatedActions(guildId, executorId);

    antiNuke.logAction(guildId, {
      type: 'simulation_run',
      executorId,
      actionType: mappedType,
      count,
      windowSeconds,
      actionTaken: 'simulated',
      result: 'completed'
    });

    const embed = new EmbedBuilder()
      .setColor('#00AAFF')
      .setTitle('🧪 Simulation Complete')
      .setDescription(`Simulated ${count} ${type} actions over ${windowSeconds}s.`)
      .addFields(
        { name: 'Executor', value: interaction.user.tag, inline: true },
        { name: 'Action Type', value: mappedType, inline: true },
        { name: 'Window', value: `${windowSeconds}s`, inline: true }
      )
      .setTimestamp();

    return respond({ embeds: [embed] });
  }
};
