const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CHANNELS } = require('../constants');
const { ensureCommandAccess } = require('../lib/command-auth');
const { replyError } = require('../lib/embeds');

// Tunables
const HARD_MAX = 1000; // absolute hard cap (allows batching up to 1000)
const DELAY_MS = 1200; // ms between DMs
const BATCH_SIZE = 100; // recipients per batch
const BATCH_DELAY_MS = 5000; // delay between batches
const COOLDOWN_MS = 5 * 60 * 1000; // per-admin cooldown for non-preview sends
const MAX_HISTORY_CAMPAIGNS = 200;

const cooldowns = new Map();

function getHistoryFilePath() {
  return process.env.DM_HISTORY_FILE || path.join(process.cwd(), 'data', 'dm_history.json');
}

function readHistory() {
  const historyFile = getHistoryFilePath();
  try {
    if (!fs.existsSync(historyFile)) return { campaigns: {} };
    const raw = fs.readFileSync(historyFile, 'utf8');
    if (!raw || !raw.trim()) return { campaigns: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { campaigns: {} };
    if (!parsed.campaigns || typeof parsed.campaigns !== 'object') parsed.campaigns = {};
    return parsed;
  } catch (err) {
    console.error('Failed to read DM history:', err);
    return { campaigns: {} };
  }
}

function writeHistory(history) {
  const historyFile = getHistoryFilePath();
  try {
    const campaigns = history && history.campaigns && typeof history.campaigns === 'object' ? history.campaigns : {};
    const entries = Object.entries(campaigns);
    if (entries.length > MAX_HISTORY_CAMPAIGNS) {
      entries.sort((a, b) => {
        const aTs = Date.parse((a[1] && a[1].updatedAt) || '') || 0;
        const bTs = Date.parse((b[1] && b[1].updatedAt) || '') || 0;
        return bTs - aTs;
      });
      history.campaigns = Object.fromEntries(entries.slice(0, MAX_HISTORY_CAMPAIGNS));
    }
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write DM history:', err);
  }
}

function hashMessage(message) {
  return crypto.createHash('sha256').update(String(message || '').trim()).digest('hex').slice(0, 24);
}

function buildCampaignKey({ guildId, dmEveryone, roleId, message }) {
  const targetType = dmEveryone ? 'everyone' : `role:${roleId || 'unknown'}`;
  return `${guildId}:${targetType}:${hashMessage(message)}`;
}

function getAlreadySentIds(campaignKey) {
  const history = readHistory();
  const entry = history.campaigns && history.campaigns[campaignKey] ? history.campaigns[campaignKey] : null;
  const sent = entry && Array.isArray(entry.sentMemberIds) ? entry.sentMemberIds : [];
  return new Set(sent.map(String));
}

function appendSentIds(campaignKey, metadata, sentIds) {
  if (!Array.isArray(sentIds) || sentIds.length === 0) return;
  const history = readHistory();
  if (!history.campaigns || typeof history.campaigns !== 'object') history.campaigns = {};
  const nowIso = new Date().toISOString();
  const existing = history.campaigns[campaignKey] || {};
  const merged = new Set(Array.isArray(existing.sentMemberIds) ? existing.sentMemberIds.map(String) : []);
  for (const id of sentIds) {
    if (id !== null && id !== undefined) merged.add(String(id));
  }

  history.campaigns[campaignKey] = {
    ...existing,
    ...metadata,
    sentMemberIds: Array.from(merged),
    updatedAt: nowIso,
    createdAt: existing.createdAt || nowIso
  };
  writeHistory(history);
}

async function forEachWithConcurrency(items, concurrency, handler) {
  const safeConcurrency = Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 1;
  let index = 0;
  const workers = Array.from({ length: safeConcurrency }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      await handler(items[current], current);
    }
  });
  await Promise.all(workers);
}

async function detectPreviouslySentFromDmHistory({
  members,
  message,
  botUserId,
  lookbackMs = 0,
  fetchLimit = 25,
  concurrency = 8
} = {}) {
  const result = new Set();
  if (!botUserId || !Array.isArray(members) || members.length === 0) return result;

  await forEachWithConcurrency(members, concurrency, async (member) => {
    try {
      if (!member || !member.id || !member.user || member.user.bot) return;
      if (typeof member.createDM !== 'function') return;
      const dmChannel = await member.createDM();
      if (!dmChannel || !dmChannel.messages || typeof dmChannel.messages.fetch !== 'function') return;
      const recentMessages = await dmChannel.messages.fetch({ limit: fetchLimit });
      if (!recentMessages || typeof recentMessages.values !== 'function') return;

      for (const msg of recentMessages.values()) {
        if (!msg || !msg.author) continue;
        if (String(msg.author.id) !== String(botUserId)) continue;
        if (String(msg.content || '') !== String(message)) continue;
        if (lookbackMs > 0 && Number.isFinite(msg.createdTimestamp)) {
          if ((Date.now() - Number(msg.createdTimestamp)) > lookbackMs) continue;
        }
        result.add(String(member.id));
        return;
      }
    } catch (_err) {
      // Per-member DM history scan failures are non-fatal.
    }
  });

  return result;
}

module.exports = {
  data: { name: 'dm' },
  async execute(interaction, _client, _db) {
    const allowed = await ensureCommandAccess(interaction, {
      allowStaff: false,
      deniedMessage: 'Administrator permission required.'
    });
    if (!allowed) return null;

    if (!interaction.guild || !interaction.guild.members) {
      return replyError(interaction, 'This command can only be used inside a server.');
    }

    const role = interaction.options.getRole('role', false);  // Make role optional
    const message = interaction.options.getString('message', true);
    const limitOpt = interaction.options.getInteger('limit');
    const offsetOpt = interaction.options.getInteger('offset');
    const preview = interaction.options.getBoolean('preview') || false;
    const dmEveryone = interaction.options.getBoolean('everyone') || false;

    // Validate inputs
    if (!message) {
      return replyError(interaction, 'Missing required message parameter.');
    }
    if (message.length > 2000) {
      return replyError(interaction, 'Message must be 2000 characters or fewer.');
    }

    // Must specify either role or everyone
    if (!role && !dmEveryone) {
      return replyError(interaction, 'You must specify a role OR set everyone to true.');
    }

    if (limitOpt !== null && limitOpt !== undefined && (limitOpt < 1 || limitOpt > HARD_MAX)) {
      return replyError(interaction, `Limit must be between 1 and ${HARD_MAX}.`);
    }
    if (offsetOpt !== null && offsetOpt !== undefined && (offsetOpt < 0 || offsetOpt > HARD_MAX)) {
      return replyError(interaction, `Offset must be between 0 and ${HARD_MAX}.`);
    }

    await interaction.deferReply({ flags: 64 });

    // cooldown check (only applies to actual sends, not previews)
    if (!preview) {
      const last = cooldowns.get(interaction.user.id) || 0;
      const now = Date.now();
      if (now - last < COOLDOWN_MS) {
        const rem = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
        return replyError(interaction, `Please wait ${rem}s before sending another DM broadcast. Use preview to test.`);
      }
    }

    // Default to full member fetch for reliable role targeting; set DM_ALLOW_FULL_FETCH=false to opt out.
    const allowFullFetch = (process.env.DM_ALLOW_FULL_FETCH || 'true').toLowerCase() !== 'false';
    let membersCol = null;
    const canFetchAllMembers = allowFullFetch
      && interaction.guild.members
      && typeof interaction.guild.members.fetch === 'function';
    if (canFetchAllMembers) {
      membersCol = await interaction.guild.members.fetch().catch(() => null);
    }
    if (!membersCol) {
      if (dmEveryone) {
        membersCol = interaction.guild.members.cache;
      } else if (role && role.members && role.members.size > 0) {
        membersCol = role.members;
      } else {
        membersCol = interaction.guild.members.cache;
      }
    }

    // Filter targets based on role or everyone
    let targets;
    if (dmEveryone) {
      targets = membersCol.filter(m => !m.user.bot);
    } else {
      targets = membersCol.filter(m => m.roles.cache.has(role.id) && !m.user.bot);
    }
    const targetLabel = dmEveryone ? 'everyone' : role.name;
    const totalFound = targets.size;
    if (!totalFound) return replyError(interaction, `No human members found${dmEveryone ? '' : ` with the role ${role.name}`}.`);

    // Keep recipient ordering stable so offset/resume behaves predictably.
    const orderedTargets = Array.from(targets.values()).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const offset = Math.max(0, offsetOpt || 0);
    const campaignKey = buildCampaignKey({
      guildId: interaction.guild.id,
      dmEveryone,
      roleId: role ? role.id : null,
      message
    });
    const historySent = getAlreadySentIds(campaignKey);
    const alreadySent = new Set(historySent);

    const shouldScanDmHistory = (process.env.DM_DEDUPE_SCAN_DMS || 'true').toLowerCase() !== 'false';
    let scannedSentCount = 0;
    if (shouldScanDmHistory && orderedTargets.length > 0) {
      const botUserId = (_client && _client.user && _client.user.id)
        || (interaction.client && interaction.client.user && interaction.client.user.id)
        || null;
      const lookbackDays = Number.parseInt(process.env.DM_DEDUPE_LOOKBACK_DAYS || '14', 10);
      const lookbackMs = Number.isFinite(lookbackDays) && lookbackDays > 0 ? lookbackDays * 24 * 60 * 60 * 1000 : 0;
      const scanConcurrency = Number.parseInt(process.env.DM_DEDUPE_SCAN_CONCURRENCY || '8', 10);
      const scanFetchLimit = Number.parseInt(process.env.DM_DEDUPE_SCAN_FETCH_LIMIT || '25', 10);
      const scanned = await detectPreviouslySentFromDmHistory({
        members: orderedTargets,
        message,
        botUserId,
        lookbackMs,
        fetchLimit: Number.isFinite(scanFetchLimit) && scanFetchLimit > 0 ? scanFetchLimit : 25,
        concurrency: Number.isFinite(scanConcurrency) && scanConcurrency > 0 ? scanConcurrency : 8
      });
      for (const id of scanned) {
        if (!alreadySent.has(id)) scannedSentCount += 1;
        alreadySent.add(id);
      }
    }

    const unsentTargets = orderedTargets.filter(member => !alreadySent.has(String(member.id)));
    const alreadySentCount = orderedTargets.length - unsentTargets.length;
    const offsetTargets = unsentTargets.slice(offset);
    const defaultCap = Math.min(offsetTargets.length, HARD_MAX);
    const cap = Math.min(limitOpt !== null && limitOpt !== undefined ? limitOpt : defaultCap, HARD_MAX);
    const recipients = offsetTargets.slice(0, cap);

    if (!offsetTargets.length) {
      if (preview) {
        return interaction.editReply({
          content: `Preview: found ${totalFound} members, ${alreadySentCount} already sent for this same message${scannedSentCount ? ` (${scannedSentCount} detected from DM history)` : ''}, ${offset} skipped by offset, and 0 are left to send.`
        });
      }
      return replyError(interaction, `No unsent members remain for this message${dmEveryone ? '' : ` and role ${role.name}`}. Try changing the message or adjusting offset.`);
    }

    if (preview) {
      const sample = recipients.slice(0, 10).map(m => `<@${m.id}>`).join(', ');
      return interaction.editReply({
        content: `Preview: found ${totalFound} members, ${alreadySentCount} already sent for this same message${scannedSentCount ? ` (${scannedSentCount} detected from DM history)` : ''}, ${offset} skipped by offset, showing up to ${cap}. First ${Math.min(10, recipients.length)}: ${sample}`
      });
    }

    cooldowns.set(interaction.user.id, Date.now());

    // Queue the job and return immediately to avoid interaction timeouts
    const batches = [];
    for (let i = 0; i < recipients.length; i += BATCH_SIZE) batches.push(recipients.slice(i, i + BATCH_SIZE));

    // Fire-and-forget async job with retries and enhanced metrics
    (async () => {
      let totalSent = 0;
      let totalFailed = 0;
      let totalRetries = 0;
      const sentIds = [];
      const auditChId = CHANNELS && CHANNELS.INVITES_OVERALL ? CHANNELS.INVITES_OVERALL : null;
      let auditCh = null;
      if (auditChId) {
        auditCh = await interaction.guild.channels.fetch(auditChId).catch(err => {
          console.error('Failed to fetch DM audit channel:', err);
          return null;
        });
      }

      if (auditCh && auditCh.send) {
        await auditCh.send(`DM broadcast queued by <@${interaction.user.id}> to **${targetLabel}**: ${recipients.length} unsent recipients in ${batches.length} batch(es). Skipped ${alreadySentCount} already-sent${scannedSentCount ? ` (${scannedSentCount} detected from DM history)` : ''} and ${offset} offset.`)
          .catch(err => console.error('Failed to post DM audit start:', err));
      }

      const getRetryAfterMs = (error, fallbackMs) => {
        const retryAfter = error && (error.retryAfter ?? error.retry_after ?? error.data?.retry_after ?? error.rawError?.retry_after);
        if (Number.isFinite(retryAfter)) {
          const value = Number(retryAfter);
          return value < 1000 ? Math.ceil(value * 1000) : Math.ceil(value);
        }
        return fallbackMs;
      };

      const sendWithRetries = async (member, message, maxRetries = 2) => {
        let attempts = 0;
        while (attempts <= maxRetries) {
          try {
            await member.send(message);
            return { ok: true, attempts };
          } catch (err) {
            attempts++;
            const hardFail = err && (err.code === 50007 || err.code === 50013 || err.code === 50001);
            const rateLimited = err && (err.status === 429 || err.code === 429);
            if (hardFail || attempts > maxRetries) return { ok: false, attempts, error: err };
            const retryAfter = rateLimited ? getRetryAfterMs(err, DELAY_MS * 2) : DELAY_MS * 2;
            await new Promise(r => setTimeout(r, retryAfter));
          }
        }
        return { ok: false, attempts: maxRetries };
      };

      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        let batchSent = 0;
        let batchFailed = 0;
        let batchRetries = 0;
        for (let i = 0; i < batch.length; i++) {
          const member = batch[i];
          const res = await sendWithRetries(member, message, 2);
          if (res.ok) {
            batchSent++;
            sentIds.push(member.id);
          } else {
            batchFailed++;
          }
          batchRetries += Math.max(0, res.attempts);

          if (i < batch.length - 1) await new Promise(r => setTimeout(r, DELAY_MS));
        }
        totalSent += batchSent;
        totalFailed += batchFailed;
        totalRetries += batchRetries;

        // log batch results
        if (auditCh && auditCh.send) {
          await auditCh.send(`DM batch ${b + 1}/${batches.length} by <@${interaction.user.id}> to **${targetLabel}**: attempted ${batch.length}, sent ${batchSent}, failed ${batchFailed}, retries ${batchRetries}. Total so far: sent ${totalSent}, failed ${totalFailed}, retries ${totalRetries}.`).catch(err => {
            console.error('Failed to post DM batch audit:', err);
          });
        }

        // delay between batches
        if (b < batches.length - 1) await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }

      // final audit
      if (auditCh && auditCh.send) {
        await auditCh.send(`DM broadcast completed by <@${interaction.user.id}> to **${targetLabel}**: attempted ${recipients.length}, sent ${totalSent}, failed ${totalFailed}, total retries ${totalRetries}.`).catch(err => {
          console.error('Failed to post DM completion audit:', err);
        });
      }

      appendSentIds(
        campaignKey,
        {
          guildId: interaction.guild.id,
          targetType: dmEveryone ? 'everyone' : 'role',
          targetId: dmEveryone ? null : role.id,
          targetLabel,
          messageHash: hashMessage(message),
          requestedBy: interaction.user.id
        },
        sentIds
      );
    })().catch(err => {
      console.error('DM broadcast job failed:', err);
    });

    return interaction.editReply({
      content: `Queued DM broadcast to ${recipients.length} unsent recipient(s) in ${batches.length} batch(es). Skipped ${alreadySentCount} already-sent${scannedSentCount ? ` (${scannedSentCount} detected from DM history)` : ''} and ${offset} offset. Progress will be posted to the audit channel.`
    });
  }
};
