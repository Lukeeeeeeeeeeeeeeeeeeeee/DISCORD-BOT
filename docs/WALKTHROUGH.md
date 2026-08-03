# Walkthrough: Recruiting and Anti-Nuke Fix Verification

This walkthrough covers the user-reported fixes and how to verify them in a test guild.

## Prerequisites
- Bot running with `GuildMembers`, `GuildInvites`, and `GuildModeration` intents enabled.
- Test guild with configured roles in `src/constants.js` (recruiter, trial recruiter, staff, rookie, VIP/MVP/custom).
- Test users for recruiter, staff, and non-recruiter scenarios.

## Manual Verification Steps
1. Recruiter status labels
   - As staff, run `/recruiter info` on a recruiter below min requirement.
   - Confirm the status shows "Below Minimum" or "Failing" (not "Passing").
   - For a user without recruiter roles, confirm the status shows "Not a recruiter".

2. /recruiter buy permission gating
   - As a non-recruiter and non-rookie user, run `/recruiter buy` and confirm it is rejected.
   - As a recruiter or rookie, run `/recruiter buy` and confirm it succeeds.
   - Temporarily remove your roles or revoke role cache access and confirm the command returns "Unable to verify your roles".

3. Interaction privacy (flags/ephemeral)
   - Run `/dm` or `/recruiter warn` and confirm the response is ephemeral.
   - Ensure admin actions do not post publicly.

4. Member fetch usage
   - Run `/recruitment_report` and `/leaderboard show` and confirm results load without errors.
   - Validate recruiter counts match role membership (no undercount due to unsupported fetch options).

5. Weekly recalculation window
   - Verify weekly snapshot data uses the Monday weekStart timestamp.
   - If testing catch-up: delete the `system_events` row for the current `weekly_snapshot_<weekStart>`,
     restart the bot within 24 hours of the scheduled time, and confirm the snapshot runs once.

6. Whitelist bypass logic
   - Add a whitelisted admin and perform a protected action in normal mode; confirm no quarantine/ban occurs.
   - Enable strict mode and repeat; confirm protective actions can now apply to the whitelisted user.

7. /revoke-recruit points
   - Create a recruit with non-zero points.
   - Run `/revoke-recruit` and confirm recruiter points decrease by the recruit's points.

8. Invite attribution logic
   - Create an invite, restart the bot, and have a user join.
   - Confirm invite attribution is correct after restart.
   - Verify that cold-start attribution only occurs when a single tracked invite exists.

## Scripted Checks
- `npm test`
- Optional: `node scripts/require-walk.js` to confirm module loads under a test DB path.
