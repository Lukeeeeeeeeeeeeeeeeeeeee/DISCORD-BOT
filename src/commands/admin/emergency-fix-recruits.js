const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../../db_async');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('emergency-fix-recruits')
    .setDescription('🚨 EMERGENCY: Fix missing recruit data in database')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const guildId = interaction.guildId;
      const now = Date.now();
      const baseTimestamp = Date.now() - (3 * 24 * 60 * 60 * 1000);

      const fixes = [
        { recruiterId: '1504846628656250951', name: 'dekieats', points: 2, region: 'AS' },
        { recruiterId: '1238882108097953864', name: 'str1k3', points: 4, region: 'EU' },
        { recruiterId: '1050044494736150579', name: 'AvoidMyRevol', points: 11, region: 'EU' },
        { recruiterId: '1141653573959299102', name: 'Hikaru', points: 10, region: 'AS' }
      ];

      let report = '🚨 **EMERGENCY FIX REPORT**\n\n';
      let fixed = 0;

      for (const fix of fixes) {
        const recruiterData = await db.get(
          'SELECT points FROM recruiters WHERE guild_id = ? AND id = ?',
          guildId, fix.recruiterId
        );

        const recruitCount = await db.get(
          'SELECT COUNT(*) as cnt FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1',
          guildId, fix.recruiterId
        );

        const currentPoints = recruiterData ? recruiterData.points : 0;
        const currentRecruits = recruitCount ? recruitCount.cnt : 0;

        if (currentPoints === fix.points && currentRecruits < fix.points) {
          report += `⚠️ **${fix.name}**: ${currentPoints}pts but only ${currentRecruits} recruits\n`;

          if (!recruiterData) {
            await db.run(
              'INSERT INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, ?, 0, 0, 4)',
              guildId, fix.recruiterId, fix.points
            );
          }

          const missing = fix.points - currentRecruits;
          for (let i = 0; i < missing; i++) {
            const timestamp = baseTimestamp + (i * 60 * 60 * 1000);
            const recruitedId = `EMERGENCY_FIX_${fix.recruiterId}_${i}_${now}_${Math.random()}`;

            await db.run(
              'INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, points, created_at, valid) VALUES (?, ?, ?, ?, 1, ?, 1)',
              guildId, fix.recruiterId, recruitedId, fix.region, timestamp
            );
          }

          fixed++;
          report += `✅ **Fixed**: Added ${missing} recruit records\n\n`;
        } else {
          report += `✅ **${fix.name}**: Already correct (${currentRecruits}/${fix.points})\n\n`;
        }
      }

      if (fixed > 0) {
        report += `\n🎉 **SUCCESS!** Fixed ${fixed} recruiter(s)\n\n`;
        report += '⚠️ **Next step**: Run `/leaderboard refresh` to update the leaderboards';
      } else {
        report += '\n✅ All data is already correct!';
      }

      await interaction.editReply(report);

    } catch (error) {
      console.error('Emergency fix failed:', error);
      await interaction.editReply(`❌ **Error**: ${error.message}`);
    }
  }
};
