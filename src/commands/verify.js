const db = require('../db_async');
const { ROLE_IDS, REGION_ROLE_IDS, REGION_INFO } = require('../constants');
const { hasModPlusPermissions } = require('../lib/recruiting-system');

function inferTeamFromOnboarding(member) {
  // Onboarding roles: Fire=EU, Water=NA, Air=AS
  if (!member || !member.roles || !member.roles.cache) return null;

  // Check using explicit role IDs for clarity
  if (ROLE_IDS.ONBOARDING_FIRE && member.roles.cache.has(ROLE_IDS.ONBOARDING_FIRE)) return 'EU';
  if (ROLE_IDS.ONBOARDING_WATER && member.roles.cache.has(ROLE_IDS.ONBOARDING_WATER)) return 'NA';
  if (ROLE_IDS.ONBOARDING_AIR && member.roles.cache.has(ROLE_IDS.ONBOARDING_AIR)) return 'AS';

  // Fallback to array indexing if explicit IDs not available
  const list = Array.isArray(ROLE_IDS.ONBOARDING) ? ROLE_IDS.ONBOARDING : [];
  if (list[0] && member.roles.cache.has(list[0])) return 'EU';  // Fire
  if (list[1] && member.roles.cache.has(list[1])) return 'NA';  // Water
  if (list[2] && member.roles.cache.has(list[2])) return 'AS';  // Air
  return null;
}

function inferTeamFromRegionTag(member) {
  if (!member || !member.roles || !member.roles.cache) return null;
  const keys = ['EU', 'NA', 'AS'];
  for (const key of keys) {
    const roleId = REGION_ROLE_IDS && REGION_ROLE_IDS[key] ? REGION_ROLE_IDS[key] : null;
    if (roleId && member.roles.cache.has(roleId)) return key;
  }
  return null;
}

function stripRookiePoints(nickname) {
  if (!nickname) return null;
  const trimmed = nickname.replace(/\s*\d+(?:\.\d+)?\s*\/\s*10\s*$/i, '').trim();
  return trimmed.length ? trimmed : null;
}

module.exports = {
  data: {
    name: 'verify',
    description: 'Verify a rookie (MOD+ only)'
  },
  async execute(interaction) {
    if (!hasModPlusPermissions(interaction.member)) {
      return interaction.reply({ content: 'MOD+ only.', flags: 64 });
    }

    const targetUser = interaction.options.getUser('member');
    if (!targetUser) {
      return interaction.reply({ content: 'Please specify a member to verify.', flags: 64 });
    }

    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) {
      return interaction.reply({ content: 'That member is not in this server.', flags: 64 });
    }

    if (!targetMember.roles.cache.has(ROLE_IDS.ROOKIE)) {
      return interaction.reply({ content: 'That member is not a rookie.', flags: 64 });
    }

    const { promoteMember } = require('../lib/promote');
    const result = await promoteMember({
      member: targetMember,
      db,
      guild: interaction.guild,
      verifierId: interaction.user.id
    });

    return interaction.reply({ content: `✅ Verified ${targetUser.tag}.\nAdded ${result.teamEmoji} ${result.teamName} member role.` });
  }
};
