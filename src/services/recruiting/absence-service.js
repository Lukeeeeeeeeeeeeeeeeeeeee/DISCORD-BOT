const { formatUtcDateOnly } = require('../../lib/time');
const absencesRepo = require('../../repos/absences-repo');

async function setAbsence({ db, guildId, recruiterId, createdBy, endDate }) {
  const todayStr = formatUtcDateOnly();
  return absencesRepo.upsertActive(db, guildId, recruiterId, {
    startDate: todayStr,
    endDate,
    createdBy
  });
}

module.exports = { setAbsence };
