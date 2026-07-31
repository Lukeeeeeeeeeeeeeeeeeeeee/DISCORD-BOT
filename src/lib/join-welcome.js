const RECRUIT_WELCOME_MESSAGE = `**Welcome to REVOL!** You've been recruited in **[team]**. Put **REVOL** at the top of your server list and keep it unmuted (see README).

**ROOKIE INFO**
You start as **Rookie**. Reach **Member** status by staying active and meeting the server's progression requirements.

**Ways to Progress:**

* **Wars / Ganks** - Participate in 2 within 2 weeks for bonus progress.
* **Recruiting** - Help recruit new members and support the team.
* **Activity (Chatting)** - Stay active in the server and contribute regularly.
* **Events** - Join special events and take part in the community.

> Stay consistent and engaged, and staff will handle progression based on the current server rules.

Any questions? Ask in the **Questions** channel or the person who recruited you -- **they can answer any questions you have!**

Good luck and welcome to REVOL!`;

function buildRecruitWelcomeMessage(teamName) {
  const safeTeam = teamName == null ? 'Unknown' : String(teamName).trim();
  return RECRUIT_WELCOME_MESSAGE.replace('[team]', safeTeam || 'Unknown');
}

module.exports = {
  buildRecruitWelcomeMessage
};
