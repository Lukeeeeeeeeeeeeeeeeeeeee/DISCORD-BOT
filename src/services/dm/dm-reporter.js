/**
 * DM Campaign Reporter — Report Builder & Poster
 *
 * Runs on the main bot to post final campaign reports when campaigns complete.
 * Can also be invoked manually via `/dm report <id>`.
 */
'use strict';

const db = require('../../db_async');
const { getReport, markReportPosted, getUnreportedCampaigns } = require('./dm-campaign-service');
const { logUnexpectedError, logRuntimeEvent } = require('../../lib/logger');
const { CHANNELS } = require('../../constants');

// ── Report formatting ───────────────────────────────────────────────────────

const STATUS_EMOJI = {
    sent: '✅',
    blocked: '🚫',
    undeliverable: '❌',
    failed: '⚠️',
    cancelled: '🛑',
    pending: '⏳',
    claimed: '🔄'
};

/**
 * Build a Discord embed-compatible report object for a campaign.
 */
function buildReportEmbed(reportData) {
    const { campaign, statusCounts, workerBreakdown, blockedUsers, undeliverableUsers, failedUsers } = reportData;

    const totalTargets = campaign.total_targets || 0;
    const sent = statusCounts.sent || 0;
    const blocked = (statusCounts.blocked || 0);
    const undeliverable = (statusCounts.undeliverable || 0);
    const failed = (statusCounts.failed || 0);
    const cancelled = (statusCounts.cancelled || 0);
    const successRate = totalTargets > 0 ? ((sent / totalTargets) * 100).toFixed(1) : '0.0';

    const messageTypeLabels = {
        misc: '📨 Misc',
        war_early: '⚔️ War Early Notice',
        war_late: '🔥 War Late Notice'
    };

    // ── Header ──
    const embed = {
        title: '📊 DM Campaign Report',
        color: failed > 0 || undeliverable > 0 ? 0xFF6B6B : 0x2ECC71,
        fields: [],
        footer: { text: `Campaign #${campaign.id}` },
        timestamp: new Date(campaign.finished_at || campaign.updated_at).toISOString()
    };

    // ── Overview ──
    embed.fields.push({
        name: '📋 Overview',
        value: [
            `**Type:** ${messageTypeLabels[campaign.message_type] || campaign.message_type}`,
            `**Requested by:** <@${campaign.requested_by}>`,
            `**Target mode:** ${campaign.target_mode}`,
            `**Created:** <t:${Math.floor(campaign.created_at / 1000)}:R>`,
            campaign.finished_at ? `**Finished:** <t:${Math.floor(campaign.finished_at / 1000)}:R>` : null
        ].filter(Boolean).join('\n'),
        inline: false
    });

    // ── Delivery Summary ──
    embed.fields.push({
        name: '📬 Delivery Summary',
        value: [
            `${STATUS_EMOJI.sent} **Sent:** ${sent}`,
            `${STATUS_EMOJI.blocked} **Blocked:** ${blocked}`,
            `${STATUS_EMOJI.undeliverable} **Undeliverable:** ${undeliverable}`,
            `${STATUS_EMOJI.failed} **Failed:** ${failed}`,
            cancelled > 0 ? `${STATUS_EMOJI.cancelled} **Cancelled:** ${cancelled}` : null,
            `**Total Targets:** ${totalTargets}`,
            `**Success Rate:** ${successRate}%`,
            `**Total Retries:** ${campaign.total_retries || 0}`
        ].filter(Boolean).join('\n'),
        inline: false
    });

    // ── Per-Worker Breakdown ──
    if (workerBreakdown && workerBreakdown.length > 0) {
        const perWorker = {};
        for (const row of workerBreakdown) {
            if (!perWorker[row.worker_id]) perWorker[row.worker_id] = {};
            perWorker[row.worker_id][row.result] = row.count;
        }

        const workerLines = Object.entries(perWorker).map(([wid, results]) => {
            const parts = [];
            if (results.sent) parts.push(`✅ ${results.sent}`);
            if (results.blocked_or_closed_dm) parts.push(`🚫 ${results.blocked_or_closed_dm}`);
            if (results.rate_limited) parts.push(`⏱️ ${results.rate_limited}`);
            if (results.transient_network) parts.push(`🌐 ${results.transient_network}`);
            if (results.unknown_failure) parts.push(`❓ ${results.unknown_failure}`);
            return `\`${wid}\`: ${parts.join(' | ') || 'no attempts'}`;
        });

        embed.fields.push({
            name: '🤖 Worker Breakdown',
            value: workerLines.join('\n').slice(0, 1024),
            inline: false
        });
    }

    // ── Blocked Users ──
    if (blockedUsers && blockedUsers.length > 0) {
        const lines = blockedUsers.slice(0, 20).map(u =>
            `<@${u.user_id}> — blocked by \`${u.blocked_by_worker_id || '?'}\` (${u.last_error_code || '?'})`
        );
        if (blockedUsers.length > 20) lines.push(`...and ${blockedUsers.length - 20} more`);
        embed.fields.push({
            name: `🚫 Blocked Users (${blockedUsers.length})`,
            value: lines.join('\n').slice(0, 1024),
            inline: false
        });
    }

    // ── Undeliverable Users ──
    if (undeliverableUsers && undeliverableUsers.length > 0) {
        const lines = undeliverableUsers.slice(0, 20).map(u =>
            `<@${u.user_id}> — all workers exhausted (${u.last_error_code || '?'})`
        );
        if (undeliverableUsers.length > 20) lines.push(`...and ${undeliverableUsers.length - 20} more`);
        embed.fields.push({
            name: `❌ Undeliverable — Replace Applications (${undeliverableUsers.length})`,
            value: lines.join('\n').slice(0, 1024),
            inline: false
        });
    }

    // ── Failed Users ──
    if (failedUsers && failedUsers.length > 0) {
        const lines = failedUsers.slice(0, 15).map(u =>
            `<@${u.user_id}> — worker \`${u.assigned_worker_id || '?'}\` (${u.last_error_code || '?'})`
        );
        if (failedUsers.length > 15) lines.push(`...and ${failedUsers.length - 15} more`);
        embed.fields.push({
            name: `⚠️ Failed Users (${failedUsers.length})`,
            value: lines.join('\n').slice(0, 1024),
            inline: false
        });
    }

    return embed;
}

/**
 * Build a CSV attachment string for detailed per-user breakdown.
 */
function buildCsvReport(reportData) {
    const { blockedUsers, undeliverableUsers, failedUsers } = reportData;
    const rows = [['user_id', 'final_status', 'assigned_worker', 'blocked_workers', 'last_error_code', 'last_error_message']];

    for (const u of (blockedUsers || [])) {
        rows.push([u.user_id, 'blocked', u.blocked_by_worker_id || '', '', u.last_error_code || '', u.last_error_message || '']);
    }
    for (const u of (undeliverableUsers || [])) {
        rows.push([u.user_id, 'undeliverable', '', 'all', u.last_error_code || '', u.last_error_message || '']);
    }
    for (const u of (failedUsers || [])) {
        rows.push([u.user_id, 'failed', u.assigned_worker_id || '', '', u.last_error_code || '', u.last_error_message || '']);
    }

    return rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
}

// ── Post report ─────────────────────────────────────────────────────────────

/**
 * Post a campaign report to a channel.
 *
 * @param {object} client   discord.js Client
 * @param {number} campaignId
 * @param {string} [channelIdOverride]
 */
async function postReport(client, campaignId, channelIdOverride) {
    const reportData = await getReport(campaignId);
    if (!reportData) return null;

    const { campaign } = reportData;
    const channelId = channelIdOverride
        || campaign.report_channel_id
        || (CHANNELS && CHANNELS.ECONOMY_NOTIFICATIONS)
        || null;

    if (!channelId) {
        void logRuntimeEvent('warn', 'dm.reporter.noChannel', 'No channel for DM campaign report', { campaignId });
        return null;
    }

    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.send) return null;

        const embed = buildReportEmbed(reportData);
        const msgPayload = { embeds: [embed] };

        // Attach CSV if there are problem users
        const hasProblemUsers = (reportData.blockedUsers && reportData.blockedUsers.length > 0)
            || (reportData.undeliverableUsers && reportData.undeliverableUsers.length > 0)
            || (reportData.failedUsers && reportData.failedUsers.length > 0);

        if (hasProblemUsers) {
            const csv = buildCsvReport(reportData);
            msgPayload.files = [{
                attachment: Buffer.from(csv, 'utf8'),
                name: `dm_campaign_${campaignId}_report.csv`
            }];
        }

        await channel.send(msgPayload);
        await markReportPosted(campaignId);

        void logRuntimeEvent('info', 'dm.reporter.posted', 'DM campaign report posted', {
            campaignId,
            channelId
        });

        return reportData;
    } catch (err) {
        void logUnexpectedError('dm.reporter.post', err, { campaignId, channelId });
        return null;
    }
}

/**
 * Scan for completed but unreported campaigns and post their reports.
 * Called periodically by the scheduler on the main bot.
 */
async function scanAndPostReports(client) {
    try {
        const campaigns = await getUnreportedCampaigns();
        for (const campaign of campaigns) {
            await postReport(client, campaign.id);
        }
        return campaigns.length;
    } catch (err) {
        void logUnexpectedError('dm.reporter.scan', err);
        return 0;
    }
}

module.exports = {
    buildReportEmbed,
    buildCsvReport,
    postReport,
    scanAndPostReports
};
