// ═══════════════════════════════════════════════════════════════
// ── RAFFLE ────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
// Don-hosted raffle: set ANY prize (free text — Cash, a role, an item, a
// real-world thing, whatever), people enter with a button, a winner gets
// drawn when the timer runs out, and the winner has to hit "Claim" to lock
// it in. If a Cash amount was attached, claiming auto-pays it; otherwise
// claiming just pings the Don to hand the prize over manually.
const eco = require("./economy.js");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

const activeRaffles = new Map(); // messageId -> raffle state

function buildEnterRow(id, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`raffle_enter:${id}`).setLabel("🎟️ Enter Raffle").setStyle(ButtonStyle.Primary).setDisabled(disabled)
  );
}

function buildClaimRow(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`raffle_claim:${id}`).setLabel("🎁 Claim Prize").setStyle(ButtonStyle.Success)
  );
}

async function startRaffle(channel, hostId, prizeText, durationMs, cashAmount = 0) {
  const endsAt = Date.now() + durationMs;
  const msg = await channel.send({
    content:
      `🎟️ **FAMILY RAFFLE** 🎟️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🎁 **Prize:** ${prizeText}${cashAmount > 0 ? ` (**💵 ${eco.fmt(cashAmount)} Cash** auto-paid on claim)` : ""}\n` +
      `⏰ **Drawing:** <t:${Math.floor(endsAt / 1000)}:R>\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `Tap below to enter. One entry per person.\n*Hosted by <@${hostId}>*`,
    components: [buildEnterRow("pending")],
  }).catch(() => null);
  if (!msg) return null;

  const raffle = {
    messageId: msg.id, channelId: channel.id, hostId,
    prizeText, cashAmount, endsAt, entrants: new Set(),
    ended: false, winnerId: null, claimed: false,
  };
  activeRaffles.set(msg.id, raffle);
  await msg.edit({ components: [buildEnterRow(msg.id)] }).catch(() => {});

  setTimeout(() => drawRaffle(msg.id, channel), durationMs);
  return raffle;
}

async function enterRaffle(raffleId, userId) {
  const raffle = activeRaffles.get(raffleId);
  if (!raffle) return { success: false, reason: "🔫 That raffle has ended." };
  if (raffle.ended) return { success: false, reason: "🔫 That raffle has already been drawn." };
  if (raffle.entrants.has(userId)) return { success: false, reason: "🎟️ You're already entered." };
  raffle.entrants.add(userId);
  return { success: true, count: raffle.entrants.size };
}

async function drawRaffle(raffleId, channel) {
  const raffle = activeRaffles.get(raffleId);
  if (!raffle || raffle.ended) return;
  raffle.ended = true;

  const entrants = [...raffle.entrants];
  if (!entrants.length) {
    await channel.send(`🎟️ **RAFFLE ENDED** — nobody entered. Prize (**${raffle.prizeText}**) goes back in the vault.`).catch(() => {});
    activeRaffles.delete(raffleId);
    return;
  }

  const winnerId = entrants[Math.floor(Math.random() * entrants.length)];
  raffle.winnerId = winnerId;

  await channel.send({
    content:
      `🎉 **RAFFLE DRAWN!** 🎉\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🏆 Winner: <@${winnerId}>\n🎁 Prize: **${raffle.prizeText}**${raffle.cashAmount > 0 ? ` (**💵 ${eco.fmt(raffle.cashAmount)} Cash**)` : ""}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n<@${winnerId}> — hit **Claim Prize** below to lock it in.`,
    components: [buildClaimRow(raffleId)],
  }).catch(() => {});
}

async function claimRaffle(raffleId, userId) {
  const raffle = activeRaffles.get(raffleId);
  if (!raffle) return { success: false, reason: "🔫 That raffle no longer exists." };
  if (!raffle.ended || !raffle.winnerId) return { success: false, reason: "🔫 That raffle hasn't been drawn yet." };
  if (userId !== raffle.winnerId) return { success: false, reason: "🔫 This isn't your prize to claim." };
  if (raffle.claimed) return { success: false, reason: "🎁 Already claimed." };

  raffle.claimed = true;
  if (raffle.cashAmount > 0) await eco.addCopper(userId, raffle.cashAmount).catch(() => {});
  activeRaffles.delete(raffleId);
  return { success: true, cashAmount: raffle.cashAmount, prizeText: raffle.prizeText };
}

// Forces the draw early — used by the Don-only "/raffle end" command.
async function endRaffleEarly(raffleId, channel) {
  const raffle = activeRaffles.get(raffleId);
  if (!raffle) return false;
  if (raffle.ended) return false;
  await drawRaffle(raffleId, channel);
  return true;
}

module.exports = {
  startRaffle, enterRaffle, drawRaffle, claimRaffle, endRaffleEarly, activeRaffles,
};
