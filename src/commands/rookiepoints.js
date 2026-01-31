const db = require('../db_async');
const { ROLE_IDS } = require('../constants');
const { hasModPlusPermissions } = require('../lib/recruiting-system');

function parseRookieNickname(rawName) {
  if (!rawName) return { base: null, points: 0 };
  const match = String(rawName).match(/^(.*?)(?:\s+(\d+(?:\.\d+)?)\s*\/\s*10)?$/i);
  if (!match) return { base: rawName, points: 0 };
  const base = (match[1] || '').trim();
  const points = match[2] != null ? Number(match[2]) : 0;
  return { base: base || rawName, points: Number.isFinite(points) ? points : 0 };
}

function formatPoints(value) {
  const rounded = Math.round(value * 10) / 10;
  if (Number.isInteger(rounded)) return String(rounded);
  return String(rounded).replace(/\.0$/, '');
}

module.exports = {
  data: {
    name: 'rookiepoints',
    description: 'Manage rookie points (MOD+ only)'
  },
  async execute(interaction) {
    if (!hasModPlusPermissions(interaction.member)) {
      return interaction.reply({ content: 'MOD+ only.', flags: 64 });
    }

    const sub = interaction.options && typeof interaction.options.getSubcommand === 'function'
      ? interaction.options.getSubcommand()
      : 'add';

    if (sub !== 'add') {
      return interaction.reply({ content: 'Unsupported subcommand.', flags: 64 });
    }

    const targetUser = interaction.options.getUser('member');
    const addPoints = interaction.options.getNumber('points');

    if (!targetUser || !Number.isFinite(addPoints)) {
      return interaction.reply({ content: 'Please provide a member and points to add.', flags: 64 });
    }

    if (addPoints <= 0) {
      return interaction.reply({ content: 'Points to add must be greater than 0.', flags: 64 });
    }

    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) {
      return interaction.reply({ content: 'That member is not in this server.', flags: 64 });
    }

    if (!targetMember.roles.cache.has(ROLE_IDS.ROOKIE)) {
      return interaction.reply({ content: 'That member is not a rookie.', flags: 64 });
    }

    const currentName = targetMember.nickname || targetMember.user.username;
    const parsed = parseRookieNickname(currentName);
    const currentPoints = parsed.points || 0;
    const newPoints = Math.max(0, Math.min(10, currentPoints + addPoints));

    if (newPoints >= 10) {
      // Auto-promote
      const { promoteMember } = require('../lib/promote');
      const result = await promoteMember({
        member: targetMember,
        db,
        guild: interaction.guild,
        verifierId: interaction.user.id
      });

      return interaction.reply({
        content: `✅ Updated ${targetUser.tag} to **10/10** points.\n🎉 **PROMOTED** to ${result.teamEmoji} ${result.teamName}!`
      });
    }

    const baseName = parsed.base || targetMember.user.username;
    const nickname = `${baseName} ${formatPoints(newPoints)}/10`;

    await targetMember.setNickname(nickname).catch(() => { });

    return interaction.reply({
      content: `✅ Updated ${targetUser.tag} to **${formatPoints(newPoints)}/10** points.`
    });
  }
};
