const RECRUIT_WELCOME_MESSAGE = `**Welcome to REVOL!** You've been recruited in **[team]**. Put **REVOL** at the top of your server list and keep it unmuted (see README).

**ROOKIE INFO**
You start as **Rookie**. Earn **Member** for full access by collecting **10 points**.

**Ways to Earn Points:**

* **Wars / Ganks** - Participate in 2 within 2 weeks -> 5 points each (happen randomly)
* **Recruiting** - As **Trial Recruiter** (ask for this role), each recruit = 3 points. Reach 3 recruits in 9 days -> promotion to **Recruiter**. Failing resets recruiting points.
* **Activity (Chatting)** - Send 550 messages/week -> 1.5 points per 105 messages
* **Events** - Participate in a **special event** -> 10 points (instant verification)

> Combine methods or focus on one (Recruiting & Chatting are most consistent). Points aren't permanent.

Any questions? Ask in the **Questions** channel or the person who recruited you -- **they can answer any questions you have!**

Good luck and welcome to REVOL!`;

function buildRecruitWelcomeMessage(teamName) {
  const safeTeam = teamName == null ? 'Unknown' : String(teamName).trim();
  return RECRUIT_WELCOME_MESSAGE.replace('[team]', safeTeam || 'Unknown');
}

module.exports = {
  buildRecruitWelcomeMessage
};
