const { EmbedBuilder } = require('discord.js');
const { hasAdministrator } = require('../lib/permissions');

module.exports = {
  data: {
    name: 'whitelist',
    description: 'Manage anti-nuke whitelist (Admin only)',
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
    // Check admin permissions
    if (!hasAdministrator(interaction.member)) {
      return interaction.reply({ 
        content: '❌ Administrator permission required.', 
        flags: 64 
      });
    }

    const antiNuke = global.antiNuke;
    if (!antiNuke) {
      return interaction.reply({ 
        content: '❌ Anti-nuke system not initialized.', 
        flags: 64 
      });
    }

    const action = interaction.options.getString('action');
    const targetUser = interaction.options.getUser('user');

    try {
      switch (action) {
        case 'add': {
          if (!targetUser) {
            return interaction.reply({ 
              content: '❌ User parameter is required for add action.', 
              flags: 64 
            });
          }

          if (antiNuke.isWhitelisted(targetUser.id)) {
            const embed = new EmbedBuilder()
              .setColor('#FFFF00')
              .setTitle('⚠️ User Already Whitelisted')
              .setDescription(`${targetUser.tag} is already in the whitelist.`)
              .setTimestamp();
            return interaction.reply({ embeds: [embed], flags: 64 });
          }

          antiNuke.addToWhitelist(targetUser.id);

          const addEmbed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('✅ User Added to Whitelist')
            .setDescription(`${targetUser.tag} is now immune to anti-nuke actions.`)
            .addFields(
              { name: 'User', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
              { name: 'Added By', value: interaction.user.tag, inline: true }
            )
            .setTimestamp();

          // Log the action
          antiNuke.logAction(interaction.guild.id, {
            type: 'whitelist_add',
            executorId: interaction.user.id,
            targetUserId: targetUser.id
          });

          return interaction.reply({ embeds: [addEmbed], flags: 64 });
        }

        case 'remove': {
          if (!targetUser) {
            return interaction.reply({ 
              content: '❌ User parameter is required for remove action.', 
              flags: 64 
            });
          }

          if (!antiNuke.isWhitelisted(targetUser.id)) {
            const embed = new EmbedBuilder()
              .setColor('#FFFF00')
              .setTitle('⚠️ User Not Whitelisted')
              .setDescription(`${targetUser.tag} is not in the whitelist.`)
              .setTimestamp();
            return interaction.reply({ embeds: [embed], flags: 64 });
          }

          antiNuke.removeFromWhitelist(targetUser.id);

          const removeEmbed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('✅ User Removed from Whitelist')
            .setDescription(`${targetUser.tag} is no longer immune to anti-nuke actions.`)
            .addFields(
              { name: 'User', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
              { name: 'Removed By', value: interaction.user.tag, inline: true }
            )
            .setTimestamp();

          // Log the action
          antiNuke.logAction(interaction.guild.id, {
            type: 'whitelist_remove',
            executorId: interaction.user.id,
            targetUserId: targetUser.id
          });

          return interaction.reply({ embeds: [removeEmbed], flags: 64 });
        }

        case 'list': {
          const whitelist = antiNuke.getWhitelist();
          
          if (whitelist.length === 0) {
            const embed = new EmbedBuilder()
              .setColor('#0000FF')
              .setTitle('📋 Anti-Nuke Whitelist')
              .setDescription('No users are currently whitelisted.')
              .setTimestamp();
            return interaction.reply({ embeds: [embed], flags: 64 });
          }

          // Fetch user information for whitelisted users
          const userPromises = whitelist.map(async userId => {
            try {
              const user = await interaction.client.users.fetch(userId);
              return `<@${userId}> (${user.tag})`;
            } catch {
              return `<@${userId}> (Unknown User)`;
            }
          });

          const userList = await Promise.all(userPromises);
          
          const listEmbed = new EmbedBuilder()
            .setColor('#0000FF')
            .setTitle('📋 Anti-Nuke Whitelist')
            .setDescription(`**${whitelist.length} whitelisted users:**\n\n${userList.join('\n')}`)
            .addFields(
              { name: 'Total Users', value: whitelist.length.toString(), inline: true },
              { name: 'Persistent', value: '✅ Yes', inline: true }
            )
            .setFooter({ text: 'Whitelisted users are immune to automatic anti-nuke actions' })
            .setTimestamp();

          return interaction.reply({ embeds: [listEmbed], flags: 64 });

        }

        default:
          return interaction.reply({ 
            content: '❌ Invalid action specified.', 
            flags: 64 
          });
      }

    } catch (error) {
      console.error('Whitelist command error:', error);
      
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Whitelist Command Failed')
        .setDescription(`Error: ${error.message}`)
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: 64 });
    }
  }
};
