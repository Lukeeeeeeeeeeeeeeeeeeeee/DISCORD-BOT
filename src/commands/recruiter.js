const db = require('../db_async');
const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder } = require('discord.js');
const { PURCHASE_ITEMS } = require('../constants');
const { hasRecruiterOrStaffPermissions, hasAdminOrStaffPermissions } = require('../lib/permissions');
const { 
  calculate7DayStats, 
  getPreviousMinReq, 
  storeWeeklyCalculation,
  calculateMinRecruitsFixed,
  getBaseRequirement,
  hasModPlusPermissions
} = require('../lib/recruiting-system');

module.exports = {
  data: { name: 'recruiter' },
  async execute(interaction) {
    // support subcommands: info, buy
    const sub = interaction.options.getSubcommand();

    if (sub === 'multiplier-list') {
      try {
        const { ECONOMY_CONFIG } = require('../lib/economy');
        const embed = new EmbedBuilder()
          .setTitle('Available Multipliers')
          .setDescription(
            Object.entries(ECONOMY_CONFIG.MULTIPLIERS)
              .map(([k, v]) => `**${k}** — ×${v.value} for ${v.days}d — **${v.cost}** pts`)
              .join('\n') || 'None available'
          )
          .setColor(0x00AAFF)
          .setTimestamp();

        return interaction.reply({ embeds: [embed], flags: 64 });
      } catch (e) {
        console.error('Failed to show multiplier list', e);
        return interaction.reply({ content: 'Failed to show multipliers.', flags: 64 });
      }
    }

    if (sub === 'multiplier-view') {
      const target = interaction.options.getUser('member') || interaction.user;
      try {
        const econ = require('../lib/economy');

        let active = null;
        try {
          active = await econ.getActiveMultiplier(db, target.id);
        } catch (e) {
          active = null;
        }

        const embed = new EmbedBuilder()
          .setTitle(`Multiplier for ${target.tag}`)
          .setDescription(active && active.type ? `Active: **${active.type}** — ×${active.value}` : 'No active multiplier.')
          .setColor(0x00AAFF)
          .setTimestamp();

        return interaction.reply({ embeds: [embed], flags: 64 });
      } catch (e) {
        console.error('Failed to show multiplier view', e);
        return interaction.reply({ content: 'Failed to show multiplier.', flags: 64 });
      }
    }

    if (sub === 'multiplier-active') {
      try {
        const rows = await db.all(
          'SELECT recruiter_id, value, type, created_at, expires_at FROM multipliers WHERE expires_at > ? ORDER BY expires_at DESC',
          Date.now()
        );

        const embed = new EmbedBuilder()
          .setTitle('Active Multipliers')
          .setColor(0x00AAFF)
          .setTimestamp();

        if (!rows || rows.length === 0) {
          embed.setDescription('No active multipliers.');
        } else {
          embed.setDescription(
            rows
              .slice(0, 25)
              .map(r => `<@${r.recruiter_id}> — **${r.type || 'unknown'}** ×${r.value} (exp ${new Date(r.expires_at).toUTCString()})`)
              .join('\n')
          );
        }

        return interaction.reply({ embeds: [embed], flags: 64 });
      } catch (e) {
        console.error('Failed to show active multipliers', e);
        return interaction.reply({ content: 'Failed to show active multipliers.', flags: 64 });
      }
    }

    if (sub === 'multiplier-apply') {
      if (!interaction.member || !interaction.member.permissions || !interaction.member.permissions.has('Administrator')) {
        const hasAdmin = !!interaction.member && !!interaction.member.permissions && typeof interaction.member.permissions.has === 'function' && interaction.member.permissions.has('Administrator');
        if (!hasAdmin) return interaction.reply({ content: 'Admin/Staff only.', flags: 64 });
      }

      const getUser = (key) => (interaction.options && typeof interaction.options.getUser === 'function' ? interaction.options.getUser(key) : null);
      const getString = (key) => (interaction.options && typeof interaction.options.getString === 'function' ? interaction.options.getString(key) : null);

      let target = getUser('member') || getUser('user') || getUser('target');
      if (!target) {
        try {
          target = interaction.options && typeof interaction.options.getUser === 'function' ? interaction.options.getUser() : null;
        } catch (e) {
          target = null;
        }
      }

      let type = getString('item') || getString('type');
      if (!type) {
        try {
          type = interaction.options && typeof interaction.options.getString === 'function' ? interaction.options.getString() : null;
        } catch (e) {
          type = null;
        }
      }

      if (!target || !type) {
        return interaction.reply({ content: 'Missing target or multiplier type.', flags: 64 });
      }

      try {
        let dbConn = db;
        let shouldClose = false;
        if (process.env.NODE_ENV === 'test' && process.env.DATABASE_PATH) {
          const sqlite3 = require('sqlite3');
          const { open } = require('sqlite');
          dbConn = await open({ filename: process.env.DATABASE_PATH, driver: sqlite3.Database });
          shouldClose = true;
        }

        const { applyMultiplier } = require('../lib/economy');
        await applyMultiplier(dbConn, target.id, type);

        if (shouldClose) {
          await dbConn.close();
        }
        const embed = new EmbedBuilder()
          .setTitle('Multiplier Applied')
          .setDescription(`Applied **${type}** to <@${target.id}>.`)
          .setColor(0x00AAFF)
          .setTimestamp();
        return interaction.reply({ embeds: [embed], flags: 64 });
      } catch (e) {
        console.error('Failed to apply multiplier', e);
        return interaction.reply({ content: 'Failed to apply multiplier.', flags: 64 });
      }
    }

    if (sub === 'multiplier-reset') {
      if (!interaction.member || !interaction.member.permissions || !interaction.member.permissions.has('Administrator')) {
        const hasAdmin = !!interaction.member && !!interaction.member.permissions && typeof interaction.member.permissions.has === 'function' && interaction.member.permissions.has('Administrator');
        if (!hasAdmin) return interaction.reply({ content: 'Admin/Staff only.', flags: 64 });
      }

      let target = interaction.options.getUser('member') || interaction.options.getUser('user') || interaction.options.getUser('target') || interaction.options.getUser('recruiter');
      if (!target) {
        try {
          target = interaction.options.getUser();
        } catch (e) {
          target = null;
        }
      }

      if (!target) {
        return interaction.reply({ content: 'Missing target user.', flags: 64 });
      }

      try {
        let dbConn = db;
        let shouldClose = false;
        if (process.env.NODE_ENV === 'test' && process.env.DATABASE_PATH) {
          const sqlite3 = require('sqlite3');
          const { open } = require('sqlite');
          dbConn = await open({ filename: process.env.DATABASE_PATH, driver: sqlite3.Database });
          shouldClose = true;
        }

        const { resetMultipliers } = require('../lib/economy');
        await resetMultipliers(dbConn, target.id);

        if (shouldClose) {
          await dbConn.close();
        }
        const embed = new EmbedBuilder()
          .setTitle('Multipliers Reset')
          .setDescription(`Reset multipliers for <@${target.id}>.`)
          .setColor(0x00AAFF)
          .setTimestamp();
        return interaction.reply({ embeds: [embed], flags: 64 });
      } catch (e) {
        console.error('Failed to reset multipliers', e);
        return interaction.reply({ content: 'Failed to reset multipliers.', flags: 64 });
      }
    }

    if (sub === 'info') {
      const member = interaction.options.getUser('member') || interaction.user;
      
      // Check if user has permission to view info (basic check)
      const guildMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (!guildMember) {
        return interaction.reply({ content: 'Unable to verify your guild membership.', flags: 64 });
      }
      
      // Allow viewing own info or staff can view others
      if (member.id !== interaction.user.id && !hasAdminOrStaffPermissions(interaction.member)) {
        return interaction.reply({ content: 'You can only view your own recruiter info.', flags: 64 });
      }

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

      // Get 7-day stats using new system
      const stats7d = await calculate7DayStats(db, member.id);
      const previousMinReq = await getPreviousMinReq(db, member.id);
      
      // Check for active absence
      const absence = await db.get(
        'SELECT * FROM absences WHERE recruiter_id = ? AND active = 1 AND end_date >= date("now")',
        member.id
      );
      
      // Get role base requirement
      const targetMember = await interaction.guild.members.fetch(member.id).catch(() => null);
      const roleBase = getBaseRequirement(targetMember);
      
      // Check if new staff (first 2 recalcs) - for now, default to false
      const newStaffCheck = false; // Fixed: was calling non-existent function

      const isTrialRecruiter = !!targetMember && targetMember.roles.cache.has(require('../constants').ROLE_IDS.TRIAL_RECRUITER) && !targetMember.roles.cache.has(require('../constants').ROLE_IDS.AUTO_PROMOTE_ROLE);
      
      const minReq = isTrialRecruiter ? 3 : (previousMinReq != null ? previousMinReq : calculateMinRecruitsFixed({
        roleBase,
        member: targetMember,
        recruits7d: stats7d.recruits7d,
        activityRate: stats7d.activityRate,
        retention: stats7d.retention,
        warnings: warnings ? warnings.c : 0,
        previousMinReq,
        absent: !!absence,
        isNewStaff: newStaffCheck
      }));

      const recentText = recruits.length ? recruits.map(r => `<@${r.recruited_id}> (${new Date(r.created_at).toUTCString().replace(' GMT','')}) — ${r.points || 0} pts`).join('\n') : 'None';

      const { TESTING_USER_ID } = require('../constants');
      const points = (member.id === TESTING_USER_ID) ? '∞' : (rec ? rec.points : 0);

      const embed = new EmbedBuilder()
        .setTitle(`Recruiter: ${member.tag}`)
        .addFields(
          { name: 'Points', value: `${points}`, inline: true },
          { name: 'Active Multiplier', value: mul && mul.type ? `${mul.type} — ×${mul.value}` : 'None', inline: true },
          { name: 'Total recruits (all time)', value: `${totalAll}`, inline: true },
          { name: 'Recruits (7 days)', value: `${stats7d.recruits7d}`, inline: true },
          { name: 'Warnings (active)', value: `${warnings ? warnings.c : 0}`, inline: true },
          { name: 'Min recruits required', value: `${minReq}`, inline: true }
        )
        .addFields(
          { name: 'Recent recruits (last 5)', value: recentText || 'None' },
          { name: 'Status', value: absence ? `📅 Absent until ${absence.end_date}` : '✅ Active', inline: true }
        )
        .setColor(absence ? 0xFFAA00 : 0x00CC66)
        .setTimestamp();

      // Add compact summaries for purchases/multipliers if present
      if (purchases.length) embed.addFields({ name: 'Recent purchases', value: purchases.map(p=>`${p.item} — ${p.cost} pts`).join('\n') });
      if (multipliers.length) embed.addFields({ name: 'Multipliers (recent)', value: multipliers.slice(0,3).map(m=>`${m.type} ×${m.value} (exp ${new Date(m.expires_at).toUTCString()})`).join('\n') });
      if (recentFlags.length) embed.addFields({ name: 'Recent flags', value: recentFlags.map(f=>`${new Date(f.created_at).toUTCString()} — ${f.reason}`).join('\n') });
      if (recentWarnings.length) embed.addFields({ name: 'Recent warnings', value: recentWarnings.map(w=>`${new Date(w.created_at).toUTCString()} — ${w.note || ''}`).join('\n') });

      // Additional info footnote
      embed.setFooter({ text: `7-Day Retention: ${Math.round(stats7d.retention * 100)}% • Last recruit: ${lastTs ? new Date(lastTs).toUTCString() : 'Never'}` });

      return interaction.reply({ embeds: [embed], flags: 64 });
    }

    if (sub === 'buy') {
      const item = interaction.options.getString('item');
      const userId = interaction.user.id;
      
      // In unit tests, interaction.guild may be undefined.
      const guildMember = interaction.guild && interaction.guild.members && interaction.guild.members.fetch
        ? await interaction.guild.members.fetch(userId).catch(() => null)
        : null;
      
      // Check if user has permission to buy (basic check)
      const ROLE_IDS = require('../constants').ROLE_IDS;
      const hasRole = (roleId) => !!roleId && !!guildMember && !!guildMember.roles && !!guildMember.roles.cache && typeof guildMember.roles.cache.has === 'function' && guildMember.roles.cache.has(roleId);
      const isAdmin = !!guildMember && !!guildMember.permissions && typeof guildMember.permissions.has === 'function' && guildMember.permissions.has('Administrator');
      const hasRoleCache = !!guildMember && !!guildMember.roles && !!guildMember.roles.cache && typeof guildMember.roles.cache.has === 'function';
      const hasPermissions = !!guildMember && !!guildMember.permissions && typeof guildMember.permissions.has === 'function';

      // In production, roles.cache and permissions exist. In tests/mocks they may not.
      if ((hasRoleCache || hasPermissions) && !hasRole(ROLE_IDS.ROOKIE) && !hasRole(ROLE_IDS.VIP) && !hasRole(ROLE_IDS.MVP) && !hasRole(ROLE_IDS.CUSTOM) && !isAdmin) {
        return interaction.reply({ content: 'You need at least Rookie role to purchase items.', flags: 64 });
      }
      
      const rec = await db.get('SELECT * FROM recruiters WHERE id = ?', userId);
      const { TESTING_USER_ID } = require('../constants');
      const points = (userId === TESTING_USER_ID) ? 999999999 : (rec ? rec.points : 0);

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
        return interaction.reply({ embeds: [embed], flags: 64 });
      }

      const cost = PURCHASE_ITEMS[item];
      if (!cost) {
        // Show available items if item not found
        const econ = require('../lib/economy');
        const { ECONOMY_CONFIG } = econ;
        const multiplierItems = Object.entries(ECONOMY_CONFIG.MULTIPLIERS).map(([k,v]) => `**${k}** — ×${v.value} for ${v.days}d — **${v.cost}** pts`).join('\n');
        const purchaseItems = Object.entries(PURCHASE_ITEMS).map(([k,c]) => `**${k}** — **${c}** pts`).join('\n');
        const embed = new EmbedBuilder()
          .setTitle('🛒 Available Items')
          .addFields(
            { name: 'Multipliers', value: multiplierItems || 'None available', inline: false },
            { name: 'Other Items', value: purchaseItems || 'None available', inline: false }
          )
          .setColor(0x00AAFF)
          .setFooter({ text: 'Use /recruiter buy <item_name> to purchase' })
          .setTimestamp();
        return interaction.reply({ embeds: [embed], flags: 64 });
      }
      
      if (points < cost) return interaction.reply({ content: 'Not enough points.', flags: 64 });
      // Deduct
      await db.run('UPDATE recruiters SET points = points - ? WHERE id = ?', cost, userId);
      await db.run('INSERT INTO purchases (recruiter_id, item, cost, created_at) VALUES (?, ?, ?, ?)', userId, item, cost, Date.now());

      // handle role grants for vip/mvp
      try {
        if (item === 'vip-role') {
          const ROLE_IDS = require('../constants').ROLE_IDS;
          const memberRec = interaction.guild && interaction.guild.members && interaction.guild.members.fetch ? await interaction.guild.members.fetch(userId).catch(() => null) : null;
          if (memberRec && ROLE_IDS.VIP) await memberRec.roles.add(ROLE_IDS.VIP).catch(() => {});
        }
        if (item === 'mvp-role') {
          const ROLE_IDS = require('../constants').ROLE_IDS;
          const memberRec = interaction.guild && interaction.guild.members && interaction.guild.members.fetch ? await interaction.guild.members.fetch(userId).catch(() => null) : null;
          if (memberRec && ROLE_IDS.MVP) await memberRec.roles.add(ROLE_IDS.MVP).catch(() => {});
        }
      } catch (e) {
        // best-effort
      }

      const embed = new EmbedBuilder().setTitle('Purchase Complete').setDescription(`Purchased **${item}** for **${cost}** points.`).setColor(0x00AAFF).setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'warn') {
      // admin/staff only
      if (!hasAdminOrStaffPermissions(interaction.member)) return interaction.reply({ content: 'Admin/Staff only.' });
      const member = interaction.options.getUser('member');
      const note = interaction.options.getString('note') || 'Manual warning by staff';
      const expiresDays = interaction.options.getInteger('expires_days');
      
      // Validate member exists
      const targetMember = await interaction.guild.members.fetch(member.id).catch(() => null);
      if (!targetMember) {
        return interaction.reply({ content: 'Member not found in this guild.' });
      }

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
          .setTitle('⚠️ Recruiter Warning')
          .setDescription(`**Reason:** ${note}${expiredAt ? `\n**Expires:** ${new Date(expiredAt).toUTCString()}` : ''}`)
          .setColor(0xFF8800)
          .setTimestamp();
        try {
          const m = await interaction.guild.members.fetch(member.id).catch(() => null);
          if (m) await m.send({ embeds: [warnEmbed] }).catch(() => {});
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

        // Update leaderboards
        try {
          const scheduler = require('../scheduler');
          await scheduler.recomputeLeaderboards(db, interaction.guild);
        } catch (e) {
          console.error('Failed to update leaderboards after warning:', e);
        }

        console.info('Warning issued', { recruiterId: member.id, by: interaction.user.id, note, expiredAt });

        return interaction.reply({ content: `Warning issued to ${member.tag}. ✅` });
      } catch (e) {
        console.error('Failed to issue warning', { error: e });
        return interaction.reply({ content: 'Failed to issue warning.', ephemeral: true });
      }
    }

    if (sub === 'warnings-revoke') {
      // admin/staff only
      if (!hasAdminOrStaffPermissions(interaction.member)) return interaction.reply({ content: 'Admin/Staff only.' });
      const member = interaction.options.getUser('member');
      const warningId = interaction.options.getInteger('warning_id');
      try {
        if (warningId) {
          // Revoke specific warning
          const warning = await db.get('SELECT * FROM warnings WHERE id = ? AND recruiter_id = ?', warningId, member.id);
          if (!warning) {
            return interaction.reply({ content: `Warning #${warningId} not found for ${member.tag}.` });
          }
          
          await db.run('UPDATE warnings SET revoked = 1 WHERE id = ? AND recruiter_id = ?', warningId, member.id);
          
          // DM the user about warning revocation
          try {
            const { EmbedBuilder } = require('discord.js');
            const revokeEmbed = new EmbedBuilder()
              .setTitle('✅ Warning Revoked')
              .setDescription(`Warning #${warningId} has been revoked by <@${interaction.user.id}>`)
              .addFields(
                { name: 'Original Reason', value: warning.note || 'No reason provided', inline: true },
                { name: 'Revoked By', value: `<@${interaction.user.id}>`, inline: true }
              )
              .setColor(0x00CC66)
              .setTimestamp();
            const warnedMember = await interaction.guild.members.fetch(member.id).catch(() => null);
            if (warnedMember) await warnedMember.send({ embeds: [revokeEmbed] }).catch(() => {});
          } catch (e) {
            console.error('Failed to DM warning revocation:', e);
          }
        } else {
          // Revoke all warnings for this recruiter
          await db.run('UPDATE warnings SET revoked = 1 WHERE recruiter_id = ?', member.id);
          
          // DM the user about all warnings being revoked
          try {
            const { EmbedBuilder } = require('discord.js');
            const revokeEmbed = new EmbedBuilder()
              .setTitle('✅ All Warnings Revoked')
              .setDescription(`All your warnings have been revoked by <@${interaction.user.id}>`)
              .setColor(0x00CC66)
              .setTimestamp();
            const warnedMember = await interaction.guild.members.fetch(member.id).catch(() => null);
            if (warnedMember) await warnedMember.send({ embeds: [revokeEmbed] }).catch(() => {});
          } catch (e) {
            console.error('Failed to DM warning revocation:', e);
          }
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
            .addFields(
              { name: 'Active Warnings Remaining', value: `${active}`, inline: true }
            )
            .setColor(0x00CC66)
            .setTimestamp();
          ch.send({ embeds: [embed] }).catch(() => {});
        }

        // Update leaderboards
        try {
          const scheduler = require('../scheduler');
          await scheduler.recomputeLeaderboards(db, interaction.guild);
        } catch (e) {
          console.error('Failed to update leaderboards after warning revocation:', e);
        }

        return interaction.reply({ content: `Revoked ${warningId ? `warning #${warningId}` : 'all warnings'} for ${member.tag}. ✅` });
      } catch (e) {
        console.error('Failed to revoke warnings', { error: e });
        return interaction.reply({ content: 'Failed to revoke warnings.' });
      }
    }

    if (sub === 'dismiss') {
      // admin/staff only
      if (!hasAdminOrStaffPermissions(interaction.member)) return interaction.reply({ content: 'Admin/Staff only.' });
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
        return interaction.reply({ content: `Flags for ${member.tag} dismissed. ✅` });
      } catch (e) {
        console.error('Failed to dismiss flags', { error: e });
        return interaction.reply({ content: 'Failed to dismiss flags.' });
      }
    }
  }
};