const { EmbedBuilder } = require('discord.js');
const { ensureCommandAccess } = require('../lib/command-auth');
const runtime = require('../lib/runtime');
const { replyError } = require('../lib/embeds');

module.exports = {
  data: {
    name: 'whitelist',
    description: 'Manage anti-nuke whitelist (List: Admin, Modify: Owner)',
    options: [
      {
        name: 'action',
        description: 'Action to perform',
        type: 3, // STRING
        required: true,
        choices: [
          { name: 'add', value: 'add' },
          { name: 'remove', value: 'remove' },
          { name: 'list', value: 'list' }
        ]
      },
      {
        name: 'user',
        description: 'User to add/remove (not required for list)',
        type: 6, // USER
        required: false
      }
    ]
  },
  async execute(interaction) {
    const allowed = await ensureCommandAccess(interaction, {
      allowStaff: false,
      requireAboveBot: true,
      deniedMessage: 'Administrator permission required.'
    });
    if (!allowed) return null;

    const antiNuke = runtime.getAntiNuke();
    if (!antiNuke) {
      return replyError(interaction, 'Anti-nuke system not initialized.', { flags: 64 });
    }

    const action = interaction.options.getString('action');
    const targetUser = interaction.options.getUser('user');
    const isOwner = antiNuke.isOwner && antiNuke.isOwner(interaction.user.id);

    if (action !== 'list' && !isOwner) {
      return replyError(interaction, 'Whitelist modifications are restricted to the bot owner.', { flags: 64 });
    }

    try {
      switch (action) {
        case 'add': {
          if (!targetUser) {
            return replyError(interaction, 'User parameter is required for add action.', { flags: 64 });
          }

          const botMember = interaction.guild && interaction.guild.members && interaction.guild.members.me
            ? interaction.guild.members.me
            : null;
          const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
          if (!targetMember) {
            return replyError(interaction, 'That user is not in this server.', { flags: 64 });
          }

          const hasAdminPerm = targetMember.permissions && targetMember.permissions.has
            ? targetMember.permissions.has('Administrator')
            : false;
          if (!hasAdminPerm) {
            return replyError(interaction, 'User must have Administrator permissions to be whitelisted.', { flags: 64 });
          }

          if (botMember && targetMember.roles && botMember.roles) {
            const targetTop = targetMember.roles.highest;
            const botTop = botMember.roles.highest;
            if (targetTop && botTop && targetTop.comparePositionTo(botTop) <= 0) {
              return replyError(interaction, 'User must be above the bot in role hierarchy to be whitelisted.', { flags: 64 });
            }
          }

          if (antiNuke.isWhitelisted(targetUser.id, interaction.guild.id)) {
            const embed = new EmbedBuilder()
              .setColor('#FFFF00')
              .setTitle('⚠️ User Already Whitelisted')
              .setDescription(`${targetUser.tag} is already in the whitelist.`)
              .setTimestamp();
            return interaction.reply({ embeds: [embed], flags: 64 });
          }

          const result = antiNuke.requestWhitelistAdd(interaction.guild.id, targetUser.id, interaction.user.id);

          if (result.status === 'already') {
            const embed = new EmbedBuilder()
              .setColor('#FFFF00')
              .setTitle('⚠️ User Already Whitelisted')
              .setDescription(`${targetUser.tag} is already in the whitelist.`)
              .setTimestamp();
            return interaction.reply({ embeds: [embed], flags: 64 });
          }

          if (result.status === 'invalid') {
            return replyError(interaction, 'Invalid whitelist request.', { flags: 64 });
          }

          if (result.status === 'approved') {
            const addEmbed = new EmbedBuilder()
              .setColor('#00FF00')
              .setTitle('✅ User Added to Whitelist')
              .setDescription(`${targetUser.tag} is now immune to automatic anti-nuke bans.`)
              .addFields(
                { name: 'User', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
                { name: 'Approved By', value: interaction.user.tag, inline: true },
                { name: 'Approvals', value: `${result.approvals}/${result.required}`, inline: true }
              )
              .setTimestamp();

            antiNuke.logAction(interaction.guild.id, {
              type: 'whitelist_add',
              executorId: interaction.user.id,
              targetUserId: targetUser.id,
              approvals: result.approvals,
              required: result.required
            });

            return interaction.reply({ embeds: [addEmbed], flags: 64 });
          }

          const pendingEmbed = new EmbedBuilder()
            .setColor('#FFFF00')
            .setTitle('🟡 Whitelist Approval Pending')
            .setDescription(`${targetUser.tag} requires another admin approval to be whitelisted.`)
            .addFields(
              { name: 'User', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
              { name: 'Approvals', value: `${result.approvals}/${result.required}`, inline: true },
              { name: 'Requested By', value: interaction.user.tag, inline: true }
            )
            .setFooter({ text: result.alreadyApproved ? 'You already approved this request.' : 'Awaiting additional admin approval.' })
            .setTimestamp();

          antiNuke.logAction(interaction.guild.id, {
            type: 'whitelist_pending',
            executorId: interaction.user.id,
            targetUserId: targetUser.id,
            approvals: result.approvals,
            required: result.required
          });

          return interaction.reply({ embeds: [pendingEmbed], flags: 64 });
        }

        case 'remove': {
          if (!targetUser) {
            return replyError(interaction, 'User parameter is required for remove action.', { flags: 64 });
          }

          if (!antiNuke.isWhitelisted(targetUser.id, interaction.guild.id)) {
            const cancelled = typeof antiNuke.cancelWhitelistRequest === 'function'
              ? antiNuke.cancelWhitelistRequest(interaction.guild.id, targetUser.id)
              : false;
            if (!cancelled) {
              const embed = new EmbedBuilder()
                .setColor('#FFFF00')
                .setTitle('⚠️ User Not Whitelisted')
                .setDescription(`${targetUser.tag} is not in the whitelist or pending approval.`)
                .setTimestamp();
              return interaction.reply({ embeds: [embed], flags: 64 });
            }

            const pendingEmbed = new EmbedBuilder()
              .setColor('#00FF00')
              .setTitle('✅ Whitelist Request Cancelled')
              .setDescription(`Cancelled pending whitelist request for ${targetUser.tag}.`)
              .addFields(
                { name: 'User', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
                { name: 'Cancelled By', value: interaction.user.tag, inline: true }
              )
              .setTimestamp();

            antiNuke.logAction(interaction.guild.id, {
              type: 'whitelist_remove',
              executorId: interaction.user.id,
              targetUserId: targetUser.id
            });

            return interaction.reply({ embeds: [pendingEmbed], flags: 64 });
          }

          antiNuke.removeFromWhitelist(interaction.guild.id, targetUser.id);

          const removeEmbed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('✅ User Removed from Whitelist')
            .setDescription(`${targetUser.tag} is no longer immune to automatic anti-nuke bans.`)
            .addFields(
              { name: 'User', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
              { name: 'Removed By', value: interaction.user.tag, inline: true }
            )
            .setTimestamp();

          antiNuke.logAction(interaction.guild.id, {
            type: 'whitelist_remove',
            executorId: interaction.user.id,
            targetUserId: targetUser.id
          });

          return interaction.reply({ embeds: [removeEmbed], flags: 64 });
        }

        case 'list': {
          const whitelist = antiNuke.getWhitelist(interaction.guild.id);
          const pending = typeof antiNuke.getPendingWhitelist === 'function'
            ? antiNuke.getPendingWhitelist(interaction.guild.id)
            : [];
          
          const userPromises = whitelist.map(async userId => {
            try {
              const user = await interaction.client.users.fetch(userId);
              return `<@${userId}> (${user.tag})`;
            } catch {
              return `<@${userId}> (Unknown User)`;
            }
          });

          const pendingPromises = pending.map(async entry => {
            const label = `<@${entry.userId}>`;
            const approvals = `${entry.approvals}/${entry.required}`;
            let requestedBy = entry.requestedBy ? `<@${entry.requestedBy}>` : 'Unknown';
            if (entry.requestedBy) {
              try {
                const user = await interaction.client.users.fetch(entry.requestedBy);
                requestedBy = `<@${entry.requestedBy}> (${user.tag})`;
              } catch {
                requestedBy = `<@${entry.requestedBy}>`;
              }
            }
            return `${label} — approvals ${approvals} (requested by ${requestedBy})`;
          });

          const userList = await Promise.all(userPromises);
          const pendingList = await Promise.all(pendingPromises);

          const listEmbed = new EmbedBuilder()
            .setColor('#0000FF')
            .setTitle('📋 Anti-Nuke Whitelist')
            .addFields(
              {
                name: `✅ Whitelisted (${whitelist.length})`,
                value: userList.length ? userList.join('\n') : 'No users are currently whitelisted.',
                inline: false
              },
              {
                name: `🟡 Pending Approvals (${pending.length})`,
                value: pendingList.length ? pendingList.join('\n') : 'No pending whitelist requests.',
                inline: false
              }
            )
            .setFooter({ text: 'Whitelisted users are immune to automatic anti-nuke actions' })
            .setTimestamp();

          return interaction.reply({ embeds: [listEmbed], flags: 64 });

        }

        default:
          return replyError(interaction, 'Invalid action specified.', { flags: 64 });
      }

    } catch (error) {
      console.error('Whitelist command error:', error);
      return replyError(interaction, `Whitelist command failed: ${error.message}`, { flags: 64, title: 'Whitelist Command Failed' });
    }
  }
};
