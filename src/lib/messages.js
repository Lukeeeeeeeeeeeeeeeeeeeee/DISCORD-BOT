const { EmbedBuilder } = require('discord.js');
const { formatPointsValue } = require('./economy');
const { getRegionInfo } = require('./regions');
const { t } = require('./i18n');
const { acquireJobLock } = require('./job-locks');

const PENDING_MESSAGE_ID = '__PENDING__';
const PENDING_WAIT_MS = Number.parseInt(process.env.LEADERBOARD_PENDING_WAIT_MS || '2000', 10);
const PENDING_POLL_INTERVAL_MS = 100;
const LEADERBOARD_UPSERT_LOCK_MS = Number.parseInt(process.env.LEADERBOARD_UPSERT_LOCK_MS || '10000', 10);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeRecruitEmbed(recruiter, recruited, region, ign, lang = 'en', meta = {}) {
  const info = getRegionInfo(region);
  const title = `${info.emoji} ${t('recruit.title', lang)}`;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(info.color)
    .addFields(
      { name: 'Recruiter', value: `<@${recruiter}>`, inline: true },
      { name: 'Recruited', value: `<@${recruited}>`, inline: true },
      { name: 'Team', value: `${info.name}`, inline: true },
      { name: 'IGN', value: ign || 'N/A', inline: true }
    )
    .setTimestamp();

  if (meta.points !== undefined) embed.addFields({ name: 'Points', value: `${meta.points}`, inline: true });
  if (meta.recruiterRole) embed.addFields({ name: 'Recruiter Role', value: `${meta.recruiterRole}`, inline: true });

  if (info.thumbnail) embed.setThumbnail(info.thumbnail);
  return embed;
}

function normalizeMinReq(row) {
  const rawMinReq = row && row.minReq !== undefined ? row.minReq : null;
  if (rawMinReq == null) return row && row.absence ? 0 : 2;
  if (rawMinReq <= 0 && !(row && row.absence)) return 2;
  return rawMinReq;
}

function getRecruitCount(row) {
  return (row && (row.recruits7d || row.cnt)) ? (row.recruits7d || row.cnt) : 0;
}

function sortLeaderboardRows(rows) {
  const keyed = (rows || []).map((row) => ({
    row,
    count: getRecruitCount(row),
    points: Number(row && row.points != null ? row.points : 0),
    minReq: normalizeMinReq(row)
  }));
  keyed.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (b.points !== a.points) return b.points - a.points;
    if (a.minReq !== b.minReq) return a.minReq - b.minReq;
    return 0;
  });
  return keyed.map(item => item.row);
}

function sortDemotionRows(rows) {
  const keyed = (rows || []).map((row) => ({
    row,
    warnings: Number(
      row && row.warningCount != null
        ? row.warningCount
        : (row && row.activeWarnings != null ? row.activeWarnings : 0)
    ) || 0,
    count: getRecruitCount(row),
    points: Number(row && row.points != null ? row.points : 0),
    minReq: normalizeMinReq(row)
  }));
  keyed.sort((a, b) => {
    if (b.warnings !== a.warnings) return b.warnings - a.warnings;
    if (b.count !== a.count) return b.count - a.count;
    if (b.points !== a.points) return b.points - a.points;
    if (a.minReq !== b.minReq) return a.minReq - b.minReq;
    return 0;
  });
  return keyed.map(item => item.row);
}

function formatLeaderboardLine(row, index) {
  // Always use proper Discord mention format, ignore any displayName
  const mention = row && row.recruiter_id ? `<@${row.recruiter_id}>` : 'Unknown';
  const recruitCount = getRecruitCount(row);
  const minReq = normalizeMinReq(row);
  const points = row && row.points != null ? row.points : 0;
  const warningCountRaw = row && row.warningCount != null
    ? Number(row.warningCount)
    : (row && row.activeWarnings != null ? Number(row.activeWarnings) : null);
  const warningCount = Number.isFinite(warningCountRaw) ? warningCountRaw : null;
  const warningCountText = warningCount && warningCount > 0 ? ` ⚠️${warningCount}` : '';
  const warningFlag = row && row.systemWarning ? ' ⚠️**!**' : '';
  return `${index + 1}. ${mention} [${recruitCount}/${minReq} | ${formatPointsValue(points)} pts]${warningCountText}${warningFlag}`;
}

function makeLeaderboardText(rows, regionLabel, lang = 'en') {
  // Map region codes to team names
  let info;
  if (regionLabel === 'GLOBAL') {
    info = { emoji: '🌍', name: 'Global' };
  } else {
    info = getRegionInfo(regionLabel);
  }

  // Use simple hardcoded title - don't rely on i18n
  const title = `${info.emoji} Leaderboard (${info.name})`;
  if (!rows || rows.length === 0) {
    const msg = `${title}\nNo recruiters found.`;
    return msg.length > 2000 ? msg.slice(0, 1997) + '...' : msg;
  }

  // Sort by recruits desc, then points desc, then minReq asc.
  const sortedRows = sortLeaderboardRows(rows);

  const lines = sortedRows.map((r, i) => formatLeaderboardLine(r, i));

  const out = [title, ...lines];
  let text = out.join('\n');
  if (text.length <= 2000) return text;

  // Fit as many lines as possible into a single message
  const kept = [title];
  for (const line of lines) {
    const next = kept.concat(line).join('\n');
    if (next.length > 1950) break;
    kept.push(line);
  }
  const remaining = lines.length - (kept.length - 1);
  if (remaining > 0) kept.push(`...and ${remaining} more`);
  text = kept.join('\n');
  return text.length > 2000 ? text.slice(0, 1997) + '...' : text;
}

function makeDemotionWatchText(rows, _lang = 'en') {
  const title = '# Demotion Watch';
  if (!rows || rows.length === 0) {
    const msg = `${title}\nNo recruiters on demotion watch.`;
    return msg.length > 2000 ? msg.slice(0, 1997) + '...' : msg;
  }

  const sortedRows = sortDemotionRows(rows);
  const lines = sortedRows.map((r, i) => formatLeaderboardLine(r, i));
  const out = [title, ...lines];
  let text = out.join('\n');
  if (text.length <= 2000) return text;

  const kept = [title];
  for (const line of lines) {
    const next = kept.concat(line).join('\n');
    if (next.length > 1950) break;
    kept.push(line);
  }
  const remaining = lines.length - (kept.length - 1);
  if (remaining > 0) kept.push(`...and ${remaining} more`);
  text = kept.join('\n');
  return text.length > 2000 ? text.slice(0, 1997) + '...' : text;
}

async function upsertLeaderboardMessage(db, channel, region, content, embed, guildId) {
  // Try to resolve guildId from channel if not provided
  const resolvedGuildId = guildId || (channel && channel.guild ? channel.guild.id : null);

  if (!resolvedGuildId) {
    console.error('upsertLeaderboardMessage: Missing guildId', { channelId: channel && channel.id, region });
    return null;
  }
  const payload = embed && typeof embed === 'object' && typeof embed.toJSON === 'function'
    ? { content: content || null, embeds: [embed], allowedMentions: { parse: [] } }
    : { content: content || null, allowedMentions: { parse: [] } };
  const upsertLockKey = `leaderboard_msg_${channel && channel.id ? channel.id : 'unknown'}_${region || 'default'}`;

  const tryEditById = async (messageId) => {
    if (!messageId || !channel || !channel.messages) return null;
    if (typeof channel.messages.edit === 'function') {
      return channel.messages.edit(messageId, payload).catch(() => null);
    }
    return null;
  };

  const tryFetch = async (messageId) => {
    if (!messageId || !channel || !channel.messages) return null;
    if (typeof channel.messages.fetch === 'function') {
      return channel.messages.fetch(messageId).catch(() => null);
    }
    return null;
  };

  const waitForResolvedRecord = async () => {
    const deadline = Date.now() + Math.max(0, PENDING_WAIT_MS);
    while (Date.now() <= deadline) {
      const row = await db.get(
        'SELECT * FROM leaderboard_messages WHERE guild_id = ? AND channel_id = ? AND region = ?',
        resolvedGuildId,
        channel.id,
        region
      );
      if (row && row.message_id && row.message_id !== PENDING_MESSAGE_ID) return row;
      await sleep(PENDING_POLL_INTERVAL_MS);
    }
    return db.get(
      'SELECT * FROM leaderboard_messages WHERE guild_id = ? AND channel_id = ? AND region = ?',
      resolvedGuildId,
      channel.id,
      region
    );
  };

  // Cross-shard/process guard: only one writer should own a leaderboard upsert at a time.
  // Fail-closed to prevent duplicate message creation when lock state is uncertain.
  let ownsUpsertLock = true;
  if (db && resolvedGuildId && Number.isFinite(LEADERBOARD_UPSERT_LOCK_MS) && LEADERBOARD_UPSERT_LOCK_MS > 0) {
    ownsUpsertLock = await acquireJobLock(db, {
      guildId: resolvedGuildId,
      key: upsertLockKey,
      ttlMs: LEADERBOARD_UPSERT_LOCK_MS,
      failOpen: false
    });
  }

  if (!ownsUpsertLock) {
    const resolved = await waitForResolvedRecord();
    if (resolved && resolved.message_id && resolved.message_id !== PENDING_MESSAGE_ID) {
      let msg = await tryEditById(resolved.message_id);
      if (!msg) {
        const fetched = await tryFetch(resolved.message_id);
        if (fetched) {
          await fetched.edit(payload);
          msg = fetched;
        }
      }
      if (msg) {
        await db.run('UPDATE leaderboard_messages SET updated_at = ? WHERE id = ?', Date.now(), resolved.id);
        return msg;
      }
    }
    // If the owner did not resolve the row in time, continue with normal flow.
  }

  // record keyed by channel_id + region (and guild_id for correctness)
  const record = await db.get('SELECT * FROM leaderboard_messages WHERE guild_id = ? AND channel_id = ? AND region = ?', resolvedGuildId, channel.id, region);
  if (record && record.message_id !== PENDING_MESSAGE_ID) {
    let msg = await tryEditById(record.message_id);
    if (!msg) {
      const fetched = await tryFetch(record.message_id);
      if (fetched) {
        await fetched.edit(payload);
        msg = fetched;
      }
    }
    if (msg) {
      await db.run('UPDATE leaderboard_messages SET updated_at = ? WHERE id = ?', Date.now(), record.id);
      return msg;
    } else {
      const m = await channel.send(payload);
      try {
        await db.run('UPDATE leaderboard_messages SET message_id = ?, updated_at = ? WHERE id = ?', m.id, Date.now(), record.id);
      } catch (e) {
        console.error('Failed to persist leaderboard message pointer after send', {
          guildId: resolvedGuildId,
          channelId: channel.id,
          region,
          error: e
        });
      }
      return m;
    }
  } else if (record && record.message_id === PENDING_MESSAGE_ID) {
    const resolved = await waitForResolvedRecord();
    if (resolved && resolved.message_id && resolved.message_id !== PENDING_MESSAGE_ID) {
      let msg = await tryEditById(resolved.message_id);
      if (!msg) {
        const fetched = await tryFetch(resolved.message_id);
        if (fetched) {
          await fetched.edit(payload);
          msg = fetched;
        }
      }
      if (msg) {
        await db.run('UPDATE leaderboard_messages SET updated_at = ? WHERE id = ?', Date.now(), resolved.id);
        return msg;
      }
    }
    // If pending never resolves (writer crash), continue and attempt ownership below.
  } else {
    let ownsCreate = false;
    try {
      await db.run(
        'INSERT INTO leaderboard_messages (guild_id, channel_id, message_id, region, updated_at) VALUES (?, ?, ?, ?, ?)',
        resolvedGuildId,
        channel.id,
        PENDING_MESSAGE_ID,
        region,
        Date.now()
      );
      ownsCreate = true;
    } catch (e) {
      const msg = String((e && e.message) || '').toLowerCase();
      const conflict = msg.includes('unique') || msg.includes('constraint');
      if (!conflict) {
        console.error('Failed to insert leaderboard message record:', e);
      }
    }

    if (ownsCreate) {
      try {
        const m = await channel.send(payload);
        await db.run(
          'UPDATE leaderboard_messages SET message_id = ?, updated_at = ? WHERE guild_id = ? AND channel_id = ? AND region = ?',
          m.id,
          Date.now(),
          resolvedGuildId,
          channel.id,
          region
        );
        return m;
      } catch (sendErr) {
        try {
          await db.run(
            'DELETE FROM leaderboard_messages WHERE guild_id = ? AND channel_id = ? AND region = ? AND message_id = ?',
            resolvedGuildId,
            channel.id,
            region,
            PENDING_MESSAGE_ID
          );
        } catch (cleanupErr) { console.error('Failed to clean up pending message:', cleanupErr); }
        throw sendErr;
      }
    }

    const resolved = await waitForResolvedRecord();
    if (resolved && resolved.message_id && resolved.message_id !== PENDING_MESSAGE_ID) {
      let msg = await tryEditById(resolved.message_id);
      if (!msg) {
        const fetched = await tryFetch(resolved.message_id);
        if (fetched) {
          await fetched.edit(payload);
          msg = fetched;
        }
      }
      if (msg) {
        await db.run('UPDATE leaderboard_messages SET updated_at = ? WHERE id = ?', Date.now(), resolved.id);
        return msg;
      }
    }

    // Last resort fallback if pending owner never completed and no editable row exists.
    const m = await channel.send(payload);
    try {
      await db.run(
        'UPDATE leaderboard_messages SET message_id = ?, updated_at = ? WHERE guild_id = ? AND channel_id = ? AND region = ?',
        m.id,
        Date.now(),
        resolvedGuildId,
        channel.id,
        region
      );
    } catch (e) {
      console.error('Failed to upsert fallback leaderboard message record:', e);
    }
    return m;
  }
}

function makeLeaderboardEmbed(rows, regionLabel, lang = 'en') {
  let info;
  if (regionLabel === 'GLOBAL') {
    info = { emoji: '🌍', color: 0xFFD700, name: 'Global' };
  } else {
    info = getRegionInfo(regionLabel);
  }

  const title = `${info.emoji} ${t('leaderboard.title', lang, { region: info.name })}`;
  const embed = new EmbedBuilder().setTitle(title).setColor(info.color).setTimestamp();

  if (!rows || rows.length === 0) {
    embed.setDescription('No recruiters found.');
    return embed;
  }

  const sortedRows = sortLeaderboardRows(rows);
  const lines = sortedRows.map((r, i) => formatLeaderboardLine(r, i));

  const fieldName = t('leaderboard.title', lang, { region: info.name });
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > 1024) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);

  const maxFields = 25;
  const toRender = chunks.slice(0, maxFields);
  for (let i = 0; i < toRender.length; i++) {
    const name = i === 0 ? fieldName : `${fieldName} (${i + 1})`;
    embed.addFields({ name, value: toRender[i] });
  }
  if (chunks.length > maxFields) {
    embed.addFields({
      name: 'More Recruiters',
      value: `...and ${chunks.length - maxFields} more section(s).`,
      inline: false
    });
  }
  return embed;
}

function makeWarningsEmbed(rows, _lang = 'en') {
  const title = '⚠️ Warnings Leaderboard';

  const embed = new EmbedBuilder().setTitle(title).setColor(0xffaa00).setTimestamp();

  if (!rows || rows.length === 0) {
    embed.setDescription('No active warnings.');
    return embed;
  }

  const lines = rows.map((r, i) => `${i + 1}. <@${r.recruiter_id}> — **${r.cnt}** warnings`).join('\n');
  embed.addFields({ name: 'Warnings', value: lines });
  return embed;
}

module.exports = {
  makeRecruitEmbed,
  upsertLeaderboardMessage,
  makeLeaderboardEmbed,
  makeLeaderboardText,
  makeWarningsEmbed,
  makeDemotionWatchText
};
