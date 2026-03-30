/**
 * /unsend command — Fleet-wide Message Cancellation
 */
'use strict';

const { SlashCommandBuilder } = require('discord.js');
const db = require('../db_async');
const { ensureCommandAccess } = require('../lib/command-auth');
const { replyError } = require('../lib/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unsend')
    .setDescription('Fleet-wide DM cancellation (delete sent messages)')
    .addStringOption(option =>
      option.setName('mode')
        .setDescription('What kind of messages to delete (within last 24h)')
        .setRequired(true)
        .addChoices(
          { name: 'Delete specific phrase', value: 'phrase' },
          { name: 'Delete most recent message', value: 'recent' },
          { name: 'Delete ALL messages in recent DMs', value: 'all' }
        )
    )
    .addStringOption(option =>
      option.setName('target')
        .setDescription('Which bots should execute this? (default: all)')
        .setRequired(false)
        .addChoices(
          { name: 'All Worker Bots + Main', value: 'all' },
          { name: 'Main Bot Only', value: 'main' }
        )
    )
    .addStringOption(option =>
      option.setName('phrase')
        .setDescription('The exact phrase to delete (required if mode is phrase)')
        .setRequired(false)
    ),

  async execute(interaction) {
    const allowed = await ensureCommandAccess(interaction, {
      allowStaff: false,
      deniedMessage: 'Administrator permission required.'
    });
    if (!allowed) return null;

    const mode = interaction.options.getString('mode', true);
    const target = interaction.options.getString('target') || 'all';
    const phrase = interaction.options.getString('phrase');

    if (mode === 'phrase' && !phrase) {
      return replyError(interaction, 'You must provide a `phrase` when using phrase mode.');
    }

    await interaction.deferReply({ flags: 64 });

    try {
      await db.run(
        `INSERT INTO dm_cancellations (target_worker_id, mode, phrase, created_at) VALUES (?, ?, ?, ?)`,
        target, mode, phrase || null, Date.now()
      );

      const targetText = target === 'all' ? 'All Bots' : (target === 'main' ? 'Main Bot Only' : target);
      return interaction.editReply({
        content: `✅ Unsend request queued!\n**Target:** \`${targetText}\`\n**Mode:** \`${mode}\`${phrase ? `\n**Phrase:** \`${phrase}\`` : ''}\n\nThe fleet will automatically scan DMs from the past 24 hours and delete matches within the next 30 seconds.`
      });
    } catch (err) {
      console.error('Error queuing unsend request:', err);
      return replyError(interaction, 'Database error while queuing the request.');
    }
  }
};
