const db = require('../db_async');
const { EmbedBuilder } = require('discord.js');
const { 
  calculate7DayStats, 
  getPreviousMinReq, 
  storeWeeklyCalculation,
  calculateMinRecruitsFixed,
  getBaseRequirement,
  isNewStaff,
  getRoleLevel
} = require('../lib/recruiting-system');
const { CHANNELS, ROLE_IDS, RECRUITER_ROLE_IDS } = require('../constants');

function getWeekStartUtcTs(now = new Date()) {
  const day = now.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  weekStart.setUTCDate(weekStart.getUTCDate() - diffToMonday);
  return weekStart.getTime();
}

/**
 * Perform weekly recalculation for all recruiters
 * Runs every Monday at 00:00 UTC
 */
async function performWeeklyRecalculations(guild) {
  const database = db;
  console.log('Starting weekly recruiter recalculation...');

  const weekStart = getWeekStartUtcTs();
  
  try {
    // Get all recruiters (staff roles + recruiter roles)
    const staffRoleIds = [
      ROLE_IDS.HELPER,
      ROLE_IDS.HELPER_PLUS,
      ROLE_IDS.MOD,
      ROLE_IDS.CHIEF,
      ROLE_IDS.CHIEF_OF_WAR,
      ROLE_IDS.CHIEF_OF_COMMUNITY,
      ROLE_IDS.CHIEF_OF_RECRUITMENT,
      ROLE_IDS.CO_LEADER,
      ROLE_IDS.LEADER,
      ROLE_IDS.HIGH_STAFF
    ];

    const recruiterRoleIds = [
      ROLE_IDS.RECRUITER,
      ROLE_IDS.TRIAL_RECRUITER,
      ...Object.values(RECRUITER_ROLE_IDS)
    ];

    const allRoleIds = [...staffRoleIds, ...recruiterRoleIds];

    const allStaff = [];
    for (const roleId of allRoleIds) {
      const role = guild.roles.cache.get(roleId);
      if (role) {
        role.members.forEach(member => {
          if (!allStaff.find(m => m.id === member.id)) {
            allStaff.push(member);
          }
        });
      }
    }

    console.log(`Found ${allStaff.length} staff members to recalculate`);

    const results = [];
    
    for (const staffMember of allStaff) {
      try {
        // Get 7-day stats
        const stats7d = await calculate7DayStats(database, staffMember.id, guild);
        const previousMinReq = await getPreviousMinReq(database, staffMember.id);
        
        // Check for active absence
        const absence = await database.get(
          'SELECT * FROM absences WHERE recruiter_id = ? AND active = 1 AND end_date >= date("now")',
          staffMember.id
        );
        
        // Get active warnings count
        const warnings = await database.get(
          'SELECT COUNT(*) as c FROM warnings WHERE recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)',
          staffMember.id, Date.now()
        );
        const activeWarnings = warnings ? warnings.c : 0;
        
        // Get role base requirement
        const roleBase = getBaseRequirement(staffMember);
        
        // Check if new staff (first 2 recalcs)
        const newStaffCheck = await isNewStaff(database, staffMember.id);
        
        // Calculate new min req
        const newMinReq = calculateMinRecruitsFixed({
          roleBase,
          member: staffMember,
          recruits7d: stats7d.recruits7d,
          activityRate: stats7d.activityRate,
          verifyRate: stats7d.verifyRate,
          retention: stats7d.retention,
          warnings: activeWarnings,
          previousMinReq,
          absent: !!absence,
          isNewStaff: newStaffCheck
        });

        // Store calculation
        await storeWeeklyCalculation(database, {
          recruiterId: staffMember.id,
          weekStart,
          recruits7d: stats7d.recruits7d,
          activityRate: stats7d.activityRate,
          verifyRate: stats7d.verifyRate,
          retention: stats7d.retention,
          warnings: activeWarnings,
          absent: !!absence,
          previousMinReq,
          calculatedMinReq: newMinReq,
          roleBase
        });

        // Prepare result for DM
        const result = {
          staffMember,
          newMinReq,
          stats7d,
          activeWarnings,
          absence,
          previousMinReq,
          roleBase
        };
        
        results.push(result);

        const roleLevel = getRoleLevel(staffMember);
        if (roleLevel > 0) {
          // Send DM notification
          await sendWeeklyRecalculationDM(result);

          // Post minReq and retention to invite channels
          await postRetentionToInviteChannels(guild, result);
        }

      } catch (error) {
        console.error(`Error recalculating for staff ${staffMember.id}:`, error);
      }
    }

    // Check for expired absences and post return messages
    await handleExpiredAbsences(guild);

    console.log(`Weekly recalculation completed for ${results.length} staff members`);
    return results;

  } catch (error) {
    console.error('Weekly recalculation failed:', error);
    throw error;
  }
}

/**
 * Send DM notification to staff member about weekly recalculation
 */
async function sendWeeklyRecalculationDM(result) {
  const { staffMember, newMinReq, stats7d, activeWarnings, absence, previousMinReq } = result;
  
  try {
    const embed = new EmbedBuilder()
      .setTitle('📊 Weekly Recruiter Update')
      .setDescription('Your weekly recruiting requirements have been recalculated.')
      .addFields(
        { name: 'New Min Requirement', value: `${newMinReq} recruits/week`, inline: true },
        { name: 'Previous Min', value: previousMinReq ? `${previousMinReq} recruits/week` : 'First calculation', inline: true },
        { name: 'Change', value: previousMinReq ? `${newMinReq - previousMinReq > 0 ? '+' : ''}${newMinReq - previousMinReq}` : 'N/A', inline: true }
      )
      .addFields(
        { name: 'Recruits (7 days)', value: `${stats7d.recruits7d}`, inline: true },
        { name: '7-Day Retention', value: `${Math.round(stats7d.retention * 100)}%`, inline: true },
        { name: 'Active Warnings', value: `${activeWarnings}`, inline: true }
      )
      .setColor(absence ? 0xFFAA00 : (newMinReq > stats7d.recruits7d ? 0xFF6B6B : 0x51CF66))
      .setTimestamp()
      .setFooter({ text: 'Recalculations run every Monday at 00:00 UTC' });

    // Add explanation
    let explanation = '';
    if (absence) {
      explanation = '📅 **Absence Active**: Requirements suspended';
    } else if (stats7d.recruits7d <= 1) {
      explanation = '🔻 **Low Activity**: Floor protection applied (≤1 recruit)';
    } else if (activeWarnings >= 2) {
      explanation = '⚠️ **Warning Freeze**: Changes frozen due to warnings';
    } else if (newMinReq > stats7d.recruits7d) {
      explanation = '📈 **Below Target**: Need more recruits to reach 8/week goal';
    } else {
      explanation = '✅ **On Track**: Meeting or exceeding requirements';
    }
    
    embed.addFields({ name: 'Status', value: explanation, inline: false });

    await staffMember.send({ embeds: [embed] }).catch(() => {
      console.log(`Failed to send weekly DM to ${staffMember.user.tag}`);
    });

  } catch (error) {
    console.error(`Error sending weekly DM to ${staffMember.id}:`, error);
  }
}

/**
 * Post retention and minReq information to invite channels
 */
async function postRetentionToInviteChannels(guild, result) {
  const { staffMember, stats7d, newMinReq } = result;
  
  try {
    const embed = new EmbedBuilder()
      .setTitle('📊 Weekly Recruiter Update')
      .setDescription(`**${staffMember.user.tag}** - 7 Day Performance`)
      .addFields(
        { name: 'Recruits This Week', value: `${stats7d.recruits7d}`, inline: true },
        { name: 'Min Required', value: `${newMinReq}`, inline: true },
        { name: '7-Day Retention', value: `${Math.round(stats7d.retention * 100)}%`, inline: true },
        { name: 'Date', value: new Date().toISOString().split('T')[0], inline: true }
      )
      .setColor(stats7d.retention >= 0.8 ? 0x51CF66 : stats7d.retention >= 0.6 ? 0xFFAA00 : 0xFF6B6B)
      .setTimestamp();

    // Post to overall invites channel
    const overallChannel = guild.channels.cache.get(CHANNELS.INVITES_OVERALL);
    if (overallChannel) {
      await overallChannel.send({ embeds: [embed] }).catch(() => {});
    }

    // Post to regional invite channels based on staff member's recent recruits
    const recentRecruits = await db.all(
      'SELECT DISTINCT region FROM recruits WHERE recruiter_id = ? AND created_at >= ? AND valid = 1 LIMIT 3',
      staffMember.id, Date.now() - (7 * 24 * 60 * 60 * 1000)
    );

    for (const recruit of recentRecruits) {
      const channelId = recruit.region === 'EU' ? CHANNELS.INVITES_EU : 
                        recruit.region === 'NA' ? CHANNELS.INVITES_NA : 
                        recruit.region === 'AS' ? CHANNELS.INVITES_AS : null;
      
      if (channelId) {
        const regionalChannel = guild.channels.cache.get(channelId);
        if (regionalChannel) {
          await regionalChannel.send({ embeds: [embed] }).catch(() => {});
        }
      }
    }

  } catch (error) {
    console.error(`Error posting retention to channels for ${staffMember.id}:`, error);
  }
}

/**
 * Handle expired absences and post return messages
 */
async function handleExpiredAbsences(guild) {
  try {
    const expiredAbsences = await db.all(
      'SELECT * FROM absences WHERE active = 1 AND end_date < date("now")'
    );

    for (const absence of expiredAbsences) {
      // Mark as inactive
      await db.run('UPDATE absences SET active = 0 WHERE id = ?', absence.id);

      // Get staff member
      const staffMember = await guild.members.fetch(absence.recruiter_id).catch(() => null);
      if (staffMember) {
        // Post return message to invites channel
        const embed = new EmbedBuilder()
          .setTitle('🎉 Return from Absence')
          .setDescription(`**${staffMember.user.tag}** has returned from absence and is now active for recruiting.`)
          .addFields(
            { name: 'Absence Period', value: `${absence.start_date} to ${absence.end_date}`, inline: true },
            { name: 'Status', value: 'Requirements reactivated', inline: true }
          )
          .setColor(0x51CF66)
          .setTimestamp();

        const invitesChannel = guild.channels.cache.get(CHANNELS.INVITES_OVERALL);
        if (invitesChannel) {
          await invitesChannel.send({ embeds: [embed] }).catch(() => {});
        }

        // DM the staff member
        const dmEmbed = new EmbedBuilder()
          .setTitle('✅ Absence Ended')
          .setDescription('Your absence period has ended. Recruiting requirements are now reactivated.')
          .addFields(
            { name: 'End Date', value: absence.end_date, inline: true },
            { name: 'Next Action', value: 'Check your new requirements with /recruiter info', inline: true }
          )
          .setColor(0x51CF66)
          .setTimestamp();

        await staffMember.send({ embeds: [dmEmbed] }).catch(() => {});
      }
    }

    if (expiredAbsences.length > 0) {
      console.log(`Processed ${expiredAbsences.length} expired absences`);
    }

  } catch (error) {
    console.error('Error handling expired absences:', error);
  }
}

module.exports = {
  performWeeklyRecalculations,
  sendWeeklyRecalculationDM,
  postRetentionToInviteChannels,
  handleExpiredAbsences,
  isNewStaff
};
