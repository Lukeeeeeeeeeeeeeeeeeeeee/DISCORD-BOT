function createResponder(interaction, options = {}) {
  const defaultFlags = options.defaultFlags;
  const defaultAllowedMentions = options.allowedMentions;

  const respond = (payload = {}) => {
    const finalPayload = { ...payload };
    if (!finalPayload.allowedMentions && defaultAllowedMentions) {
      finalPayload.allowedMentions = defaultAllowedMentions;
    }

    if (interaction && (interaction.deferred || interaction.replied)) {
      if (typeof interaction.editReply === 'function') return interaction.editReply(finalPayload);
      if (typeof interaction.followUp === 'function') return interaction.followUp(finalPayload);
    }
    return interaction.reply(finalPayload);
  };

  const defer = async (flags = defaultFlags) => {
    if (!interaction || typeof interaction.deferReply !== 'function') return false;
    if (interaction.deferred || interaction.replied) return false;
    if (flags !== undefined) {
      await interaction.deferReply({ flags });
    } else {
      await interaction.deferReply();
    }
    return true;
  };

  return { respond, defer };
}

module.exports = { createResponder };
