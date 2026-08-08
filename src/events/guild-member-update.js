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

      // Auto-remove onboarding roles when promoted to Staff/Recruiter/Team Member
      if (added.size > 0) {
        const onboardingRoles = [
          ROLE_IDS.ONBOARDING_FIRE,
          ROLE_IDS.ONBOARDING_WATER,
          ROLE_IDS.ONBOARDING_AIR,
          ...(Array.isArray(ROLE_IDS.ONBOARDING) ? ROLE_IDS.ONBOARDING : [])
        ].filter(Boolean);

        const uniqueOnboardingRoles = Array.from(new Set(onboardingRoles));
        const onboardingRolesToRemove = uniqueOnboardingRoles.filter(roleId => 
          newMember.roles.cache.has(roleId)
        );

        if (onboardingRolesToRemove.length > 0) {
          try {
            await newMember.roles.remove(onboardingRolesToRemove, 'Auto-remove onboarding roles on promotion');
            console.log(`Removed onboarding roles from ${newMember.user.tag} (${newMember.id}) after promotion`);
          } catch (err) {
            console.error(`Failed to remove onboarding roles from ${newMember.user.tag}:`, err);
          }
        }
      }

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
    } catch (e) {
      console.error('Failed to record role change analytics:', e);
    }
  };
}

module.exports = { createGuildMemberUpdateHandler };
