/**
 * /dm command — Control Plane
 *
 * Subcommands: create, status, cancel, report, workers
 * Creates campaigns in the DB queue; worker bots handle actual sends.
 */
'use strict';

const { ensureCommandAccess } = require('../lib/command-auth');
const { replyError } = require('../lib/embeds');
const { logRuntimeEvent } = require('../lib/logger');
const { envInt } = require('../lib/env-utils');
const campaignService = require('../services/dm/dm-campaign-service');
const reporter = require('../services/dm/dm-reporter');
const legacyDmCommand = require('../services/dm/dm-legacy-command');

const cooldowns = new Map();
const COOLDOWN_MS = envInt('DM_COMMAND_COOLDOWN_MS', 60 * 1000, 0, 24 * 60 * 60 * 1000);

module.exports = {
  data: { name: 'dm' },

  async execute(interaction, client, _db) {
    const allowed = await ensureCommandAccess(interaction, {
      allowStaff: false,
      deniedMessage: 'Administrator permission required.'
    });
    if (!allowed) return null;

    if (!interaction.guild || !interaction.guild.members) {
      return replyError(interaction, 'This command can only be used inside a server.');
    }

    const hasSubcommandResolver = Boolean(
      interaction.options && typeof interaction.options.getSubcommand === 'function'
    );
    if (!hasSubcommandResolver) {
      return legacyDmCommand.execute(interaction, client, _db);
    }

    let sub = null;
    try {
      sub = interaction.options.getSubcommand(false);
    } catch (_error) {
      return legacyDmCommand.execute(interaction, client, _db);
    }

    if (sub === 'status') return handleStatus(interaction);
    if (sub === 'cancel') return handleCancel(interaction);
    if (sub === 'report') return handleReport(interaction, client);
    if (sub === 'workers') return handleWorkers(interaction);

    // Default / 'create'
    return handleCreate(interaction);
  }
};

// ── /dm create ──────────────────────────────────────────────────────────────

async function handleCreate(interaction) {
  const messageType = interaction.options.getString('message_type', true);
  const message = interaction.options.getString('message', true);
  const targetMode = interaction.options.getString('target_mode') || 'any_roles';
  const preview = interaction.options.getBoolean('preview') || false;

  // Collect up to 5 role options
  const roleIds = [];
  for (let i = 1; i <= 5; i++) {
    const role = interaction.options.getRole(`role_${i}`, false);
    if (role) roleIds.push(role.id);
  }

  // Validation
  if (!message) return replyError(interaction, 'Missing required message parameter.');
  if (message.length > 2000) return replyError(interaction, 'Message must be 2000 characters or fewer.');
  if (targetMode !== 'everyone' && roleIds.length === 0) {
    return replyError(interaction, 'You must specify at least one role OR set target_mode to "everyone".');
  }

  // Cooldown (non-preview only)
  if (!preview) {
    const last = cooldowns.get(interaction.user.id) || 0;
    const now = Date.now();
    if (now - last < COOLDOWN_MS) {
      const rem = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
      return replyError(interaction, `Please wait ${rem}s before creating another campaign. Use preview to test.`);
    }
  }

  await interaction.deferReply({ flags: 64 });

  try {
    const result = await campaignService.createCampaign({
      guild: interaction.guild,
      requestedBy: interaction.user.id,
      messageType,
      messageBody: message,
      targetMode,
      roleIds,
      reportChannelId: interaction.channel ? interaction.channel.id : null,
      requestedChannelId: interaction.channel ? interaction.channel.id : null,
      preview
    });

    if (result.totalTargets === 0) {
      return replyError(interaction, 'No matching members found for the specified target.');
    }

    if (preview) {
      const sample = (result.sampleUserIds || []).slice(0, 10).map(id => `<@${id}>`).join(', ');
      return interaction.editReply({
        content: `**Preview** — ${result.totalTargets} target(s) would be queued in ${result.totalBatches} batch(es).\nType: \`${messageType}\` | Mode: \`${targetMode}\`\nFirst ${Math.min(10, result.sampleUserIds?.length || 0)}: ${sample}`
      });
    }

    cooldowns.set(interaction.user.id, Date.now());

    void logRuntimeEvent('info', 'command.dm.create', 'DM campaign created via command', {
      campaignId: result.campaignId,
      guildId: interaction.guild.id,
      requestedBy: interaction.user.id,
      messageType,
      targetMode,
      totalTargets: result.totalTargets
    });

    return interaction.editReply({
      content: `✅ **Campaign #${result.campaignId}** created — ${result.totalTargets} target(s) queued in ${result.totalBatches} batch(es).\nType: \`${messageType}\` | Mode: \`${targetMode}\`\nWorker bots will begin sending shortly. Use \`/dm status\` to track progress.`
    });
  } catch (err) {
    return replyError(interaction, `Failed to create campaign: ${err.message}`);
  }
}

// ── /dm status ──────────────────────────────────────────────────────────────

async function handleStatus(interaction) {
  const campaignId = interaction.options.getInteger('campaign_id', true);

  await interaction.deferReply({ flags: 64 });

  const status = await campaignService.getCampaignStatus(campaignId);
  if (!status) {
    return replyError(interaction, `Campaign #${campaignId} not found.`);
  }

  const { campaign, statusCounts } = status;
  const lines = [
    `**Campaign #${campaignId}** — Status: \`${campaign.status}\``,
    `Type: \`${campaign.message_type}\` | Mode: \`${campaign.target_mode}\``,
    `Requested by: <@${campaign.requested_by}>`,
    '',
    `✅ Sent: **${statusCounts.sent || 0}**`,
    `⏳ Pending: **${statusCounts.pending || 0}**`,
    `🔄 Claimed: **${statusCounts.claimed || 0}**`,
    `🚫 Blocked: **${statusCounts.blocked || 0}**`,
    `❌ Undeliverable: **${statusCounts.undeliverable || 0}**`,
    `⚠️ Failed: **${statusCounts.failed || 0}**`,
    `🛑 Cancelled: **${statusCounts.cancelled || 0}**`,
    `📊 Total: **${campaign.total_targets}**`
  ];

  return interaction.editReply({ content: lines.join('\n') });
}

// ── /dm cancel ──────────────────────────────────────────────────────────────

async function handleCancel(interaction) {
  const campaignId = interaction.options.getInteger('campaign_id', true);

  await interaction.deferReply({ flags: 64 });

  const result = await campaignService.cancelCampaign(campaignId);

  return interaction.editReply({
    content: `🛑 Campaign #${campaignId} cancelled. ${result.cancelledTargets} pending target(s) were stopped.`
  });
}

// ── /dm report ──────────────────────────────────────────────────────────────

async function handleReport(interaction, client) {
  const campaignId = interaction.options.getInteger('campaign_id', true);

  await interaction.deferReply({ flags: 64 });

  const reportData = await reporter.postReport(client, campaignId, interaction.channel ? interaction.channel.id : null);

  if (!reportData) {
    return replyError(interaction, `Campaign #${campaignId} not found or no report data available.`);
  }

  return interaction.editReply({
    content: `📊 Report for campaign #${campaignId} has been posted.`
  });
}

// ── /dm workers ─────────────────────────────────────────────────────────────

async function handleWorkers(interaction) {
  // For now, workers subcommand shows the list
  await interaction.deferReply({ flags: 64 });

  const workers = await campaignService.listWorkers();

  if (!workers || workers.length === 0) {
    return interaction.editReply({ content: '🤖 No DM workers registered yet. Workers register when they start.' });
  }

  const lines = workers.map(w => {
    const isOnline = w.last_seen_at && (Date.now() - w.last_seen_at < 60000);
    const statusIcon = isOnline ? '🟢' : '🔴';
    const enabledIcon = w.enabled ? '✅' : '❌';
    const lastSeen = w.last_seen_at ? `<t:${Math.floor(w.last_seen_at / 1000)}:R>` : 'never';
    return `${statusIcon} \`${w.worker_id}\` ${w.display_name || ''} — ${enabledIcon} Enabled | Weight: ${w.weight || 1} | Last seen: ${lastSeen}`;
  });

  return interaction.editReply({
    content: `🤖 **DM Workers** (${workers.length})\n${lines.join('\n')}`
  });
}
