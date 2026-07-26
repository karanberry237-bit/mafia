const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");
const { EmbedBuilder } = require("discord.js");
const { fmt } = require("./economy");

// ── Audit Log Channel ──────────────────────────────────────────────────────
// Live feed of notable economy events: vault upgrades, big gambling wins,
// heist payouts, turf fights, business raids, bounty collections, big gifts.
// Uses empire_data (already in your schema) to store the per-guild channel id
// under key "auditlog_channel_<guildId>", so no new table is needed.

let supabase;
let discordClient;
function initAuditLog(url, key, clientRef) {
  supabase = createClient(url, key, { realtime: { transport: ws } });
  discordClient = clientRef;
  console.log("📜 Audit log system initialized");
}

// Minimum Cash amount for a gambling win to be worth logging — keeps the feed
// from getting spammed by every small slots/wheel payout.
const MIN_GAMBLE_LOG_AMOUNT = 50000;

function channelKey(guildId) { return "auditlog_channel_" + guildId; }

async function setAuditChannel(guildId, channelId) {
  const { error } = await supabase.from("empire_data").upsert(
    { key: channelKey(guildId), value: { channelId } },
    { onConflict: "key" }
  );
  if (error) { console.error("[AUDIT SET CHANNEL]", error.message); return false; }
  return true;
}

async function getAuditChannel(guildId) {
  const { data, error } = await supabase.from("empire_data").select("value").eq("key", channelKey(guildId)).maybeSingle();
  if (error) { console.error("[AUDIT GET CHANNEL]", error.message); return null; }
  return data?.value?.channelId || null;
}

const EVENT_COLORS = {
  vault_upgrade:   0x2ECC71,
  gamble_win:      0xF1C40F,
  heist_payout:    0x9B59B6,
  turf_fight:      0xE67E22,
  business_raid:   0xE74C3C,
  bounty_collected: 0x1ABC9C,
  big_gift:        0x3498DB,
  gang_event:      0x5865F2,
};

// entry: { type, title, description, guildId }
async function logEvent(entry) {
  if (!discordClient || !entry.guildId) return false;
  const channelId = await getAuditChannel(entry.guildId);
  if (!channelId) return false;

  try {
    const channel = await discordClient.channels.fetch(channelId).catch(() => null);
    if (!channel) return false;
    const embed = new EmbedBuilder()
      .setColor(EVENT_COLORS[entry.type] || 0x5865F2)
      .setTitle(entry.title)
      .setDescription(entry.description)
      .setTimestamp();
    await channel.send({ embeds: [embed] });
    return true;
  } catch (e) {
    console.error("[AUDIT LOG SEND]", e.message);
    return false;
  }
}

// ── Convenience loggers for common event types ────────────────────────────
async function logVaultUpgrade(guildId, userId, tierLabel) {
  return logEvent({ guildId, type: "vault_upgrade", title: "🏦 Vault Upgraded", description: `<@${userId}> upgraded to **${tierLabel}**.` });
}

async function logGambleWin(guildId, userId, game, amount) {
  if (amount < MIN_GAMBLE_LOG_AMOUNT) return false;
  return logEvent({ guildId, type: "gamble_win", title: "🎰 Big Win!", description: `<@${userId}> won **${fmt(amount)} Cash** on **${game}**.` });
}

async function logHeistPayout(guildId, crewMemberIds, totalAmount) {
  return logEvent({ guildId, type: "heist_payout", title: "💰 Heist Successful", description: `Crew of ${crewMemberIds.length} (${crewMemberIds.map(id => `<@${id}>`).join(", ")}) pulled off a heist worth **${fmt(totalAmount)} Cash**.` });
}

async function logTurfFight(guildId, attackerId, defenderId, zoneName, won) {
  const outcome = won ? "captured" : "failed to capture";
  return logEvent({ guildId, type: "turf_fight", title: "🗺️ Turf War", description: `<@${attackerId}> ${outcome} **${zoneName}** ${won ? "from" : "held by"} <@${defenderId}>.` });
}

async function logBusinessRaid(guildId, raiderId, ownerId, businessName, amount, success) {
  const desc = success
    ? `<@${raiderId}> raided <@${ownerId}>'s **${businessName}** and skimmed **${fmt(amount)} Cash**.`
    : `<@${raiderId}> tried to raid <@${ownerId}>'s **${businessName}** and got caught.`;
  return logEvent({ guildId, type: "business_raid", title: "🏢 Business Raid", description: desc });
}

async function logBountyCollected(guildId, collectorId, targetId, amount) {
  return logEvent({ guildId, type: "bounty_collected", title: "🎯 Bounty Collected", description: `<@${collectorId}> collected a **${fmt(amount)} Cash** bounty on <@${targetId}>.` });
}

async function logBigGift(guildId, fromId, toId, amount) {
  return logEvent({ guildId, type: "big_gift", title: "🎁 Big Gift", description: `<@${fromId}> gifted <@${toId}> **${fmt(amount)} Cash**.` });
}

async function logBountyPlaced(guildId, placerId, targetId, poolTotal) {
  return logEvent({ guildId, type: "bounty_collected", title: "🎯 Bounty Placed", description: `<@${placerId}> placed a bounty on <@${targetId}> — pool now **${fmt(poolTotal)} Cash**.` });
}

module.exports = {
  initAuditLog, setAuditChannel, getAuditChannel, logEvent,
  logVaultUpgrade, logGambleWin, logHeistPayout, logTurfFight, logBusinessRaid, logBountyCollected, logBountyPlaced, logBigGift,
  MIN_GAMBLE_LOG_AMOUNT,
};
