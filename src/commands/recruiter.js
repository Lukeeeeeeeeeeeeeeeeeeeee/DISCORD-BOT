const db = require('../db_async');
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

      // Basic rows
      const rec = await db.get('SELECT * FROM recruiters WHERE id = ?', member.id);
      const recruits = await db.all('SELECT * FROM recruits WHERE recruiter_id = ? ORDER BY created_at DESC LIMIT 5', member.id);
      const totalAllRow = await db.get('SELECT COUNT(*) as c FROM recruits WHERE recruiter_id = ? AND valid = 1', member.id);
      const totalAll = totalAllRow ? totalAllRow.c : 0;

      // Last 28 days stats
      const since28 = Date.now() - (28*24*60*60*1000);
      const recentRows = await db.all('SELECT * FROM recruits WHERE recruiter_id = ? AND created_at >= ? AND valid = 1', member.id, since28);
      const total28 = recentRows.length;
      // distinct weeks in last 28 days
      const weekStarts = new Set(recentRows.map(r => Math.floor((r.created_at - since28) / (7*24*60*60*1000))));
      const distinctWeeks = Math.max(1, Math.min(4, weekStarts.size || 1));

      // Last recruit timestamp
      const lastRow = await db.get('SELECT created_at FROM recruits WHERE recruiter_id = ? AND valid = 1 ORDER BY created_at DESC LIMIT 1', member.id);
      const lastTs = lastRow ? lastRow.created_at : null;
      const daysSinceLast = lastTs ? Math.floor((Date.now() - lastTs) / (24*60*60*1000)) : null;

      const flags = await db.get('SELECT COUNT(*) as c FROM flags WHERE recruiter_id = ?', member.id);
      const warnings = await db.get('SELECT COUNT(*) as c FROM warnings WHERE recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)', member.id, Date.now());

      // Active multiplier and multiplier history
      const econ = require('../lib/economy');
      const mul = await econ.getActiveMultiplier(db, member.id);
      const multipliers = await db.all('SELECT * FROM multipliers WHERE recruiter_id = ? ORDER BY expires_at DESC', member.id);

      // Purchases and flags/warnings samples
      const purchases = await db.all('SELECT * FROM purchases WHERE recruiter_id = ? ORDER BY created_at DESC LIMIT 5', member.id);
      const recentFlags = await db.all('SELECT * FROM flags WHERE recruiter_id = ? ORDER BY created_at DESC LIMIT 5', member.id);
      const recentWarnings = await db.all('SELECT * FROM warnings WHERE recruiter_id = ? ORDER BY created_at DESC LIMIT 5', member.id);

      // Attempt to compute retention via message-scan (fallback to heuristic true)
      let retention = null;
      try {
        const recruitedIds = recentRows.map(r => r.recruited_id);
        retention = recruitedIds.length ? await econ.computeRetentionFromGuild(interaction.guild, recruitedIds, 7, 15, { fallbackToHeuristic: true }) : 0;
      } catch (e) {
        retention = -1;
      }

      // Determine recruiter role by fetching guild member (best-effort)
      let recruiterRole = 'UNKNOWN';
      try {
        const recMember = await interaction.guild.members.fetch(member.id).catch(()=>null);
        if (recMember) {
          const ROLE_IDS = require('../constants').ROLE_IDS;
          if (recMember.roles.cache.has(ROLE_IDS.VIP)) recruiterRole = 'VIP';
          else if (recMember.roles.cache.has(ROLE_IDS.MVP)) recruiterRole = 'MVP';
          else if (recMember.roles.cache.has(ROLE_IDS.CUSTOM)) recruiterRole = 'CUSTOM';
          else recruiterRole = 'NONE';
        }
      } catch (e) {
        recruiterRole = 'UNKNOWN';
      }

      // Min recruits calculation
      const roleModifier = (recruiterRole && econ.ECONOMY_CONFIG.ROLE_MODIFIERS[recruiterRole]) || econ.ECONOMY_CONFIG.ROLE_MODIFIERS.NONE;
      const channelBase = rec && rec.channel_base ? rec.channel_base : econ.ECONOMY_CONFIG.BASE_VALUE;
      const minReq = econ.calculateMinRecruitsRequired({ channelBase, roleModifier, total28d: total28, distinctWeeks, retention: Math.max(0, Math.min(1, retention === -1 ? 0 : retention)), activeWarnings: warnings ? warnings.c : 0, daysSinceLastRecruit: daysSinceLast || Number.POSITIVE_INFINITY, activeMultiplierValue: mul.value || 1.0 });

      const recentText = recruits.length ? recruits.map(r => `<@${r.recruited_id}> (${new Date(r.created_at).toUTCString().replace(' GMT','')}) — ${r.points || 0} pts`).join('\n') : 'None';

      const embed = new EmbedBuilder()
        .setTitle(`Recruiter: ${member.tag}`)
        .addFields(
          { name: 'Points', value: `${rec ? rec.points : 0}`, inline: true },
          { name: 'Active Multiplier', value: mul && mul.type ? `${mul.type} — ×${mul.value}` : 'None', inline: true },
          { name: 'Total recruits (all time)', value: `${totalAll}`, inline: true },
          { name: 'Warnings (active)', value: `${warnings ? warnings.c : 0}`, inline: true },
          { name: 'Flags (total)', value: `${flags ? flags.c : 0}`, inline: true },
          { name: 'Min recruits required', value: `${minReq}`, inline: true }
        )
        .addFields({ name: 'Recent recruits (last 5)', value: recentText || 'None' })
        .setColor(0x00CC66)
        .setTimestamp();

      // Add compact summaries for purchases/multipliers if present
      if (purchases.length) embed.addFields({ name: 'Recent purchases', value: purchases.map(p=>`${p.item} — ${p.cost} pts`).join('\n') });
      if (multipliers.length) embed.addFields({ name: 'Multipliers (recent)', value: multipliers.slice(0,3).map(m=>`${m.type} ×${m.value} (exp ${new Date(m.expires_at).toUTCString()})`).join('\n') });
      if (recentFlags.length) embed.addFields({ name: 'Recent flags', value: recentFlags.map(f=>`${new Date(f.created_at).toUTCString()} — ${f.reason}`).join('\n') });
      if (recentWarnings.length) embed.addFields({ name: 'Recent warnings', value: recentWarnings.map(w=>`${new Date(w.created_at).toUTCString()} — ${w.note || ''}`).join('\n') });

      // Additional info footnote
      embed.setFooter({ text: `Retention: ${retention === -1 ? 'unknown' : (Math.round((retention||0)*100) + '%')} • Last recruit: ${lastTs ? new Date(lastTs).toUTCString() : 'Never'}` });

      return interaction.reply({ embeds: [embed], ephemeral: false });
    }

    if (sub === 'buy') {
      const item = interaction.options.getString('item');
      const userId = interaction.user.id;
      const rec = await db.get('SELECT * FROM recruiters WHERE id = ?', userId);
      const points = rec ? rec.points : 0;

      // Check if item is a multiplier type
      const { ECONOMY_CONFIG, applyMultiplier } = require('../lib/economy');
      const multCfg = ECONOMY_CONFIG.MULTIPLIERS[item];
      if (multCfg) {
        const cost = multCfg.cost;
        if (points < cost) return interaction.reply({ content: 'Not enough points to buy that multiplier.', flags: 64 });
        await db.run('UPDATE recruiters SET points = points - ? WHERE id = ?', cost, userId);
        await applyMultiplier(db, userId, item);
        await db.run('INSERT INTO purchases (recruiter_id, item, cost, created_at) VALUES (?, ?, ?, ?)', userId, item, cost, Date.now());
        const embed = new EmbedBuilder().setTitle('Multiplier Purchased').setDescription(`Applied **${item}** for ${multCfg.days} days for **${cost}** points.`).setColor(0x00AAFF).setTimestamp();
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      const cost = PURCHASE_ITEMS[item];
      if (!cost) return interaction.reply({ content: 'Unknown item.', flags: 64 });
      if (points < cost) return interaction.reply({ content: 'Not enough points.', flags: 64 });
      // Deduct
      await db.run('UPDATE recruiters SET points = points - ? WHERE id = ?', cost, userId);
      await db.run('INSERT INTO purchases (recruiter_id, item, cost, created_at) VALUES (?, ?, ?, ?)', userId, item, cost, Date.now());

      // handle role grants for vip/mvp
      try {
        if (item === 'vip-role') {
          const ROLE_IDS = require('../constants').ROLE_IDS;
          const memberRec = await interaction.guild.members.fetch(userId).catch(()=>null);
          if (memberRec && ROLE_IDS.VIP) await memberRec.roles.add(ROLE_IDS.VIP).catch(()=>{});
        }
        if (item === 'mvp-role') {
          const ROLE_IDS = require('../constants').ROLE_IDS;
          const memberRec = await interaction.guild.members.fetch(userId).catch(()=>null);
          if (memberRec && ROLE_IDS.MVP) await memberRec.roles.add(ROLE_IDS.MVP).catch(()=>{});
        }
      } catch (e) {
        // best-effort
      }

      const embed = new EmbedBuilder().setTitle('Purchase Complete').setDescription(`Purchased **${item}** for **${cost}** points.`).setColor(0x00AAFF).setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'warn') {
      // admin only
      if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: 'Admin only.', ephemeral: true });
      const member = interaction.options.getUser('member');
      const note = interaction.options.getString('note') || 'Manual warning by staff';
      const expiresDays = interaction.options.getInteger('expires_days');

      try {
        // Insert warning and increment counter atomically
        const createdAt = Date.now();
        const expiredAt = expiresDays ? (createdAt + (expiresDays * 24 * 60 * 60 * 1000)) : null;
        await db.run('BEGIN TRANSACTION');
        try {
          await db.run('INSERT INTO warnings (recruiter_id, created_at, note, expired_at) VALUES (?, ?, ?, ?)', member.id, createdAt, note, expiredAt);
          await db.run('UPDATE recruiters SET warnings = warnings + 1 WHERE id = ?', member.id);
          await db.run('COMMIT');
        } catch (e) {
          await db.run('ROLLBACK');
          throw e;
        }

        // DM the user with an embed
        const { EmbedBuilder } = require('discord.js');
        const warnEmbed = new EmbedBuilder()
          .setTitle('⚠️ You have received a warning')
          .setDescription(`**Reason:** ${note}${expiredAt ? `\n**Expires:** ${new Date(expiredAt).toUTCString()}` : ''}`)
          .setColor(0xFF8800)
          .setTimestamp();
        try {
          const m = await interaction.guild.members.fetch(member.id).catch(()=>null);
          if (m) await m.send({ embeds: [warnEmbed] }).catch(()=>{});
        } catch (e) {
          console.error('Failed to DM warned member', { memberId: member.id, error: e });
        }

        // Post to staff channel as embed with context
        const { CHANNELS } = require('../constants');
        const ch = interaction.guild.channels.cache.get(CHANNELS.RECRUITER_WARNINGS);
        if (ch) {
          const staffEmbed = new EmbedBuilder()
            .setTitle('⚠️ Recruiter Warning Issued')
            .addFields(
              { name: 'Recruiter', value: `<@${member.id}>`, inline: true },
              { name: 'By', value: `<@${interaction.user.id}>`, inline: true },
              { name: 'Reason', value: note, inline: false }
            )
            .setColor(0xFF4400)
            .setTimestamp();
          if (expiredAt) staffEmbed.addFields({ name: 'Expires', value: new Date(expiredAt).toUTCString(), inline: true });
          ch.send({ embeds: [staffEmbed] }).catch((e)=> console.error('Failed to post warning to channel', { channelId: ch.id, error: e }));
        }

        console.info('Warning issued', { recruiterId: member.id, by: interaction.user.id, note, expiredAt });

        return interaction.reply({ content: `Warning issued to ${member.tag}. ✅`, flags: 64 });
      } catch (e) {
        console.error('Failed to issue warning', { error: e });
        return interaction.reply({ content: 'Failed to issue warning.', flags: 64 });
      }
    }

    if (sub === 'revoke') {
      // admin only
      if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: 'Admin only.', ephemeral: true });
      const member = interaction.options.getUser('member');
      const warningId = interaction.options.getInteger('warning_id');
      try {
        if (warningId) {
          await db.run('UPDATE warnings SET revoked = 1 WHERE id = ? AND recruiter_id = ?', warningId, member.id);
        } else {
          await db.run('UPDATE warnings SET revoked = 1 WHERE recruiter_id = ?', member.id);
        }
        // Recompute warnings count
        const cntRow = await db.get('SELECT COUNT(*) as c FROM warnings WHERE recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)', member.id, Date.now());
        const active = cntRow ? cntRow.c : 0;
        await db.run('UPDATE recruiters SET warnings = ? WHERE id = ?', active, member.id);

        // Notify staff channel
        const { EmbedBuilder } = require('discord.js');
        const ch = interaction.guild.channels.cache.get(require('../constants').CHANNELS.RECRUITER_WARNINGS);
        if (ch) {
          const embed = new EmbedBuilder()
            .setTitle('🧾 Warning Revoked')
            .setDescription(`<@${member.id}> has had ${warningId ? `warning #${warningId}` : 'all warnings'} revoked by <@${interaction.user.id}>`)
            .setColor(0x00CC66)
            .setTimestamp();
          ch.send({ embeds: [embed] }).catch(()=>{});
        }

        return interaction.reply({ content: `Revoked ${warningId ? `warning #${warningId}` : 'all warnings'} for ${member.tag}. ✅`, flags: 64 });
      } catch (e) {
        console.error('Failed to revoke warnings', { error: e });
        return interaction.reply({ content: 'Failed to revoke warnings.', flags: 64 });
      }
    }

    if (sub === 'multiplier-list') {
      // Show available multipliers and costs
      const econ = require('../lib/economy');
      const { ECONOMY_CONFIG } = econ;
      const entries = Object.entries(ECONOMY_CONFIG.MULTIPLIERS).map(([k,v]) => `**${k}** — ×${v.value} for ${v.days}d — **${v.cost}** pts`).join('\n');
      const embed = new EmbedBuilder().setTitle('Available Multipliers').setDescription(entries || 'None').setColor(0x00AAFF).setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'multiplier-view') {
      // View active multiplier for a recruiter (self or admin for others)
      const member = interaction.options.getUser('member') || interaction.user;
      if (member.id !== interaction.user.id && !interaction.member.permissions.has('Administrator')) return interaction.reply({ content: 'Admin only to view others.', flags: 64 });
      const econ = require('../lib/economy');
      const m = await econ.getActiveMultiplier(db, member.id);
      const embed = new EmbedBuilder().setTitle(`Multiplier for ${member.tag}`).setDescription(m.type ? `**${m.type}** — ×${m.value} (expires ${m.expiresAt ? new Date(m.expiresAt).toUTCString() : 'N/A'})` : 'No active multiplier').setColor(0x00AAFF).setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'multiplier-active') {
      // Admin: list all active multipliers server-wide
      if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: 'Admin only.', ephemeral: true });
      try {
        const rows = await db.all('SELECT recruiter_id, type, value, expires_at FROM multipliers WHERE expires_at > ? ORDER BY recruiter_id, expires_at', Date.now());
        if (!rows || rows.length === 0) return interaction.reply({ content: 'No active multipliers.', flags: 64 });
        // Group by recruiter
        const byRec = rows.reduce((acc, r) => {
          acc[r.recruiter_id] = acc[r.recruiter_id] || [];
          acc[r.recruiter_id].push(r);
          return acc;
        }, {});
        const lines = Object.entries(byRec).map(([rid, arr]) => {
          const list = arr.map(a => `**${a.type}** ×${a.value} (expires ${new Date(a.expires_at).toUTCString()})`).join('\n');
          return `<@${rid}>\n${list}`;
        });
        const embed = new EmbedBuilder().setTitle('Active Multipliers').setDescription(lines.join('\n\n')).setColor(0x00AAFF).setTimestamp();
        return interaction.reply({ embeds: [embed], ephemeral: true });
      } catch (e) {
        console.error('Failed to list active multipliers', e);
        return interaction.reply({ content: 'Failed to list active multipliers.', flags: 64 });
      }
    }

    if (sub === 'multiplier-apply') {
      if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: 'Admin only.', ephemeral: true });
      const member = interaction.options.getUser('member');
      const type = interaction.options.getString('type');
      try {
        const econ = require('../lib/economy');
        const sqlite3 = require('sqlite3');
        const { open } = require('sqlite');
        const localDb = await open({ filename: process.env.DATABASE_PATH, driver: sqlite3.Database });
        const cfg = await econ.applyMultiplier(localDb, member.id, type);
        await localDb.close();
        const { EmbedBuilder } = require('discord.js');
        const ch = interaction.guild.channels.cache.get(require('../constants').CHANNELS.RECRUITER_WARNINGS);
        if (ch) ch.send({ embeds: [ new EmbedBuilder().setTitle('✅ Multiplier Applied').setDescription(`<@${member.id}> granted multiplier **${type}** by <@${interaction.user.id}>`).setTimestamp() ] }).catch(()=>{});
        return interaction.reply({ content: `Applied multiplier ${type} to ${member.tag}. ✅`, flags: 64 });
      } catch (e) {
        console.error('Failed to apply multiplier', e);
        return interaction.reply({ content: 'Failed to apply multiplier.', flags: 64 });
      }
    }

    if (sub === 'multiplier-reset') {
      if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: 'Admin only.', ephemeral: true });
      const member = interaction.options.getUser('member');
      try {
        const econ = require('../lib/economy');
        const sqlite3 = require('sqlite3');
        const { open } = require('sqlite');
        const localDb = await open({ filename: process.env.DATABASE_PATH, driver: sqlite3.Database });
        await econ.resetMultipliers(localDb, member.id);
        await localDb.close();
        const { EmbedBuilder } = require('discord.js');
        const ch = interaction.guild.channels.cache.get(require('../constants').CHANNELS.RECRUITER_WARNINGS);
        if (ch) ch.send({ embeds: [ new EmbedBuilder().setTitle('✅ Multipliers Reset').setDescription(`Multipliers reset for <@${member.id}> by <@${interaction.user.id}>`).setTimestamp() ] }).catch(()=>{});
        return interaction.reply({ content: `Reset multipliers for ${member.tag}. ✅`, flags: 64 });
      } catch (e) {
        console.error('Failed to reset multipliers', e);
        return interaction.reply({ content: 'Failed to reset multipliers.', flags: 64 });
      }
    }

    if (sub === 'dismiss') {
      // admin only
      if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: 'Admin only.', ephemeral: true });
      const member = interaction.options.getUser('member');
      const reason = interaction.options.getString('reason') || 'Dismissed by staff';
      try {
        await db.run('UPDATE flags SET dismissed = 1 WHERE recruiter_id = ?', member.id);
        const { EmbedBuilder } = require('discord.js');
        const ch = interaction.guild.channels.cache.get(require('../constants').CHANNELS.RECRUITER_WARNINGS);
        if (ch) {
          const embed = new EmbedBuilder()
            .setTitle('✅ Flags Dismissed')
            .setDescription(`Flags for <@${member.id}> dismissed by <@${interaction.user.id}>`)
            .addFields({ name: 'Reason', value: reason })
            .setColor(0x00CC66)
            .setTimestamp();
          ch.send({ embeds: [embed] }).catch(e => console.error('Failed to post dismiss to channel', { error: e, channelId: ch.id }));
        }
        console.info('Flags dismissed', { recruiterId: member.id, by: interaction.user.id, reason });
        return interaction.reply({ content: `Flags for ${member.tag} dismissed. ✅`, flags: 64 });
      } catch (e) {
        console.error('Failed to dismiss flags', { error: e });
        return interaction.reply({ content: 'Failed to dismiss flags.', flags: 64 });
      }
    }
  }
};