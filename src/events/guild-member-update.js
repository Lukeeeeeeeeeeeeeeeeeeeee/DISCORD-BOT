function createGuildMemberUpdateHandler({
  isSystemsReady,
  ROLE_IDS,
  RECRUITER_ROLE_IDS,
  analytics
} = {}) {
  return async function onGuildMemberUpdate(oldMember, newMember) {
    if (!isSystemsReady || !isSystemsReady()) return;
    try {
      if (!oldMember || !newMember) return;
      if (!newMember.user || newMember.user.bot) return;
      if (!oldMember.roles || !oldMember.roles.cache || !newMember.roles || !newMember.roles.cache) return;

      const staffRoles = Array.isArray(ROLE_IDS.STAFF) && ROLE_IDS.STAFF.length
        ? ROLE_IDS.STAFF.filter(Boolean)
        : [
          ROLE_IDS.HELPER,
          ROLE_IDS.HELPER_PLUS,
          ROLE_IDS.HIGH_STAFF,
          ROLE_IDS.MOD,
          ROLE_IDS.CHIEF,
          ROLE_IDS.CHIEF_OF_WAR,
          ROLE_IDS.CHIEF_OF_COMMUNITY,
          ROLE_IDS.CHIEF_OF_RECRUITMENT,
          ROLE_IDS.CO_LEADER,
          ROLE_IDS.LEADER
        ].filter(Boolean);

      const recruiterRoles = [
        ROLE_IDS.RECRUITER,
        ROLE_IDS.TRIAL_RECRUITER,
        ...(RECRUITER_ROLE_IDS ? Object.values(RECRUITER_ROLE_IDS) : [])
      ].filter(Boolean);

      const teamRoles = ROLE_IDS.TEAM_MEMBER ? Object.values(ROLE_IDS.TEAM_MEMBER).filter(Boolean) : [];
      const trackedRoleIds = new Set([...staffRoles, ...recruiterRoles, ...teamRoles, ROLE_IDS.AUTO_PROMOTE_ROLE]);

      const added = newMember.roles.cache.filter(role => !oldMember.roles.cache.has(role.id) && trackedRoleIds.has(role.id));
      const removed = oldMember.roles.cache.filter(role => !newMember.roles.cache.has(role.id) && trackedRoleIds.has(role.id));

      for (const role of added.values()) {
        await analytics.recordRoleChange({
          guildId: newMember.guild.id,
          userId: newMember.id,
          roleId: role.id,
          roleName: role.name,
          action: 'added',
          timestamp: Date.now()
        });
      }

      for (const role of removed.values()) {
        await analytics.recordRoleChange({
          guildId: newMember.guild.id,
          userId: newMember.id,
          roleId: role.id,
          roleName: role.name,
          action: 'removed',
          timestamp: Date.now()
        });
      }

      // Auto-swap Onboarding to Team roles when the SOLACE/member role is granted (i.e., a real promotion)
      const solaceRoleId = ROLE_IDS.AUTO_PROMOTE_ROLE || ROLE_IDS.SOLACE;
      const memberJustPromoted = solaceRoleId && added.has(solaceRoleId);

      if (memberJustPromoted) {
        let targetTeam = null;
        
        if (ROLE_IDS.ONBOARDING_FIRE && newMember.roles.cache.has(ROLE_IDS.ONBOARDING_FIRE)) targetTeam = 'EU';
        else if (ROLE_IDS.ONBOARDING_WATER && newMember.roles.cache.has(ROLE_IDS.ONBOARDING_WATER)) targetTeam = 'NA';
        else if (ROLE_IDS.ONBOARDING_AIR && newMember.roles.cache.has(ROLE_IDS.ONBOARDING_AIR)) targetTeam = 'AS';

        if (targetTeam) {
          const teamRoleId = ROLE_IDS.TEAM_MEMBER && ROLE_IDS.TEAM_MEMBER[targetTeam];
          const onboardingRolesToRemove = [
            ROLE_IDS.ROOKIE,
            ROLE_IDS.UNVERIFIED,
            ROLE_IDS.ONBOARDING_FIRE,
            ROLE_IDS.ONBOARDING_WATER,
            ROLE_IDS.ONBOARDING_AIR,
            ...(ROLE_IDS.ONBOARDING || [])
          ].filter(Boolean);

          const rolesToAdd = [teamRoleId].filter(Boolean);
          const removeList = onboardingRolesToRemove.filter(id => newMember.roles.cache.has(id));
          const addList = rolesToAdd.filter(id => !newMember.roles.cache.has(id));

          if (removeList.length > 0 || addList.length > 0) {
            // Slight delay so the initial role grant settles first
            setTimeout(async () => {
              try {
                const freshMember = await newMember.guild.members.fetch(newMember.id).catch(() => null);
                if (!freshMember) return;
                if (removeList.length > 0) {
                  await freshMember.roles.remove(removeList, 'Promotion: remove onboarding roles').catch(e => {
                    console.error('Failed to remove onboarding roles on promotion', e);
                  });
                }
                if (addList.length > 0) {
                  await freshMember.roles.add(addList, 'Promotion: add team member role').catch(e => {
                    console.error('Failed to add team role on promotion', e);
                  });
                }
              } catch (e) {
                console.error('Failed to swap onboarding to team on promotion', e);
              }
            }, 2000);
          }
        }
      }
    } catch (e) {
      console.error('Failed to record role change analytics:', e);
    }
  };
}

module.exports = { createGuildMemberUpdateHandler };
