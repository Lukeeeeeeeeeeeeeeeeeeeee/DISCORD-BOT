const db = require('../db');
const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder } = require('discord.js');
const { PURCHASE_ITEMS } = require('../constants');

module.exports = {
  data: { name: 'recruiter' },
  async execute(interaction) {
    // support subcommands: info, buy
    const sub = interaction.options.getSubcommand();
    if (sub === 'info') {
      const member = interaction.options.getUser('member') || interaction.user;
      const rec = db.prepare('SELECT * FROM recruiters WHERE id = ?').get(member.id);
      const recruits = db.prepare('SELECT * FROM recruits WHERE recruiter_id = ? ORDER BY created_at DESC LIMIT 5').all(member.id);
      const flags = db.prepare('SELECT COUNT(*) as c FROM flags WHERE recruiter_id = ?').get(member.id);
      const warnings = db.prepare('SELECT COUNT(*) as c FROM warnings WHERE recruiter_id = ?').get(member.id);
      const recentText = recruits.length ? recruits.map(r => `<@${r.recruited_id}> (${new Date(r.created_at).toUTCString().replace(' GMT','')})`).join('\n') : 'None';
      const embed = new EmbedBuilder()
        .setTitle(`Recruiter: ${member.tag}`)
        .addFields(
          { name: 'Points', value: `${rec ? rec.points : 0}`, inline: true },
          { name: 'Warnings', value: `${warnings.c}`, inline: true },
          { name: 'Flags', value: `${flags.c}`, inline: true }
        )
        .addFields({ name: 'Recent recruits (last 5)', value: recentText || 'None' })
        .setColor(0x00CC66)
        .setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: false });
    }

    if (sub === 'buy') {
      const item = interaction.options.getString('item');
      const userId = interaction.user.id;
      const rec = db.prepare('SELECT * FROM recruiters WHERE id = ?').get(userId);
      const points = rec ? rec.points : 0;
      const cost = PURCHASE_ITEMS[item];
      if (!cost) return interaction.reply({ content: 'Unknown item.', ephemeral: true });
      if (points < cost) return interaction.reply({ content: 'Not enough points.', ephemeral: true });
      // Deduct
      db.prepare('UPDATE recruiters SET points = points - ? WHERE id = ?').run(cost, userId);
      db.prepare('INSERT INTO purchases (recruiter_id, item, cost, created_at) VALUES (?, ?, ?, ?)').run(userId, item, cost, Date.now());
      const embed = new EmbedBuilder().setTitle('Purchase Complete').setDescription(`Purchased **${item}** for **${cost}** points.`).setColor(0x00AAFF).setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'warn') {
      // admin only
      if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: 'Admin only.', ephemeral: true });
      const member = interaction.options.getUser('member');
      const note = interaction.options.getString('note') || 'Manual warning by staff';
      db.prepare('INSERT INTO warnings (recruiter_id, created_at, note) VALUES (?, ?, ?)').run(member.id, Date.now(), note);
      db.prepare('UPDATE recruiters SET warnings = warnings + 1 WHERE id = ?').run(member.id);
      // DM if possible
      try {
        const m = await interaction.guild.members.fetch(member.id).catch(()=>null);
        if (m) await m.send(`You have received a warning: ${note}`).catch(()=>{});
      } catch (e) {}
      const { CHANNELS } = require('../constants');
      const ch = interaction.guild.channels.cache.get(CHANNELS.RECRUITER_WARNINGS);
      if (ch) ch.send(`<@${member.id}> has been issued a warning by <@${interaction.user.id}>: ${note}`).catch(()=>{});
      return interaction.reply({ content: `Warning issued to ${member.tag}.`, ephemeral: true });
    }

    if (sub === 'dismiss') {
      // admin only
      if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: 'Admin only.', ephemeral: true });
      const member = interaction.options.getUser('member');
      const reason = interaction.options.getString('reason') || 'Dismissed by staff';
      // Mark flags dismissed
      db.prepare('UPDATE flags SET dismissed = 1 WHERE recruiter_id = ?').run(member.id);
      const ch = interaction.guild.channels.cache.get(require('../constants').CHANNELS.RECRUITER_WARNINGS);
      if (ch) ch.send(`<@${member.id}>'s flags dismissed by <@${interaction.user.id}>: ${reason}`).catch(()=>{});
      return interaction.reply({ content: `Flags for ${member.tag} dismissed.`, ephemeral: true });
    }
  }
};