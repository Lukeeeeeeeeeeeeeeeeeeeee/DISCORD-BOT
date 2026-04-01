const { CHANNELS } = require('../../constants');
const { ensureCommandAccess } = require('../../lib/command-auth');
const { replyError } = require('../../lib/embeds');
const { logUnexpectedError, logRuntimeEvent } = require('../../lib/logger');
const { resolveGuildId } = require('../../lib/guild');
const { createCampaign } = require('../dm/dm-campaign-service');

module.exports = {
  data: { name: 'dm' },
  async execute(interaction) {
    const traceId = `dm_${Date.now().toString(36)}`;
    
    // Admin only
    const allowed = await ensureCommandAccess(interaction, {
      allowStaff: false,
      deniedMessage: 'Administrator permission required.'
    });
    if (!allowed) return null;

    if (!interaction.guild) {
      return replyError(interaction, 'This command can only be used inside a server.');
    }

    const role = interaction.options.getRole('role', false);
    const message = interaction.options.getString('message', true);
    const preview = interaction.options.getBoolean('preview') || false;
    const dmEveryone = interaction.options.getBoolean('everyone') || false;

    // Validate inputs
    if (!message) return replyError(interaction, 'Missing required message parameter.');
    if (message.length > 2000) return replyError(interaction, 'Message must be 2000 characters or fewer.');
    if (!role && !dmEveryone) return replyError(interaction, 'You must specify a role OR set everyone to true.');

    await interaction.deferReply({ flags: 64 });

    try {
      const guildId = resolveGuildId(interaction.guild);
      const targetMode = dmEveryone ? 'everyone' : 'any_roles';
      const roleIds = role ? [role.id] : [];

      const result = await createCampaign({
        guild: interaction.guild,
        requestedBy: interaction.user.id,
        messageType: 'misc',
        messageBody: message,
        targetMode,
        roleIds,
        preview,
        reportChannelId: CHANNELS?.ECONOMY_NOTIFICATIONS || null,
        requestedChannelId: interaction.channelId
      });

      if (!result.totalTargets) {
        return interaction.editReply({ 
           content: `No recipients found for this selection. Check your roles or everyone setting.` 
        });
      }

      if (preview) {
        const sample = (result.sampleUserIds || []).map(id => `<@${id}>`).join(', ');
        return interaction.editReply({
          content: `📊 **DM Preview Summary**\n` +
                   `Targets: **${result.totalTargets}**\n` +
                   `Batches: **${result.totalBatches}**\n` +
                   `Sample (First 10): ${sample || 'none'}\n\n` +
                   `*Run without preview:true to queue this campaign.*`
        });
      }

      void logRuntimeEvent('info', 'command.dm.queued', 'Universal DM broadcast queued', {
        campaignId: result.campaignId,
        requestedBy: interaction.user.id,
        totalTargets: result.totalTargets
      });

      return interaction.editReply({
        content: `✅ **DM Campaign Queued!**\n` +
                 `Campaign ID: **#${result.campaignId}**\n` +
                 `Total Targets: **${result.totalTargets}**\n` +
                 `Status: **Queued for Worker Fleet**\n\n` +
                 `*Audit summary will be posted to the reporting channel once complete.*`
      });

    } catch (err) {
      void logUnexpectedError('command.dm.unified.execute', err, { traceId, guildId: interaction.guild.id });
      return replyError(interaction, `Failed to queue DM campaign. Ref: ${traceId}`);
    }
  }
};
