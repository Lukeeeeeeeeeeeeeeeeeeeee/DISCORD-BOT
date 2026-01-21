const dayjs = require('dayjs');
const { ROLE_IDS } = require('../constants');
const db = require('../db_async');
const { getActiveMultiplier, calculateRecruitPoints } = require('../lib/economy');

module.exports = {
  data: { name: 'recruit' },
  async execute(interaction) {
    const member = interaction.options.getUser('member');
    const region = interaction.options.getString('region');
    const ign = interaction.options.getString('ign');

    const guildMember = await interaction.guild.members.fetch(member.id).catch(()=>null);
    if (!guildMember) return interaction.reply({ content: 'Member not found in this guild.', ephemeral: true });

    // checks
    if (guildMember.user.bot) return interaction.reply({ content: "Cannot recruit bots.", ephemeral: true });

    const joinedAt = guildMember.joinedAt;
    const now = new Date();
    const minutesSinceJoin = (now - joinedAt) / 1000 / 60;
    if (minutesSinceJoin > 120) return interaction.reply({ content: 'Cannot give roles to someone who joined more than 2 hours ago.', ephemeral: true });

    const accountAgeDays = (now - guildMember.user.createdAt) / (1000*60*60*24);
    if (accountAgeDays < (30*6)) return interaction.reply({ content: 'Account must be at least 6 months old.', ephemeral: true });

    // already verified = has rookie
    if (guildMember.roles.cache.has(ROLE_IDS.ROOKIE)) return interaction.reply({ content: 'Member is already verified.', ephemeral: true });

    // check if recruited already
    const exist = await db.get('SELECT * FROM recruits WHERE recruited_id = ?', member.id);
    if (exist) return interaction.reply({ content: 'That member has already been recruited previously.', ephemeral: true });

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
      if (guildMember.roles.cache.has(ROLE_IDS.UNVERIFIED)) await guildMember.roles.remove(ROLE_IDS.UNVERIFIED);
      // add rookie
      await guildMember.roles.add(ROLE_IDS.ROOKIE);
      // add chosen onboarding role
      await guildMember.roles.add(chosenRole);

      // set nickname
      await guildMember.setNickname(`${ign} | ${region}`).catch(()=>null);

      // Determine recruiter role and active multiplier, compute points
      const recruiterMember = await interaction.guild.members.fetch(interaction.user.id).catch(()=>null);
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

      // DM recruited member to confirm verification
      try {
        const { EmbedBuilder } = require('discord.js');
        const verifyEmbed = new EmbedBuilder()
          .setTitle('✅ Verified')
          .setDescription('You have been verified and welcomed to the server.')
          .addFields(
            { name: 'Recruiter', value: `<@${interaction.user.id}>`, inline: true },
            { name: 'Region', value: region, inline: true },
            { name: 'Points', value: `${points}`, inline: true }
          )
          .setColor(0x00CC66)
          .setTimestamp();
        await guildMember.send({ embeds: [verifyEmbed] }).catch(()=>{});
      } catch (e) {
        // best-effort DM
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
            await recruiterMember.roles.remove(ROLE_IDS.SPECIAL_ROLE).catch(()=>{});
            await recruiterMember.roles.remove(ROLE_IDS.ROOKIE).catch(()=>{});
            await recruiterMember.roles.add(ROLE_IDS.AUTO_PROMOTE_ROLE).catch(()=>{});
            if (recruiterRoleId) await recruiterMember.roles.add(recruiterRoleId).catch(()=>{});

            await db.run('UPDATE recruiters SET promoted = 1 WHERE id = ?', interaction.user.id);
          }
        }
      }

      // Log to invites channel overall + region and cross-post to central leaderboard channel (use embed)
      const { CHANNELS } = require('../constants');
      const channelOverall = interaction.guild.channels.cache.get(CHANNELS.INVITES_OVERALL);
      const channelRegion = interaction.guild.channels.cache.get(region === 'EU' ? CHANNELS.INVITES_EU : region === 'NA' ? CHANNELS.INVITES_NA : CHANNELS.INVITES_AS);
      const central = interaction.guild.channels.cache.get(CHANNELS.CENTRAL_LEADERBOARD);
      const { makeRecruitEmbed } = require('../lib/messages');
      const lang = interaction.locale || 'en';
      const embed = makeRecruitEmbed(interaction.user.id, member.id, region, ign, lang, { points, recruiterRole });
      if (channelOverall) channelOverall.send({ embeds: [embed] }).catch(()=>{});
      if (channelRegion) channelRegion.send({ embeds: [embed] }).catch(()=>{});
      if (central) central.send({ embeds: [embed] }).catch(()=>{});

      // Update region leaderboards immediately
      try {
        const scheduler = require('../scheduler');
        await scheduler.recomputeLeaderboards(db, interaction.guild);
      } catch (e) {
        console.error('Failed updating leaderboards:', e);
      }

      await interaction.reply({ content: `Successfully recruited ${member.tag} as ${region}. Awarded **${points}** points.`, ephemeral: false });
    } catch (err) {
      console.error(err);
      if (err && err.message && err.message.includes('UNIQUE constraint failed')) {
        return interaction.reply({ content: 'That member has already been recruited before and cannot be recruited again.', ephemeral: true });
      }
      return interaction.reply({ content: 'Failed to complete recruit action.', ephemeral: true });
    }
  }
};