const { EmbedBuilder } = require('discord.js');
const { hasAdminOrStaffPermissions } = require('../../lib/permissions');
const { replyError } = require('../../lib/embeds');
const { formatDiscordTimestamp } = require('../../lib/time');
const { withTransaction } = require('../../lib/transactions');
const { createResponder } = require('../../lib/respond');
const { CHANNELS, ROLE_IDS, RECRUITER_ROLE_IDS } = require('../../constants');
const scheduler = require('../../scheduler');

function hasRecruiterRole(member) {
  if (!member || !member.roles || !member.roles.cache) return false;
  const recruiterRoleIds = [
    ROLE_IDS.RECRUITER,
    ROLE_IDS.TRIAL_RECRUITER,
    ...(RECRUITER_ROLE_IDS ? Object.values(RECRUITER_ROLE_IDS) : [])
  ].filter(Boolean);
  return recruiterRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

async function handleWarn({ interaction, db, guildId }) {
  if (!hasAdminOrStaffPermissions(interaction.member)) return replyError(interaction, 'Admin/Staff only.');
  const { respond, defer } = createResponder(interaction, { defaultFlags: 64, allowedMentions: { parse: [] } });
  await defer();

  const member = interaction.options.getUser('member');
  if (!member) {
    return respond({ content: 'Missing member.' });
  }
  const note = interaction.options.getString('note') || 'Manual warning by staff';
  const expiresDays = interaction.options.getInteger('expires_days');

  const targetMember = await interaction.guild.members.fetch(member.id).catch(() => null);
  if (!targetMember) {
    return respond({ content: 'Member not found in this guild.' });
  }
  const existingRecruiter = await db.get(
    'SELECT id FROM recruiters WHERE guild_id = ? AND id = ?',
    guildId,
    member.id
  ).catch(() => null);
  const recruiterRoleMember = hasRecruiterRole(targetMember);
  if (!existingRecruiter && !recruiterRoleMember) {
    return respond({ content: 'Target is not a recruiter profile. Warning was not applied.' });
  }

  try {
    const createdAt = Date.now();
    const expiredAt = expiresDays ? (createdAt + (expiresDays * 24 * 60 * 60 * 1000)) : null;
    await withTransaction(db, async (tx) => {
      await tx.run('INSERT INTO warnings (guild_id, recruiter_id, created_at, note, expired_at) VALUES (?, ?, ?, ?, ?)', guildId, member.id, createdAt, note, expiredAt);
      if (!existingRecruiter && recruiterRoleMember) {
        await tx.run('INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, 0, 0, 0, 4)', guildId, member.id);
      }
      await tx.run('UPDATE recruiters SET warnings = warnings + 1 WHERE guild_id = ? AND id = ?', guildId, member.id);
    });

    const warnEmbed = new EmbedBuilder()
      .setTitle('Recruiter Warning')
      .setDescription(`**Reason:** ${note}${expiredAt ? `\n**Expires:** ${formatDiscordTimestamp(expiredAt, 'R')}` : ''}`)
      .setColor(0xFF8800)
      .setTimestamp();
    try {
      const m = await interaction.guild.members.fetch(member.id).catch(() => null);
      if (m) {
        await m.send({ embeds: [warnEmbed] }).catch(err => {
          console.error('Failed to DM recruiter warning:', err);
        });
      }
    } catch (e) {
      console.error('Failed to DM warned member', { memberId: member.id, error: e });
    }

    const ch = interaction.guild.channels.cache.get(CHANNELS.RECRUITER_WARNINGS);
    if (ch) {
      const staffEmbed = new EmbedBuilder()
        .setTitle('Recruiter Warning Issued')
        .addFields(
          { name: 'Recruiter', value: `<@${member.id}>`, inline: true },
          { name: 'By', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'Reason', value: note, inline: false }
        )
        .setColor(0xFF4400)
        .setTimestamp();
      if (expiredAt) staffEmbed.addFields({ name: 'Expires', value: formatDiscordTimestamp(expiredAt, 'R'), inline: true });
      ch.send({ embeds: [staffEmbed] }).catch((e) => console.error('Failed to post warning to channel', { channelId: ch.id, error: e }));
    }

    try {
      await scheduler.recomputeLeaderboards(db, interaction.guild);
      await scheduler.recomputeWarningsLeaderboard(db, interaction.guild);
    } catch (e) {
      console.error('Failed to update leaderboards after warning:', e);
    }

    console.info('Warning issued', { recruiterId: member.id, by: interaction.user.id, note, expiredAt });

    return respond({ content: `Warning issued to ${member.tag}.` });
  } catch (e) {
    console.error('Failed to issue warning', { error: e });
    return respond({ content: 'Failed to issue warning.' });
  }
}

async function handleWarningsRevoke({ interaction, db, guildId }) {
  if (!hasAdminOrStaffPermissions(interaction.member)) return replyError(interaction, 'Admin/Staff only.');
  const { respond, defer } = createResponder(interaction, { defaultFlags: 64, allowedMentions: { parse: [] } });
  await defer();

  const member = interaction.options.getUser('member');
  if (!member) {
    return respond({ content: 'Missing member.' });
  }
  const warningId = interaction.options.getInteger('warning_id');
  try {
    await withTransaction(db, async (tx) => {
      if (warningId) {
        const warning = await tx.get('SELECT * FROM warnings WHERE guild_id = ? AND id = ? AND recruiter_id = ?', guildId, warningId, member.id);
        if (!warning) {
          throw new Error(`Warning #${warningId} not found for ${member.tag}.`);
        }
        await tx.run('UPDATE warnings SET revoked = 1 WHERE guild_id = ? AND id = ? AND recruiter_id = ?', guildId, warningId, member.id);
      } else {
        await tx.run('UPDATE warnings SET revoked = 1 WHERE guild_id = ? AND recruiter_id = ?', guildId, member.id);
      }

      const cntRow = await tx.get('SELECT COUNT(*) as c FROM warnings WHERE guild_id = ? AND recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)', guildId, member.id, Date.now());
      const active = cntRow ? cntRow.c : 0;
      await tx.run('UPDATE recruiters SET warnings = ? WHERE guild_id = ? AND id = ?', active, guildId, member.id);
    });

    try {
      await scheduler.recomputeLeaderboards(db, interaction.guild);
      await scheduler.recomputeWarningsLeaderboard(db, interaction.guild);
    } catch (e) {
      console.error('Failed to update leaderboards after warning revocation:', e);
    }

    return respond({ content: `Revoked ${warningId ? `warning #${warningId}` : 'all warnings'} for ${member.tag}.` });
  } catch (e) {
    if (e && e.message && e.message.includes('Warning #') && e.message.includes('not found')) {
      return respond({ content: e.message });
    }
    console.error('Failed to revoke warnings', { error: e });
    return respond({ content: 'Failed to revoke warnings.' });
  }
}

module.exports = { handleWarn, handleWarningsRevoke };
