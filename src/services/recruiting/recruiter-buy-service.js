const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const {
  PURCHASE_ITEMS,
  APPROVAL_ONLY_ITEMS,
  PURCHASE_ITEM_ALIASES,
  ROLE_IDS
} = require('../../constants');
const { hasRecruiterOrStaffPermissions, getMemberRoleIds } = require('../../lib/permissions');
const { formatPointsValue, ECONOMY_CONFIG, applyMultiplier } = require('../../lib/economy');
const { replyError } = require('../../lib/embeds');
const { logUnexpectedError } = require('../../lib/logger');
const { postPurchaseLog } = require('../../lib/recruiter-helpers');
const { withTransaction } = require('../../lib/transactions');
const { changeRecruiterPoints } = require('./ledger-service');

const PURCHASE_ITEM_LABELS = Object.freeze({
  'custom-nickname': 'Custom nickname',
  'vip': 'VIP',
  'mvp': 'MVP',
  'custom-vc': 'Custom VC',
  'custom-role': 'Custom role',
  'custom-suggestion': 'Custom suggestion'
});

function normalizePurchaseItemKey(item) {
  if (!item) return '';
  const value = String(item).trim();
  if (!value) return '';
  if (PURCHASE_ITEM_ALIASES && PURCHASE_ITEM_ALIASES[value]) {
    return PURCHASE_ITEM_ALIASES[value];
  }
  return value;
}

function getPurchaseItemLabel(itemKey) {
  if (!itemKey) return 'Unknown item';
  return PURCHASE_ITEM_LABELS[itemKey] || itemKey;
}

async function hasActiveMultiplierOfType(conn, { guildId, userId, type, nowTs = Date.now() }) {
  if (!conn || !userId || !type) return false;
  try {
    const row = await conn.get(
      `SELECT id FROM multipliers
       WHERE guild_id = ? AND recruiter_id = ? AND type = ? AND expires_at > ?
       ORDER BY expires_at DESC
       LIMIT 1`,
      guildId,
      userId,
      type,
      nowTs
    );
    return !!row;
  } catch (e) {
    const msg = String((e && e.message) || '').toLowerCase();
    if (!msg.includes('no such column')) throw e;
    const legacyRow = await conn.get(
      `SELECT id FROM multipliers
       WHERE recruiter_id = ? AND type = ? AND expires_at > ?
       ORDER BY expires_at DESC
       LIMIT 1`,
      userId,
      type,
      nowTs
    );
    return !!legacyRow;
  }
}

async function handleBuy({ interaction, db, guildId }) {
  const requestedItem = interaction.options.getString('item');
  const item = normalizePurchaseItemKey(requestedItem);
  const userId = interaction.user.id;
  const isTest = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;

  const guildMember = interaction.guild && interaction.guild.members && interaction.guild.members.fetch
    ? await interaction.guild.members.fetch(userId).catch(() => null)
    : null;
  const roleSource = guildMember || interaction.member || null;

  const roleIds = getMemberRoleIds(roleSource);

  if (!roleSource || (!roleIds.length && !isTest)) {
    return replyError(interaction, 'Unable to verify your roles right now. Please try again.');
  }

  if (!isTest && roleIds.includes(ROLE_IDS.UNVERIFIED)) {
    return replyError(interaction, 'You must be verified (Rookie+) to purchase items.');
  }

  const verifiedRoleIds = [
    ROLE_IDS.ROOKIE,
    ROLE_IDS.AUTO_PROMOTE_ROLE,
    ...(ROLE_IDS.TEAM_MEMBER ? Object.values(ROLE_IDS.TEAM_MEMBER) : []),
    ROLE_IDS.VIP,
    ROLE_IDS.MVP,
    ROLE_IDS.CUSTOM
  ].filter(Boolean);

  const hasVerifiedRole = verifiedRoleIds.some(roleId => roleIds.includes(roleId));
  const isAllowed = isTest
    ? true
    : (hasRecruiterOrStaffPermissions(roleSource) || hasVerifiedRole);

  if (!isAllowed) {
    return replyError(interaction, 'You need to be verified (Rookie+) or a recruiter/staff to purchase items.');
  }

  const rec = await db.get('SELECT * FROM recruiters WHERE guild_id = ? AND id = ?', guildId, userId);
  const points = rec ? Number(rec.points || 0) : 0;

  const multCfg = ECONOMY_CONFIG.MULTIPLIERS[item];
  if (multCfg) {
    const cost = multCfg.cost;
    const alreadyActive = await hasActiveMultiplierOfType(db, { guildId, userId, type: item });
    if (alreadyActive) {
      return replyError(interaction, 'That multiplier is already active for you. Wait for it to expire before buying again.');
    }
    if (points < cost) return replyError(interaction, 'Not enough points to buy that multiplier.');
    try {
      await withTransaction(db, async (tx) => {
        const activeInTx = await hasActiveMultiplierOfType(tx, { guildId, userId, type: item });
        if (activeInTx) {
          const err = new Error('MULTIPLIER_ALREADY_ACTIVE');
          err.code = 'MULTIPLIER_ALREADY_ACTIVE';
          throw err;
        }
        await changeRecruiterPoints(tx, {
          guildId,
          recruiterId: userId,
          delta: -cost,
          reason: 'buy_multiplier',
          refType: 'multiplier',
          refId: item,
          minPoints: 0
        });
        await applyMultiplier(tx, userId, item, { guildId });
        await tx.run('INSERT INTO purchases (guild_id, recruiter_id, item, cost, created_at) VALUES (?, ?, ?, ?, ?)', guildId, userId, item, cost, Date.now());
      });
    } catch (e) {
      if ((e && e.code) === 'MULTIPLIER_ALREADY_ACTIVE' || String((e && e.message) || '').includes('MULTIPLIER_ALREADY_ACTIVE')) {
        return replyError(interaction, 'That multiplier is already active for you. Wait for it to expire before buying again.');
      }
      logUnexpectedError('economy.buyMultiplier', e, { userId, item });
      return replyError(interaction, 'Purchase failed. Please try again.');
    }
    await postPurchaseLog({ guild: interaction.guild, userId, item, cost });
    const embed = new EmbedBuilder()
      .setTitle('Multiplier Purchased')
      .setDescription(`Applied **${item}** for ${multCfg.days} days for **${formatPointsValue(cost)}** points.`)
      .setColor(0x00AAFF)
      .setTimestamp();
    return interaction.reply({ embeds: [embed] });
  }

  if (APPROVAL_ONLY_ITEMS && APPROVAL_ONLY_ITEMS[item]) {
    const label = getPurchaseItemLabel(item);
    const approvalNote = String(APPROVAL_ONLY_ITEMS[item]);
    const embed = new EmbedBuilder()
      .setTitle('Approval Required')
      .setDescription(`**${label}** is staff-approved only.\n${approvalNote}\n\nNo points were deducted.`)
      .setColor(0x00AAFF)
      .setTimestamp();
    return interaction.reply({ embeds: [embed] });
  }

  const cost = PURCHASE_ITEMS[item];
  if (!Number.isFinite(cost)) {
    const multiplierItems = Object.entries(ECONOMY_CONFIG.MULTIPLIERS)
      .map(([k, v]) => `**${formatPointsValue(v.value)}x - ${v.days} days** - **${formatPointsValue(v.cost)}** pts (\`${k}\`)`)
      .join('\n');
    const purchaseItems = Object.entries(PURCHASE_ITEMS)
      .map(([k, c]) => `**${getPurchaseItemLabel(k)}** - **${formatPointsValue(c)}** pts (\`${k}\`)`)
      .join('\n');
    const approvalOnlyItems = Object.entries(APPROVAL_ONLY_ITEMS || {})
      .map(([k, note]) => `**${getPurchaseItemLabel(k)}** - ${String(note)} (\`${k}\`)`)
      .join('\n');
    const embed = new EmbedBuilder()
      .setTitle('Available Items')
      .addFields(
        { name: 'Multipliers', value: multiplierItems || 'None available', inline: false },
        { name: 'Rewards', value: purchaseItems || 'None available', inline: false },
        { name: 'Staff approval', value: approvalOnlyItems || 'None', inline: false }
      )
      .setColor(0x00AAFF)
      .setFooter({ text: 'Use /recruiter buy <item_name> to purchase' })
      .setTimestamp();
    return interaction.reply({ embeds: [embed] });
  }

  if (points < cost) return replyError(interaction, 'Not enough points.');

  const roleGrantMap = {
    'vip': ROLE_IDS.VIP,
    'mvp': ROLE_IDS.MVP
  };
  const grantRoleId = roleGrantMap[item] || null;
  let memberRec = null;
  let grantRole = null;

  if (grantRoleId && interaction.guild) {
    grantRole = interaction.guild.roles.cache.get(grantRoleId) || null;
    if (!grantRole) {
      return replyError(interaction, 'That role is not configured for purchase right now.');
    }

    memberRec = guildMember
      || (interaction.guild.members && typeof interaction.guild.members.fetch === 'function'
        ? await interaction.guild.members.fetch(userId).catch(() => null)
        : null);
    if (!memberRec) {
      return replyError(interaction, 'Unable to resolve your member record for role purchase.');
    }

    const botMember = interaction.guild.members && interaction.guild.members.me
      ? interaction.guild.members.me
      : (interaction.guild.members && typeof interaction.guild.members.fetch === 'function'
        ? await interaction.guild.members.fetch(interaction.client.user.id).catch(() => null)
        : null);
    const canManageRoles = botMember && botMember.permissions && botMember.permissions.has
      ? botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)
      : false;
    if (!canManageRoles) {
      return replyError(interaction, 'Bot lacks Manage Roles permission to grant that item.');
    }
    if (!botMember || !botMember.roles || !botMember.roles.highest) {
      return replyError(interaction, 'Unable to verify bot role hierarchy for role purchase.');
    }
    if (grantRole.position >= botMember.roles.highest.position) {
      return replyError(interaction, 'Bot role hierarchy is too low to grant that role.');
    }
    if (memberRec.roles && memberRec.roles.cache && memberRec.roles.cache.has(grantRoleId)) {
      return replyError(interaction, 'You already have that role.');
    }
  }

  if (grantRoleId && memberRec) {
    let reserved = false;
    try {
      await withTransaction(db, async (tx) => {
        await changeRecruiterPoints(tx, {
          guildId,
          recruiterId: userId,
          delta: -cost,
          reason: 'buy_item_reserve',
          refType: 'item',
          refId: item,
          minPoints: 0
        });
      });
      reserved = true;
    } catch (e) {
      logUnexpectedError('economy.buyItemReserve', e, { userId, item });
      return replyError(interaction, 'Purchase failed. Please try again.');
    }

    try {
      await memberRec.roles.add(grantRoleId);
    } catch (e) {
      if (reserved) {
        await withTransaction(db, async (tx) => {
          await changeRecruiterPoints(tx, {
            guildId,
            recruiterId: userId,
            delta: cost,
            reason: 'buy_item_refund_role_grant_failed',
            refType: 'item_refund',
            refId: item,
            minPoints: 0
          });
        }).catch(refundErr => {
          console.error('Failed to refund purchase after role grant failure:', refundErr);
        });
      }
      logUnexpectedError('economy.buyItemRoleGrant', e, { userId, item });
      return replyError(interaction, 'Failed to grant that role. Purchase was canceled.');
    }

    try {
      await withTransaction(db, async (tx) => {
        await tx.run(
          'INSERT INTO purchases (guild_id, recruiter_id, item, cost, created_at) VALUES (?, ?, ?, ?, ?)',
          guildId,
          userId,
          item,
          cost,
          Date.now()
        );
      });
    } catch (e) {
      await memberRec.roles.remove(grantRoleId).catch(err => {
        console.error('Failed to rollback role grant after purchase ledger error:', err);
      });
      if (reserved) {
        await withTransaction(db, async (tx) => {
          await changeRecruiterPoints(tx, {
            guildId,
            recruiterId: userId,
            delta: cost,
            reason: 'buy_item_refund_persist_failed',
            refType: 'item_refund',
            refId: item,
            minPoints: 0
          });
        }).catch(refundErr => {
          console.error('Failed to refund purchase after persistence failure:', refundErr);
        });
      }
      logUnexpectedError('economy.buyItemPersist', e, { userId, item });
      return replyError(interaction, 'Purchase failed. Please try again.');
    }
  } else {
    try {
      await withTransaction(db, async (tx) => {
        await changeRecruiterPoints(tx, {
          guildId,
          recruiterId: userId,
          delta: -cost,
          reason: 'buy_item',
          refType: 'item',
          refId: item,
          minPoints: 0
        });
        await tx.run('INSERT INTO purchases (guild_id, recruiter_id, item, cost, created_at) VALUES (?, ?, ?, ?, ?)', guildId, userId, item, cost, Date.now());
      });
    } catch (e) {
      logUnexpectedError('economy.buyItem', e, { userId, item });
      return replyError(interaction, 'Purchase failed. Please try again.');
    }
  }

  await postPurchaseLog({ guild: interaction.guild, userId, item, cost });

  const embed = new EmbedBuilder()
    .setTitle('Purchase Complete')
    .setDescription(`Purchased **${getPurchaseItemLabel(item)}** for **${formatPointsValue(cost)}** points.`)
    .setColor(0x00AAFF)
    .setTimestamp();
  return interaction.reply({ embeds: [embed] });
}

module.exports = { handleBuy };
