const { GUILD_ID } = require('../constants');

function getDefaultGuildId() {
  return process.env.GUILD_ID || GUILD_ID || null;
}

function resolveGuildId(input) {
  if (!input) return getDefaultGuildId();
  if (typeof input === 'string') return input;
  if (input.id) return input.id;
  if (input.guild && input.guild.id) return input.guild.id;
  return getDefaultGuildId();
}

module.exports = {
  getDefaultGuildId,
  resolveGuildId
};
