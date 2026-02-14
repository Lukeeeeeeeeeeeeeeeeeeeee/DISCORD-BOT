const { PermissionsBitField } = require('discord.js');
const { CHANNELS } = require('../constants');
const { hasAdministrator } = require('../lib/permissions');
const { replyError } = require('../lib/embeds');
const { createResponder } = require('../lib/respond');

// Tunables
const DEFAULT_MAX = 30; // default recipients cap
const HARD_MAX = 1000; // absolute hard cap (allows batching up to 1000)
const DELAY_MS = 1200; // ms between DMs
const BATCH_SIZE = 100; // recipients per batch
const BATCH_DELAY_MS = 5000; // delay between batches
const COOLDOWN_MS = 5 * 60 * 1000; // per-admin cooldown for non-preview sends

const cooldowns = new Map();

module.exports = {
  data: { name: 'dm' },
  async execute(interaction, _client, _db) {
    if (!hasAdministrator(interaction.member)) return replyError(interaction, 'Admin only.');

    const perms = interaction.member.permissions || interaction.member.permissionsIn?.(interaction.channel);
    const isAdmin = perms && perms.has && perms.has(PermissionsBitField.Flags.Administrator);
    if (!isAdmin) return replyError(interaction, 'Administrator permission required.');

    const role = interaction.options.getRole('role', false);  // Make role optional
    const message = interaction.options.getString('message', true);
    const limitOpt = interaction.options.getInteger('limit');
    const preview = interaction.options.getBoolean('preview') || false;
    const dmEveryone = interaction.options.getBoolean('everyone') || false;

    if (!message) {
      return replyError(interaction, 'Missing required message parameter.');
    }

    if (!role && !dmEveryone) {
      return replyError(interaction, 'You must specify a role OR set everyone to true.');
    }

    if (limitOpt && (limitOpt < 1 || limitOpt > HARD_MAX)) {
      return replyError(interaction, `Limit must be between 1 and ${HARD_MAX}.`);
    }

    const { respond, defer } = createResponder(interaction, { defaultFlags: 64, allowedMentions: { parse: [] } });
    await defer();

    if (!preview) {
      const last = cooldowns.get(interaction.user.id) || 0;
      const now = Date.now();
      if (now - last < COOLDOWN_MS) {
        const rem = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
        return replyError(interaction, `Please wait ${rem}s before sending another DM broadcast. Use preview to test.`);
      }
      cooldowns.set(interaction.user.id, now);
    }

    let membersCol = null;
    if (dmEveryone) {
      membersCol = interaction.guild.members.cache;
    } else if (role && role.members) {
      membersCol = role.members;
    } else {
      membersCol = interaction.guild.members.cache;
    }

    let targets;
    if (dmEveryone) {
      targets = membersCol.filter(m => !m.user.bot);
    } else {
      targets = membersCol.filter(m => m.roles.cache.has(role.id) && !m.user.bot);
    }
    const targetLabel = dmEveryone ? 'everyone' : role.name;
    const totalFound = targets.size;
    if (!totalFound) return replyError(interaction, `No human members found${dmEveryone ? '' : ` with the role ${role.name}`}.`);

    const cap = Math.min(limitOpt || DEFAULT_MAX, HARD_MAX);
    const recipients = Array.from(targets.values()).slice(0, cap);

    if (preview) {
      const sample = recipients.slice(0, 10).map(m => `<@${m.id}>`).join(', ');
      return respond({ content: `Preview: found ${totalFound} members, showing up to ${cap}. First ${Math.min(10, recipients.length)}: ${sample}` });
    }

    const batches = [];
    for (let i = 0; i < recipients.length; i += BATCH_SIZE) batches.push(recipients.slice(i, i + BATCH_SIZE));

    (async () => {
      let totalSent = 0;
      let totalFailed = 0;
      let totalRetries = 0;
      const auditChId = CHANNELS && CHANNELS.INVITES_OVERALL ? CHANNELS.INVITES_OVERALL : null;
      let auditCh = null;
      if (auditChId) {
        auditCh = await interaction.guild.channels.fetch(auditChId).catch(err => {
          console.error('Failed to fetch DM audit channel:', err);
          return null;
        });
      }

      if (auditCh && auditCh.send) {
        await auditCh.send(`DM broadcast queued by <@${interaction.user.id}> to **${targetLabel}**: ${recipients.length} recipients in ${batches.length} batch(es).`)
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

      const sendWithRetries = async (member, dmMessage, maxRetries = 2) => {
        let attempts = 0;
        while (attempts <= maxRetries) {
          try {
            await member.send(dmMessage);
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
          if (res.ok) batchSent++;
          else batchFailed++;
          batchRetries += Math.max(0, res.attempts);

          if (i < batch.length - 1) await new Promise(r => setTimeout(r, DELAY_MS));
        }
        totalSent += batchSent;
        totalFailed += batchFailed;
        totalRetries += batchRetries;

        if (auditCh && auditCh.send) {
          await auditCh.send(`DM batch ${b + 1}/${batches.length} by <@${interaction.user.id}> to **${targetLabel}**: attempted ${batch.length}, sent ${batchSent}, failed ${batchFailed}, retries ${batchRetries}. Total so far: sent ${totalSent}, failed ${totalFailed}, retries ${totalRetries}.`).catch(err => {
            console.error('Failed to post DM batch audit:', err);
          });
        }

        if (b < batches.length - 1) await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }

      if (auditCh && auditCh.send) {
        await auditCh.send(`DM broadcast completed by <@${interaction.user.id}> to **${targetLabel}**: attempted ${recipients.length}, sent ${totalSent}, failed ${totalFailed}, total retries ${totalRetries}.`).catch(err => {
          console.error('Failed to post DM completion audit:', err);
        });
      }
    })();

    return respond({ content: `Queued DM broadcast to ${recipients.length} recipient(s) in ${batches.length} batch(es). Progress will be posted to the audit channel.` });
  }
};
