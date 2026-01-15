const db = require('../db');
module.exports = {
  data: { name: 'info' },
  async execute(interaction) {
    const member = interaction.options.getUser('member');
    const recruit = db.prepare('SELECT * FROM recruits WHERE recruited_id = ?').get(member.id);
    if (!recruit) return interaction.reply({ content: 'No recruit record for that member.', ephemeral: true });

    const recruiter = await interaction.guild.members.fetch(recruit.recruiter_id).catch(()=>null);
    const reply = `Recruit: ${member.tag}\nRecruiter: ${recruiter ? recruiter.user.tag : recruit.recruiter_id}\nRegion: ${recruit.region}\nIGN: ${recruit.ign}\nValid: ${recruit.valid ? 'Yes':'No'}`;
    return interaction.reply({ content: reply, ephemeral: false });
  }
};