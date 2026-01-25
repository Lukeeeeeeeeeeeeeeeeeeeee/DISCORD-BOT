const db = require('../db_async');
const { EmbedBuilder } = require('discord.js');
const { REGIONS } = require('../constants');

module.exports = {
  data: { name: 'leaderboard' },
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'show') {
      const scheduler = require('../scheduler');
      const region = interaction.options.getString('region');
      const since = Date.now() - (7 * 24 * 60 * 60 * 1000);
      if (region) {
        if (!REGIONS.includes(region) && region !== 'GLOBAL') return interaction.reply({ content: 'Invalid region.', flags: 64 });
        
        // Get all recruiters for this region using the same logic as scheduler
        const { RECRUITER_ROLE_IDS, ROLE_IDS } = require('../constants');
        const recruiterRoleId = RECRUITER_ROLE_IDS[region];
        const recruiterRole = interaction.guild.roles.cache.get(recruiterRoleId);
        
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
          ROLE_IDS.HIGH_STAFF,
          ROLE_IDS.STAFF
        ];

        const allRecruiterIds = new Set();
        
        if (recruiterRole) {
          recruiterRole.members.forEach(member => {
            allRecruiterIds.add(member.id);
          });
        }
        
        for (const roleId of staffRoleIds) {
          const staffRole = interaction.guild.roles.cache.get(roleId);
          if (staffRole) {
            staffRole.members.forEach(member => {
              allRecruiterIds.add(member.id);
            });
          }
        }

        const recruiterMembers = Array.from(allRecruiterIds);
        
        // Get recruit data for all recruiters
        const placeholders = recruiterMembers.map(() => '?').join(',');
        const unionSelects = recruiterMembers.map(() => 'SELECT ? AS id').join(' UNION ALL ');
        const rowsBase = await db.all(`
          SELECT 
            r.id AS recruiter_id, 
            COALESCE(c.cnt, 0) AS cnt, 
            COALESCE(db_rec.points, 0) AS points 
          FROM (${unionSelects}) r
          LEFT JOIN (
            SELECT recruiter_id, COUNT(*) as cnt 
            FROM recruits 
            WHERE region = ? AND valid = 1 AND created_at >= ? 
            GROUP BY recruiter_id
          ) c ON c.recruiter_id = r.id 
          LEFT JOIN recruiters db_rec ON db_rec.id = r.id
          ORDER BY cnt DESC, points DESC
        `, ...recruiterMembers, region, since);

        // Get 7-day stats and minReq for each recruiter
        const { calculate7DayStats, getPreviousMinReq, calculateMinRecruitsFixed, getBaseRequirement, isNewStaff } = require('../lib/recruiting-system');
        const rows = [];
        
        for (const r of rowsBase) {
          const stats7d = await calculate7DayStats(db, r.recruiter_id);
          const previousMinReq = await getPreviousMinReq(db, r.recruiter_id);
          
          const absence = await db.get(
            'SELECT * FROM absences WHERE recruiter_id = ? AND active = 1 AND end_date >= date("now")',
            r.recruiter_id
          );
          
          const warnings = await db.get(
            'SELECT COUNT(*) as c FROM warnings WHERE recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)',
            r.recruiter_id, Date.now()
          );
          const activeWarnings = warnings ? warnings.c : 0;
          
          const staffMember = await interaction.guild.members.fetch(r.recruiter_id).catch(() => null);
          const roleBase = getBaseRequirement(staffMember);
          const newStaffCheck = await isNewStaff(db, r.recruiter_id);
          
          const minReq = calculateMinRecruitsFixed({
            roleBase,
            role: staffMember ? staffMember.roles.cache.first()?.id : null,
            recruits7d: stats7d.recruits7d,
            activityRate: stats7d.activityRate,
            retention: stats7d.retention,
            warnings: activeWarnings,
            previousMinReq,
            absent: !!absence,
            isNewStaff: newStaffCheck
          });

          rows.push({
            ...r,
            recruits7d: stats7d.recruits7d,
            retention: stats7d.retention,
            minReq,
            absence: !!absence
          });
        }

        const { makeLeaderboardEmbed } = require('../lib/messages');
        const lang = interaction.locale || 'en';
        const leaderboardData = makeLeaderboardEmbed(rows, region, lang);
        
        return interaction.reply({ content: leaderboardData.content, ephemeral: false });
      }

      // Global: get all recruiters from all regions
      const { RECRUITER_ROLE_IDS, ROLE_IDS } = require('../constants');
      const allRecruiterIds = new Set();
      
      // Add all regional recruiters
      for (const rg of ['EU', 'NA', 'AS']) {
        const recruiterRoleId = RECRUITER_ROLE_IDS[rg];
        const recruiterRole = interaction.guild.roles.cache.get(recruiterRoleId);
        if (recruiterRole) {
          recruiterRole.members.forEach(member => {
            allRecruiterIds.add(member.id);
          });
        }
      }
      
      // Add all staff members
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
        ROLE_IDS.HIGH_STAFF,
        ROLE_IDS.STAFF
      ];

      for (const roleId of staffRoleIds) {
        const staffRole = interaction.guild.roles.cache.get(roleId);
        if (staffRole) {
          staffRole.members.forEach(member => {
            allRecruiterIds.add(member.id);
          });
        }
      }

      const recruiterMembers = Array.from(allRecruiterIds);
      
      // Get global recruit data
      const placeholders = recruiterMembers.map(() => '?').join(',');
      const unionSelects = recruiterMembers.map(() => 'SELECT ? AS id').join(' UNION ALL ');
      const rowsBase = await db.all(`
        SELECT 
          r.id AS recruiter_id, 
          COALESCE(c.cnt, 0) AS cnt, 
          COALESCE(db_rec.points, 0) AS points 
        FROM (${unionSelects}) r
        LEFT JOIN (
          SELECT recruiter_id, COUNT(*) as cnt 
          FROM recruits 
          WHERE valid = 1 AND created_at >= ? 
          GROUP BY recruiter_id
        ) c ON c.recruiter_id = r.id 
        LEFT JOIN recruiters db_rec ON db_rec.id = r.id
        ORDER BY cnt DESC, points DESC
      `, ...recruiterMembers, since);

      // Get 7-day stats and minReq for global
      const { calculate7DayStats, getPreviousMinReq, calculateMinRecruitsFixed, getBaseRequirement, isNewStaff } = require('../lib/recruiting-system');
      const rows = [];
      
      for (const r of rowsBase) {
        const stats7d = await calculate7DayStats(db, r.recruiter_id);
        const previousMinReq = await getPreviousMinReq(db, r.recruiter_id);
        
        const absence = await db.get(
          'SELECT * FROM absences WHERE recruiter_id = ? AND active = 1 AND end_date >= date("now")',
          r.recruiter_id
        );
        
        const warnings = await db.get(
          'SELECT COUNT(*) as c FROM warnings WHERE recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)',
          r.recruiter_id, Date.now()
        );
        const activeWarnings = warnings ? warnings.c : 0;
        
        const staffMember = await interaction.guild.members.fetch(r.recruiter_id).catch(() => null);
        const roleBase = getBaseRequirement(staffMember);
        const newStaffCheck = await isNewStaff(db, r.recruiter_id);
        
        const minReq = calculateMinRecruitsFixed({
          roleBase,
          role: staffMember ? staffMember.roles.cache.first()?.id : null,
          recruits7d: stats7d.recruits7d,
          activityRate: stats7d.activityRate,
          retention: stats7d.retention,
          warnings: activeWarnings,
          previousMinReq,
          absent: !!absence,
          isNewStaff: newStaffCheck
        });

        rows.push({
          ...r,
          recruits7d: stats7d.recruits7d,
          retention: stats7d.retention,
          minReq,
          absence: !!absence
        });
      }

      const { makeLeaderboardEmbed } = require('../lib/messages');
      const lang = interaction.locale || 'en';
      const leaderboardData = makeLeaderboardEmbed(rows, 'GLOBAL', lang);
      
      return interaction.reply({ content: leaderboardData.content, ephemeral: false });
    }

    if (sub === 'init') {
      // admin only
      if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: 'Admin only.', flags: 64 });
      try {
        const scheduler = require('../scheduler');
        await scheduler.recomputeLeaderboards(db, interaction.guild);
        return interaction.reply({ content: 'Leaderboards initialized/updated.', flags: 64 });
      } catch (e) {
        console.error(e);
        return interaction.reply({ content: 'Failed to initialize leaderboards.', flags: 64 });
      }
    }
  }
};