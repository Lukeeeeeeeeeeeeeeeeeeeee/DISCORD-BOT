const cron = require('node-cron');
const dayjs = require('dayjs');
const { MIN_RECRUITS_FOR_AUTO, EXEMPT_TOP_PERCENT, REPEATED_FLAGS_TO_WARN, ESCALATION_WINDOW_WEEKS, CHANNELS } = require('./constants');

function computeStats(db, region, since=0) {
  // since: timestamp in ms. If zero, consider all-time; otherwise limit to recruits.created_at >= since
  const totalRow = since ? db.prepare('SELECT COUNT(*) as c FROM recruits WHERE region = ? AND valid = 1 AND created_at >= ?').get(region, since) : db.prepare('SELECT COUNT(*) as c FROM recruits WHERE region = ? AND valid = 1').get(region);
  const total = totalRow ? totalRow.c : 0;
  const rows = since ? db.prepare('SELECT recruiter_id, COUNT(*) as cnt FROM recruits WHERE region = ? AND valid = 1 AND created_at >= ? GROUP BY recruiter_id').all(region, since)
                 : db.prepare('SELECT recruiter_id, COUNT(*) as cnt FROM recruits WHERE region = ? AND valid = 1 GROUP BY recruiter_id').all(region);
  if (!rows.length) return [];
  const counts = rows.map(r=>r.cnt);
  const mean = counts.reduce((a,b)=>a+b,0)/counts.length;
  const variance = counts.reduce((a,b)=>a + Math.pow(b-mean,2),0)/counts.length;
  const stddev = Math.sqrt(variance);
  rows.forEach(r=>{
    r.mean = mean; r.stddev = stddev; r.total = total;
  });
  return rows;
}

function applyFlags(db, guild) {
  // use last 7 days as the weekly window
  const sinceWindow = Date.now() - (7*24*60*60*1000);
  ['EU','NA','AS'].forEach(region=>{
    const rows = computeStats(db, region, sinceWindow);
    if (!rows.length) return;
    const active = rows.filter(r=>r.cnt >= MIN_RECRUITS_FOR_AUTO);
    if (active.length <= 2) return; // no auto-warnings
    const total = rows[0].total;
    rows.sort((a,b)=>b.cnt-a.cnt);
    const next_highest = (i)=> rows[i+1] ? rows[i+1].cnt : 0;

    rows.forEach((r,i)=>{
      const z = r.stddev ? (r.cnt - r.mean)/r.stddev : 0;
      const flagged = [];
      if (z >= 2.5) flagged.push('Outlier');
      if (r.cnt/total >= 0.5 && total >= 8) flagged.push('Share');
      if (r.cnt >= next_highest(i) + Math.max(5, 0.2 * total)) flagged.push('Gap');

      // Exempt top EXEMPT_TOP_PERCENT from auto-conversion to warning
      const exemptCutoff = Math.max(1, Math.ceil(rows.length * EXEMPT_TOP_PERCENT));
      const exempt = i < exemptCutoff;

      if (flagged.length) {
        db.prepare('INSERT INTO flags (recruiter_id, reason, created_at) VALUES (?, ?, ?)').run(r.recruiter_id, flagged.join(','), Date.now());

        // check escalation
        const since = Date.now() - (ESCALATION_WINDOW_WEEKS*7*24*60*60*1000);
        const countFlags = db.prepare('SELECT COUNT(*) as c FROM flags WHERE recruiter_id = ? AND created_at >= ?').get(r.recruiter_id, since).c;
        if (!exempt && countFlags >= REPEATED_FLAGS_TO_WARN) {
          db.prepare('INSERT INTO warnings (recruiter_id, created_at, note) VALUES (?, ?, ?)').run(r.recruiter_id, Date.now(), 'Auto-created from repeated flags');
          // increment warnings in recruiters table
          db.prepare('UPDATE recruiters SET warnings = warnings + 1 WHERE id = ?').run(r.recruiter_id);
          // DM recruiter
          guild.members.fetch(r.recruiter_id).then(m=>{
            m.send('You have received a warning for suspicious recruiting activity.').catch(()=>{});
          }).catch(()=>{});
          // post to warnings channel
          const ch = guild.channels.cache.get(CHANNELS.RECRUITER_WARNINGS);
          if (ch) ch.send(`<@${r.recruiter_id}> received an automated warning.`).catch(()=>{});
        }
      }
    });
  });
}

function formatLeaderboardMessage(rows, regionLabel) {
  // rows: [{recruiter_id, cnt}, ...] sorted desc
  const { MIN_LEADERBOARD_ENTRIES } = require('./constants');
  if (!rows || rows.length === 0) return `Leaderboard (${regionLabel})\nNo weekly recruits yet`;
  if (rows.length < MIN_LEADERBOARD_ENTRIES) return `Leaderboard (${regionLabel})\nNot enough data yet (need at least ${MIN_LEADERBOARD_ENTRIES} active recruiters this week).`;

  const podium = rows.slice(0,3);
  const others = rows.slice(3);
  const peopleWith3 = rows.filter(r => r.cnt >= 3 && !podium.find(p => p.recruiter_id === r.recruiter_id));

  const podiumText = podium.map((r, i) => `${i+1}. <@${r.recruiter_id}> — **${r.cnt}**`).join('\n');
  const peopleWith3Text = peopleWith3.length ? '\n\n**PEOPLE WITH +3**\n' + peopleWith3.map(r => `<@${r.recruiter_id}> — ${r.cnt}`).join('\n') : '';
  const otherText = others.length ? '\n\n**OTHER**\n' + others.map((r, i) => `${i+4}. <@${r.recruiter_id}> — ${r.cnt}`).join('\n') : '';

  return `Leaderboard (${regionLabel})\n\n**PODIUM**\n${podiumText}${peopleWith3Text}${otherText}`;
}

async function recomputeLeaderboards(db, guild) {
  // For each of the region channels, update a single message with top recruiters
  const regions = [{key:'EU', channel: CHANNELS.INVITES_EU},{key:'NA', channel: CHANNELS.INVITES_NA},{key:'AS', channel: CHANNELS.INVITES_AS}];
  const since = Date.now() - (7*24*60*60*1000);
  const { upsertLeaderboardMessage } = require('./lib/messages');
  for (const rg of regions) {
    const rows = db.prepare('SELECT recruiter_id, COUNT(*) as cnt FROM recruits WHERE region = ? AND valid = 1 AND created_at >= ? GROUP BY recruiter_id ORDER BY cnt DESC').all(rg.key, since);
    const ch = guild.channels.cache.get(rg.channel);
    if (!ch) continue;
    try {
      const text = formatLeaderboardMessage(rows, rg.key);
      // Update region channel message via helper using embed
      const { makeLeaderboardEmbed } = require('./lib/messages');
      const lang = process.env.DEFAULT_LANG || 'en';
      const embed = makeLeaderboardEmbed(rows, rg.key, lang);
      await upsertLeaderboardMessage(db, ch, rg.key, null, embed).catch(()=>{});

      // Cross-post / update in central channel
      try {
        const { CHANNELS } = require('./constants');
        const central = guild.channels.cache.get(CHANNELS.CENTRAL_LEADERBOARD);
        if (central) await upsertLeaderboardMessage(db, central, rg.key, null, embed).catch(()=>{});
      } catch (e) {
        // best-effort
      }
    } catch (err) {
      // ignore non-critical errors
      console.error('Leaderboard update failed for', rg.key, err);
    }
  }
}

function start(client, db) {
    // run immediately on start and then schedule weekly
    client.once('ready', ()=>{
      applyFlags(db, client.guilds.cache.get(process.env.GUILD_ID));
      recomputeLeaderboards(db, client.guilds.cache.get(process.env.GUILD_ID));
    });

    // Cron: Sunday at 12:00 UTC
    cron.schedule('0 12 * * 0', () => {
      const guild = client.guilds.cache.get(process.env.GUILD_ID);
      if (!guild) return;
      // Recompute statistics, check for members who left and mark recruits invalid
      // Remove recruits where member left
      const recruits = db.prepare('SELECT * FROM recruits WHERE valid = 1').all();
      recruits.forEach(r=>{
        guild.members.fetch(r.recruited_id).catch(()=>{
          // member not found, mark invalid and recompute
          db.prepare('UPDATE recruits SET valid = 0 WHERE id = ?').run(r.id);
        });
      });

      // Apply flags and leaderboard recompute
      applyFlags(db, guild);
      recomputeLeaderboards(db, guild);

      // Reset weekly counts: For this system we will delete weekly recruits or set a week marker; simpler: purchases/points persist; leaderboards are recomputed from recruits with timestamps; however spec says reset weekly counts — we implement a 'week' table for counts or just reset points for weekly scoreboard. For now, keep recruits but staff can clear weekly counts by truncating a 'weekly' view. (Tunable later.)
    }, {
      scheduled: true,
      timezone: 'UTC'
    });

    // Monthly reset: 1st of month 00:00 UTC
    cron.schedule('0 0 1 * *', () => {
      try {
        db.prepare('UPDATE recruiters SET points = 0').run();
        const guild = client.guilds.cache.get(process.env.GUILD_ID);
        if (guild) {
          const ch = guild.channels.cache.get(CHANNELS.INVITES_OVERALL);
          if (ch) ch.send('Monthly recruiter points reset to 0.').catch(()=>{});
        }
      } catch (e) { console.error('Monthly reset failed', e); }
    }, {
      scheduled: true,
      timezone: 'UTC'
    });
}

module.exports = {
  start,
  applyFlags,
  recomputeLeaderboards,
  formatLeaderboardMessage
};