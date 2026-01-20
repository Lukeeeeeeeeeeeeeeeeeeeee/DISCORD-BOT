const { PermissionsBitField } = require('discord.js');
const { CHANNELS } = require('../constants');

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
  async execute(interaction, client, db) {
    const perms = interaction.member.permissions || interaction.member.permissionsIn?.(interaction.channel);
    const isAdmin = perms && perms.has && perms.has(PermissionsBitField.Flags.Administrator);
    if (!isAdmin) return interaction.reply({ content: 'Administrator permission required.', ephemeral: true });

    const role = interaction.options.getRole('role', true);
    const message = interaction.options.getString('message', true);
    const limitOpt = interaction.options.getInteger('limit');
    const preview = interaction.options.getBoolean('preview') || false;

    await interaction.deferReply({ ephemeral: true });

    // cooldown check (only applies to actual sends, not previews)
    if (!preview) {
      const last = cooldowns.get(interaction.user.id) || 0;
      const now = Date.now();
      if (now - last < COOLDOWN_MS) {
        const rem = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
        return interaction.editReply({ content: `Please wait ${rem}s before sending another DM broadcast. Use preview to test.`, ephemeral: true });
      }
      cooldowns.set(interaction.user.id, now);
    }

    // fetch members; prefer fresh fetch but fall back to cache
    let membersCol;
    try {
      membersCol = await interaction.guild.members.fetch();
    } catch (e) {
      membersCol = interaction.guild.members.cache;
    }

    const targets = membersCol.filter(m => m.roles.cache.has(role.id) && !m.user.bot);
    const totalFound = targets.size;
    if (!totalFound) return interaction.editReply({ content: `No human members found with the role ${role.name}.`, ephemeral: true });

    const cap = Math.min(limitOpt || DEFAULT_MAX, HARD_MAX);
    const recipients = Array.from(targets.values()).slice(0, cap);

    if (preview) {
      const sample = recipients.slice(0, 10).map(m => `<@${m.id}>`).join(', ');
      return interaction.editReply({ content: `Preview: found ${totalFound} members, showing up to ${cap}. First ${Math.min(10, recipients.length)}: ${sample}`, ephemeral: true });
    }

    // Queue the job and return immediately to avoid interaction timeouts
    const batches = [];
    for (let i = 0; i < recipients.length; i += BATCH_SIZE) batches.push(recipients.slice(i, i + BATCH_SIZE));

    // Fire-and-forget async job with retries and enhanced metrics
    (async () => {
      let totalSent = 0;
      let totalFailed = 0;
      let totalRetries = 0;
      const auditChId = CHANNELS && CHANNELS.INVITES_OVERALL ? CHANNELS.INVITES_OVERALL : null;
      let auditCh = null;
      if (auditChId) auditCh = await interaction.guild.channels.fetch(auditChId).catch(() => null);

      if (auditCh && auditCh.send) {
        await auditCh.send(`DM broadcast queued by <@${interaction.user.id}> to role **${role.name}**: ${recipients.length} recipients in ${batches.length} batch(es).`)
          .catch(() => null);
      }

      const sendWithRetries = async (member, message, maxRetries = 2) => {
        let attempts = 0;
        while (attempts <= maxRetries) {
          try {
            await member.send(message);
            return { ok: true, attempts };
          } catch (err) {
            attempts++;
            if (attempts > maxRetries) return { ok: false, attempts };
            // backoff before retry
            await new Promise(r => setTimeout(r, DELAY_MS * 2));
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

        // log batch results
        if (auditCh && auditCh.send) {
          await auditCh.send(`DM batch ${b + 1}/${batches.length} by <@${interaction.user.id}> to **${role.name}**: attempted ${batch.length}, sent ${batchSent}, failed ${batchFailed}, retries ${batchRetries}. Total so far: sent ${totalSent}, failed ${totalFailed}, retries ${totalRetries}.`).catch(() => null);
        }

        // delay between batches
        if (b < batches.length - 1) await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }

      // final audit
      if (auditCh && auditCh.send) {
        await auditCh.send(`DM broadcast completed by <@${interaction.user.id}> to **${role.name}**: attempted ${recipients.length}, sent ${totalSent}, failed ${totalFailed}, total retries ${totalRetries}.`).catch(() => null);
      }
    })();

    return interaction.editReply({ content: `Queued DM broadcast to ${recipients.length} recipient(s) in ${batches.length} batch(es). Progress will be posted to the audit channel.`, ephemeral: true });
  }
};
