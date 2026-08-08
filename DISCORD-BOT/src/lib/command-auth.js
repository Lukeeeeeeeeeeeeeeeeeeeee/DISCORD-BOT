const { hasAdministrator, hasAdminOrStaffPermissions } = require('./permissions');
const { replyError } = require('./embeds');
// D-01: Import MessageFlags so ephemeral replies use the named constant rather than magic number 64.
const { MessageFlags } = require('discord.js');

async function ensureCommandAccess(interaction, options = {}) {
  const {
    allowStaff = false,
    requireAboveBot = false,
    deniedMessage,
    // D-01: Use MessageFlags.Ephemeral instead of magic number 64.
    flags = MessageFlags.Ephemeral
  } = options;

  const member = interaction && interaction.member ? interaction.member : null;
  const allowed = allowStaff
    ? hasAdminOrStaffPermissions(member)
    : hasAdministrator(member);
  if (!allowed) {
    const fallback = allowStaff ? 'Admin/Staff only.' : 'Administrator permission required.';
    await replyError(interaction, deniedMessage || fallback, { flags });
    return false;
  }

  if (requireAboveBot) {
    const guild = interaction && interaction.guild ? interaction.guild : null;
    const botMember = guild && guild.members && guild.members.me ? guild.members.me : null;
    if (botMember && member && member.roles && botMember.roles) {
      const userTop = member.roles.highest;
      const botTop = botMember.roles.highest;
      if (userTop && botTop && userTop.comparePositionTo(botTop) <= 0) {
        await replyError(interaction, 'You must be above the bot in role hierarchy to use this command.', { flags });
        return false;
      }
    }
  }

  return true;
}

module.exports = { ensureCommandAccess };
