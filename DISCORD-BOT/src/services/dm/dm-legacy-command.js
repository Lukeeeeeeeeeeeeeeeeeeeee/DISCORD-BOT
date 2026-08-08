const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CHANNELS } = require('../../constants');
const { ensureCommandAccess } = require('../../lib/command-auth');
const { replyError } = require('../../lib/embeds');
const { logUnexpectedError, logRuntimeEvent } = require('../../lib/logger');
const { createCampaign } = require('./dm-campaign-service');

const cooldowns = new Map();
const COOLDOWN_MS = 60 * 1000;

function getHistoryFilePath() {
  return process.env.DM_HISTORY_FILE || path.join(os.tmpdir(), 'dm-history.json');
}

function hashMessage(message) {
  return crypto.createHash('sha1').update(String(message || '')).digest('hex');
}

function buildHistoryScopeKey(message, scope) {
  return hashMessage(JSON.stringify({
    message: String(message || ''),
    everyone: !!(scope && scope.everyone),
    roleId: scope && scope.roleId ? String(scope.roleId) : null
  }));
}

function readHistory() {
  const historyFile = getHistoryFilePath();
  if (!fs.existsSync(historyFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  } catch (_error) {
    return {};
  }
}

function writeHistory(history) {
  fs.writeFileSync(getHistoryFilePath(), JSON.stringify(history, null, 2));
}

function getSentIdsFromHistory(guildId, message, scope) {
  const history = readHistory();
  const guildHistory = history[guildId] || {};
  const record = guildHistory[buildHistoryScopeKey(message, scope)];
  return new Set(Array.isArray(record && record.userIds) ? record.userIds.map(String) : []);
}

function storeSentIdsInHistory(guildId, message, scope, userIds) {
  if (!Array.isArray(userIds) || userIds.length === 0) return;
  const history = readHistory();
  const guildHistory = history[guildId] || {};
  const key = buildHistoryScopeKey(message, scope);
  const existing = new Set(Array.isArray(guildHistory[key] && guildHistory[key].userIds) ? guildHistory[key].userIds.map(String) : []);
  for (const userId of userIds) existing.add(String(userId));
  guildHistory[key] = {
    message,
    everyone: !!(scope && scope.everyone),
    roleId: scope && scope.roleId ? String(scope.roleId) : null,
    userIds: Array.from(existing),
    updatedAt: Date.now()
  };
  history[guildId] = guildHistory;
  writeHistory(history);
}

function allowFullFetch() {
  return String(process.env.DM_ALLOW_FULL_FETCH || 'true').toLowerCase() !== 'false';
}

async function resolveCandidates(guild, role, dmEveryone) {
  let members;
  if (dmEveryone) {
    members = await guild.members.fetch();
    return Array.from(members.values()).filter(member => !member.user.bot);
  }

  const roleMembers = role && role.members ? Array.from(role.members.values()) : [];
  if (roleMembers.length > 0 || !allowFullFetch()) {
    return roleMembers.filter(member => member && member.user && !member.user.bot);
  }

  const fetched = await guild.members.fetch();
  return Array.from(fetched.values()).filter(member => member && !member.user.bot && member.roles && member.roles.cache && member.roles.cache.has(role.id));
}

async function findPreviouslySentIds(members, message, botUserId) {
  const sent = new Set();
  for (const member of members) {
    if (!member || typeof member.createDM !== 'function') continue;
    try {
      const dm = await member.createDM();
      const messages = await dm.messages.fetch();
      const iterable = typeof messages.values === 'function' ? Array.from(messages.values()) : Array.from(messages || []);
      if (iterable.some(entry => entry && entry.author && entry.author.id === botUserId && entry.content === message)) {
        sent.add(member.id);
      }
    } catch (_error) {
      continue;
    }
  }
  return sent;
}

async function postAuditLog(guild, requesterId, message, sentCount, failedCount) {
  if (!guild || !guild.channels || typeof guild.channels.fetch !== 'function' || !CHANNELS || !CHANNELS.ECONOMY_NOTIFICATIONS) {
    return;
  }
  try {
    const channel = await guild.channels.fetch(CHANNELS.ECONOMY_NOTIFICATIONS);
    if (!channel || typeof channel.send !== 'function') return;
    await channel.send({
      content: `DM audit: requester <@${requesterId}> sent "${message}" to ${sentCount} member(s). Failures: ${failedCount}.`
    });
  } catch (_error) {
    return;
  }
}

module.exports = {
  data: { name: 'dm' },

  async execute(interaction, client) {
    const traceId = `dm_${Date.now().toString(36)}`;

    const allowed = await ensureCommandAccess(interaction, {
      allowStaff: false,
      deniedMessage: 'Administrator permission required.'
    });
    if (!allowed) return null;

    if (!interaction.guild) {
      return replyError(interaction, 'This command can only be used inside a server.');
    }

    const role = interaction.options.getRole('role', false);
    const message = interaction.options.getString('message', true);
    const preview = interaction.options.getBoolean('preview') || false;
    const dmEveryone = interaction.options.getBoolean('everyone') || false;
    const limitOption = interaction.options.getInteger('limit');
    const offset = Math.max(0, interaction.options.getInteger('offset') || 0);

    if (!message) return replyError(interaction, 'Missing required message parameter.');
    if (message.length > 2000) return replyError(interaction, 'Message must be 2000 characters or fewer.');
    if (!role && !dmEveryone) return replyError(interaction, 'You must specify a role OR set everyone to true.');

    if (!preview) {
      const last = cooldowns.get(interaction.user.id) || 0;
      const now = Date.now();
      if (now - last < COOLDOWN_MS) {
        const remaining = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
        return replyError(interaction, `Please wait ${remaining}s before creating another campaign. Use preview to test.`);
      }
    }

    await interaction.deferReply({ flags: 64 });

    try {
      const candidates = await resolveCandidates(interaction.guild, role, dmEveryone);
      const historyScope = { everyone: dmEveryone, roleId: role ? role.id : null };
      const sentIds = getSentIdsFromHistory(interaction.guild.id, message, historyScope);
      if (sentIds.size === 0 && client && client.user) {
        const scanned = await findPreviouslySentIds(candidates, message, client.user.id);
        for (const userId of scanned) sentIds.add(userId);
      }

      const unsent = candidates.filter(member => !sentIds.has(member.id));
      const remaining = unsent.slice(offset);
      const limit = limitOption == null ? remaining.length : Math.max(0, limitOption);
      const shown = remaining.slice(0, limit);

      if (preview) {
        const mentions = shown.map(member => `<@${member.id}>`).join(', ') || 'none';
        return interaction.editReply({
          content:
            `Preview: found ${candidates.length} members. ` +
            `${sentIds.size} already sent for this same message. ` +
            `${remaining.length} are left to send, showing up to ${shown.length}. ` +
            `First ${shown.length}: ${mentions}`
        });
      }

      if (remaining.length === 0) {
        return interaction.editReply({
          content: 'No recipients found for this selection. Check your roles or everyone setting.'
        });
      }

      const directUserIds = remaining.map(member => member.id);
      const result = await createCampaign({
        guild: interaction.guild,
        requestedBy: interaction.user.id,
        messageType: 'misc',
        messageBody: message,
        targetMode: 'direct',
        directUserIds,
        reportChannelId: CHANNELS && CHANNELS.ECONOMY_NOTIFICATIONS ? CHANNELS.ECONOMY_NOTIFICATIONS : null,
        requestedChannelId: interaction.channelId || null,
        preview: false
      });

      if (!result || !result.totalTargets) {
        return interaction.editReply({
          content: 'No recipients found for this selection. Check your roles or everyone setting.'
        });
      }

      storeSentIdsInHistory(interaction.guild.id, message, historyScope, directUserIds);
      cooldowns.set(interaction.user.id, Date.now());

      await postAuditLog(interaction.guild, interaction.user.id, message, result.totalTargets, 0);

      void logRuntimeEvent('info', 'command.dm.legacy.queued', 'Legacy DM command queued recipients', {
        requesterId: interaction.user.id,
        guildId: interaction.guild.id,
        campaignId: result.campaignId,
        queuedCount: result.totalTargets
      });

      return interaction.editReply({
        content: `Queued DM broadcast to ${result.totalTargets} unsent recipient(s).`
      });
    } catch (error) {
      void logUnexpectedError('command.dm.unified.execute', error, {
        traceId,
        guildId: interaction.guild ? interaction.guild.id : null
      });
      return replyError(interaction, `Failed to queue DM campaign. Ref: ${traceId}`);
    }
  }
};
