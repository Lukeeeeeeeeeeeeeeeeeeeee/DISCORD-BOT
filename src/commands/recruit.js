const dayjs = require('dayjs');
const { ROLE_IDS } = require('../constants');
const db = require('../db_async');
const { getActiveMultiplier, calculateRecruitPoints } = require('../lib/economy');

module.exports = {
  data: { name: 'recruit' },
  async execute(interaction) {
    try {
      await interaction.deferReply({ flags: 64 });
      const member = interaction.options.getUser('member');
      const region = interaction.options.getString('region');
      const ign = interaction.options.getString('ign');

      // Validate inputs
      if (!member || !region || !ign) {
        return interaction.editReply({ content: 'Missing required parameters. Please provide member, region, and ign.' });
      }

      // Check if user has permission to recruit (basic check)
      const guildMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (!guildMember) {
        return interaction.editReply({ content: 'Unable to verify your guild membership.' });
      }

      // Check if user has required role to recruit (you can customize this)
      const ROLE_IDS = require('../constants').ROLE_IDS;
      if (!guildMember.roles.cache.has(ROLE_IDS.ROOKIE) && !guildMember.roles.cache.has(ROLE_IDS.VIP) && !guildMember.roles.cache.has(ROLE_IDS.MVP) && !guildMember.roles.cache.has(ROLE_IDS.CUSTOM) && !guildMember.permissions.has('Administrator')) {
        return interaction.editReply({ content: 'You do not have permission to recruit members. You need at least Rookie role or higher.' });
      }

      const recruitedGuildMember = await interaction.guild.members.fetch(member.id).catch(() => null);
      if (!recruitedGuildMember) return interaction.editReply({ content: 'Member not found in this guild.' });

      // checks
      if (recruitedGuildMember.user.bot) return interaction.editReply({ content: "Cannot recruit bots." });

      const joinedAt = recruitedGuildMember.joinedAt;
      const now = new Date();
      const minutesSinceJoin = (now - joinedAt) / 1000 / 60;
      if (minutesSinceJoin > 120) return interaction.editReply({ content: 'Cannot give roles to someone who joined more than 2 hours ago.' });

      const accountAgeDays = (now - recruitedGuildMember.user.createdAt) / (1000*60*60*24);
      if (accountAgeDays < (30*6)) return interaction.editReply({ content: 'Account must be at least 6 months old.' });

      // already verified = has rookie
      if (recruitedGuildMember.roles.cache.has(ROLE_IDS.ROOKIE)) return interaction.editReply({ content: 'Member is already verified.' });

      // check if recruited already
      const exist = await db.get('SELECT * FROM recruits WHERE recruited_id = ?', member.id);
      if (exist) return interaction.editReply({ content: 'That member has already been recruited previously.' });

      // assign onboarding role balancing
      const onboardingRoles = ROLE_IDS.ONBOARDING;
      let chosenRole = onboardingRoles[0];
      // simple balancing by counts
      const counts = onboardingRoles.map(r => {
        const c = interaction.guild.roles.cache.get(r)?.members.size || 0;
        return { role: r, count: c };
      });
      counts.sort((a,b)=>a.count-b.count);
      chosenRole = counts[0].role;

      try {
        // remove unverified if present
        if (recruitedGuildMember.roles.cache.has(ROLE_IDS.UNVERIFIED)) await recruitedGuildMember.roles.remove(ROLE_IDS.UNVERIFIED);
        // add rookie
        await recruitedGuildMember.roles.add(ROLE_IDS.ROOKIE);
        // add chosen onboarding role
        await recruitedGuildMember.roles.add(chosenRole);

        // set nickname
        await recruitedGuildMember.setNickname(`${ign} | ${region} 0/10`).catch(()=>null);

        // Determine recruiter role and active multiplier, compute points
        const recruiterMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        let recruiterRole = 'NONE';
        if (recruiterMember) {
          if (recruiterMember.roles.cache.has(ROLE_IDS.VIP)) recruiterRole = 'VIP';
          else if (recruiterMember.roles.cache.has(ROLE_IDS.MVP)) recruiterRole = 'MVP';
          else if (recruiterMember.roles.cache.has(ROLE_IDS.CUSTOM)) recruiterRole = 'CUSTOM';
        }
        const multiplier = await getActiveMultiplier(db, interaction.user.id);
        const points = calculateRecruitPoints({ recruiterRole, multiplierValue: multiplier.value });

        // Database writes in a transaction to avoid partial state
        const nowTs = Date.now();
        await db.run('BEGIN TRANSACTION');
        try {
          await db.run('INSERT INTO recruits (recruiter_id, recruited_id, region, ign, created_at, valid, points) VALUES (?, ?, ?, ?, ?, 1, ?)', interaction.user.id, member.id, region, ign, nowTs, points);
          await db.run('INSERT OR IGNORE INTO recruiters (id, points, warnings, promoted, channel_base) VALUES (?, 0, 0, 0, 4)', interaction.user.id);
          await db.run('UPDATE recruiters SET points = points + ? WHERE id = ?', points, interaction.user.id);
          await db.run('COMMIT');
        } catch (e) {
          await db.run('ROLLBACK');
          throw e;
        }

        // Check for special-role auto-promotion: if they have the special role and got >=3 recruits in last 7 days
        if (recruiterMember && recruiterMember.roles.cache.has(ROLE_IDS.SPECIAL_ROLE)) {
          const cutoff = Date.now() - (7*24*60*60*1000);
          const countRecentRow = await db.get('SELECT COUNT(*) as c FROM recruits WHERE recruiter_id = ? AND created_at >= ?', interaction.user.id, cutoff);
          const countRecent = countRecentRow ? countRecentRow.c : 0;
          if (countRecent >= 3) {
            const recRow = await db.get('SELECT promoted FROM recruiters WHERE id = ?', interaction.user.id);
            if (!recRow || !recRow.promoted) {
              // determine top region in the last 7 days
              const rows = await db.all('SELECT region, COUNT(*) as c FROM recruits WHERE recruiter_id = ? AND created_at >= ? GROUP BY region ORDER BY c DESC', interaction.user.id, cutoff);
              const topRegion = rows.length ? rows[0].region : region;
              const recruiterRoleId = require('../constants').RECRUITER_ROLE_IDS[topRegion];

              // swap roles
              await recruiterMember.roles.remove(ROLE_IDS.SPECIAL_ROLE).catch(() => {});
              await recruiterMember.roles.remove(ROLE_IDS.ROOKIE).catch(() => {});
              await recruiterMember.roles.add(ROLE_IDS.AUTO_PROMOTE_ROLE).catch(() => {});
              if (recruiterRoleId) await recruiterMember.roles.add(recruiterRoleId).catch(() => {});

              await db.run('UPDATE recruiters SET promoted = 1 WHERE id = ?', interaction.user.id);
            }
          }
        }

        // Log to invites channel overall + region and cross-post to central leaderboard channel (use embed)
        const { CHANNELS } = require('../constants');
        const channelOverall = interaction.guild.channels.cache.get(CHANNELS.INVITES_OVERALL);
        const channelRegion = interaction.guild.channels.cache.get(region === 'EU' ? CHANNELS.INVITES_EU : region === 'NA' ? CHANNELS.INVITES_NA : CHANNELS.INVITES_AS);
        const { makeRecruitEmbed } = require('../lib/messages');
        const embed = makeRecruitEmbed(interaction.user.id, member.id, region, ign, process.env.DEFAULT_LANG || 'en', { points, recruiterRole });
        if (channelOverall) channelOverall.send({ embeds: [embed] }).catch(() => {});
        if (channelRegion) channelRegion.send({ embeds: [embed] }).catch(() => {});

        try {
          const scheduler = require('../scheduler');
          await scheduler.recomputeLeaderboards(db, interaction.guild);
        } catch (e) {
          console.error('Failed updating leaderboards:', e);
        }

        return interaction.editReply({ content: `Successfully recruited ${member.tag} as ${region}. Awarded **${points}** points.` });
      } catch (err) {
        console.error('Recruit command error:', err);

        // Handle specific errors
        if (err && err.message && err.message.includes('UNIQUE constraint failed')) {
          return interaction.editReply({ content: 'That member has already been recruited before and cannot be recruited again.' });
        }

        if (err && err.message && err.message.includes('Missing Permissions')) {
          return interaction.editReply({ content: 'Missing permissions to assign roles. Please check bot permissions.' });
        }

        if (err && err.message && err.message.includes('Unknown User')) {
          return interaction.editReply({ content: 'Unable to find one of the users mentioned.' });
        }

        // Generic error
        return interaction.editReply({ content: 'An error occurred while processing the recruit command. Please try again later.' });
      }
    } catch (err) {
      console.error('Recruit command error:', err);
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ content: 'An error occurred while processing the recruit command. Please try again later.' });
      }
      return interaction.reply({ content: 'An error occurred while processing the recruit command. Please try again later.', flags: 64 });
    }
  }
};