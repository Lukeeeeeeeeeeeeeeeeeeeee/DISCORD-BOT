const db = require('../../db_async');
const { ensureCommandAccess } = require('../../lib/command-auth');
const { getWeekStartUtcTs } = require('../../lib/week');
const { resolveGuildId } = require('../../lib/guild');
const { replyError } = require('../../lib/embeds');
const { formatPointsValue } = require('../../lib/economy');
const { logUnexpectedError, logRuntimeEvent } = require('../../lib/logger');

function reportRecruitsCommandError(scope, error, meta = {}) {
  void logUnexpectedError(scope, error, {
    command: 'recruits',
    ...meta
  });
}

async function refreshLeaderboards(guild) {
  try {
    const scheduler = require('../../scheduler');
    await scheduler.recomputeLeaderboards(db, guild);
    if (typeof scheduler.recomputeWarningsLeaderboard === 'function') {
      await scheduler.recomputeWarningsLeaderboard(db, guild);
    }
  } catch (error) {
    reportRecruitsCommandError('command.recruits.refreshLeaderboards', error, {
      guildId: guild ? guild.id : null
    });
  }
}

module.exports = {
  data: {
    name: 'recruits',
    description: 'Admin: manage weekly recruit totals and recruiter points'
  },
  async execute(interaction) {
    const allowed = await ensureCommandAccess(interaction, {
      allowStaff: false,
      deniedMessage: 'Administrator permission required.',
      flags: 64
    });
    if (!allowed) return null;

    const group = interaction.options && typeof interaction.options.getSubcommandGroup === 'function'
      ? interaction.options.getSubcommandGroup(false)
      : null;
    const sub = interaction.options && typeof interaction.options.getSubcommand === 'function'
      ? interaction.options.getSubcommand()
      : null;
    if (sub !== 'change' || (group !== 'total' && group !== 'points')) {
      return replyError(interaction, 'Unsupported subcommand.', { flags: 64 });
    }

    if (typeof interaction.deferReply === 'function') {
      await interaction.deferReply({ flags: 64 });
    }
    const respond = (payload) => {
      if ((interaction.deferred || interaction.replied) && typeof interaction.editReply === 'function') {
        return interaction.editReply(payload);
      }
      return interaction.reply(payload);
    };

    const member = interaction.options.getUser('member');
    const rawNote = interaction.options.getString('note');
    const note = rawNote ? String(rawNote).trim().slice(0, 250) : null;
    const guildId = resolveGuildId(interaction.guild);
    const now = Date.now();
    if (!member) {
      return replyError(interaction, 'Please provide a valid member.', { flags: 64 });
    }

    const targetMember = await interaction.guild.members.fetch(member.id).catch(() => null);
    if (!targetMember) {
      return respond({ content: 'That member is not in this server.' });
    }

    if (group === 'points') {
      const requestedPointsRaw = interaction.options.getNumber('points');
      if (!Number.isFinite(requestedPointsRaw) || requestedPointsRaw < 0) {
        return replyError(interaction, 'Please provide a valid member and a non-negative points total.', { flags: 64 });
      }
      const requestedPoints = Math.round(Number(requestedPointsRaw) * 100) / 100;

      try {
        await db.run(
          'INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, 0, 0, 0, 4)',
          guildId,
          member.id
        );

        const existing = await db.get(
          'SELECT COALESCE(CAST(points AS REAL), 0) AS points FROM recruiters WHERE guild_id = ? AND id = ?',
          guildId,
          member.id
        );
        const previousPoints = existing ? Number(existing.points || 0) : 0;

        await db.run(
          'UPDATE recruiters SET points = COALESCE(CAST(? AS REAL), 0) WHERE guild_id = ? AND id = ?',
          requestedPoints,
          guildId,
          member.id
        );

        await refreshLeaderboards(interaction.guild);

        void logRuntimeEvent('info', 'command.recruits.pointsChange.updated', 'Recruiter points updated by admin override', {
          command: 'recruits',
          guildId,
          recruiterId: member.id,
          by: interaction.user.id,
          previousPoints,
          points: requestedPoints,
          note
        });

        return respond({
          content: `Set ${member.tag} recruiter points to **${formatPointsValue(requestedPoints)}** (previous: ${formatPointsValue(previousPoints)}).`
        });
      } catch (error) {
        const dispatchResult = await logUnexpectedError('command.recruits.pointsChange.execute', error, {
          command: 'recruits',
          guildId,
          recruiterId: member.id,
          by: interaction.user.id
        });
        return replyError(
          interaction,
          `Failed to update recruiter points.${dispatchResult && dispatchResult.supportId ? ` Support ID: \`${dispatchResult.supportId}\`.` : ''}`,
          { flags: 64 }
        );
      }
    }

    const requestedTotal = interaction.options.getInteger('total');
    if (!Number.isInteger(requestedTotal) || requestedTotal < 0) {
      return replyError(interaction, 'Please provide a valid member and a non-negative total.', { flags: 64 });
    }

    const weekStart = getWeekStartUtcTs();
    try {
      const realCountRow = await db.get(
        'SELECT COUNT(*) as c FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1 AND created_at >= ?',
        guildId,
        member.id,
        weekStart
      );
      const realCount = realCountRow ? Number(realCountRow.c || 0) : 0;

      if (requestedTotal === realCount) {
        await db.run(
          'DELETE FROM weekly_recruit_overrides WHERE guild_id = ? AND recruiter_id = ? AND week_start = ?',
          guildId,
          member.id,
          weekStart
        );
        await refreshLeaderboards(interaction.guild);

        void logRuntimeEvent('info', 'command.recruits.totalChange.cleared', 'Weekly recruit total override cleared', {
          command: 'recruits',
          guildId,
          recruiterId: member.id,
          weekStart,
          by: interaction.user.id
        });

        return respond({
          content: `Cleared weekly override for ${member.tag}. Effective total for this week is **${realCount}**.`
        });
      }

      await db.run(
        `INSERT INTO weekly_recruit_overrides (guild_id, recruiter_id, week_start, total, updated_at, updated_by, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, recruiter_id, week_start) DO UPDATE SET
           total = excluded.total,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by,
           note = excluded.note`,
        guildId,
        member.id,
        weekStart,
        requestedTotal,
        now,
        interaction.user.id,
        note
      );

      await refreshLeaderboards(interaction.guild);

      void logRuntimeEvent('info', 'command.recruits.totalChange.updated', 'Weekly recruit total override updated', {
        command: 'recruits',
        guildId,
        recruiterId: member.id,
        weekStart,
        by: interaction.user.id,
        total: requestedTotal,
        note
      });

      return respond({
        content: `Set ${member.tag} weekly recruit total to **${requestedTotal}** (real count: ${realCount}, overridden for this week).`
      });
    } catch (error) {
      const dispatchResult = await logUnexpectedError('command.recruits.totalChange.execute', error, {
        command: 'recruits',
        guildId,
        recruiterId: member.id,
        by: interaction.user.id,
        weekStart
      });
      return replyError(
        interaction,
        `Failed to update weekly recruit total.${dispatchResult && dispatchResult.supportId ? ` Support ID: \`${dispatchResult.supportId}\`.` : ''}`,
        { flags: 64 }
      );
    }
  }
};
