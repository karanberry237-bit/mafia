const { createClient } = require("@supabase/supabase-js");
const eco = require("./economy.js");
const bank = require("./bank.js");
const ws = require("ws");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

let MASTER_ID;
let client;
let supabase; // initialized in initFeatures after dotenv is loaded

function initFeatures(supabaseClient, ecoModule, masterId, discordClient) {
  // createClient runs here — after dotenv.config() in index.js — so env vars are guaranteed set
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { realtime: { transport: ws } });
  MASTER_ID = masterId;
  client = discordClient;
  console.log("✅ Features system initialized");
}

// ═══════════════════════════════════════════════════════════════
// ── AFK SYSTEM ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const afkUsers = new Map(); // userId -> { reason, since, warnedPingers: Set }

function setAfk(userId, reason = "Away") {
  afkUsers.set(userId, {
    reason,
    since: Date.now(),
    warnedPingers: new Set(),
  });
}

function removeAfk(userId) {
  afkUsers.delete(userId);
}

function getAfk(userId) {
  return afkUsers.get(userId) || null;
}

function isAfk(userId) {
  return afkUsers.has(userId);
}

function getAfkPingerMute() {
  return (60 + Math.floor(Math.random() * 61)) * 1000;
}

function formatAfkTime(ms) {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

// ═══════════════════════════════════════════════════════════════
// ── GIVEAWAY SYSTEM ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const activeGiveaways = new Map();

async function startGiveaway(channel, hostId, prizeCopper, durationMs, winners = 1) {
  const endsAt = Date.now() + durationMs;
  const prize = eco.formatWallet(eco.fromCopper(prizeCopper));
  const msg = await channel.send(
    `🎉 **FAMILY GIVEAWAY** 🎉\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 **Prize:** ${prize}\n` +
    `🏆 **Winners:** ${winners}\n` +
    `⏰ **Ends:** <t:${Math.floor(endsAt / 1000)}:R>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `React with 🎉 to enter!\n` +
    `*Hosted by <@${hostId}>*`
  ).catch(() => null);
  if (!msg) return null;

  await msg.react("🎉").catch(() => {});

  const giveaway = {
    messageId: msg.id,
    channelId: channel.id,
    hostId,
    prizeCopper,
    winners,
    endsAt,
    ended: false,
  };

  activeGiveaways.set(msg.id, giveaway);

  try { await supabase.from("giveaways").upsert({
    message_id: msg.id,
    channel_id: channel.id,
    host_id: hostId,
    prize_copper: prizeCopper,
    winners,
    ends_at: new Date(endsAt).toISOString(),
    ended: false,
  }); } catch (e) { console.error("[GIVEAWAY SAVE]", e.message); }

  setTimeout(() => endGiveaway(msg.id, channel.guild), durationMs);

  return msg;
}

async function endGiveaway(messageId, guild) {
  const giveaway = activeGiveaways.get(messageId);
  if (!giveaway || giveaway.ended) return;
  giveaway.ended = true;
  activeGiveaways.delete(messageId);

  const channel = guild.channels.cache.get(giveaway.channelId);
  if (!channel) return;

  let msg;
  try { msg = await channel.messages.fetch(messageId); } catch { return; }

  const reaction = msg.reactions.cache.get("🎉");
  if (!reaction) {
    await channel.send("🎉 **Giveaway ended** — nobody entered!").catch(() => {});
    return;
  }

  const users = await reaction.users.fetch().catch(() => null);
  if (!users) return;

  const entries = [...users.values()].filter(u => !u.bot && u.id !== giveaway.hostId);
  if (entries.length === 0) {
    await channel.send("🎉 **Giveaway ended** — not enough participants!").catch(() => {});
    return;
  }

  const winnerCount = Math.min(giveaway.winners, entries.length);
  // Fisher-Yates shuffle — unbiased, unlike sort(() => Math.random() - 0.5)
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  const winners = entries.slice(0, winnerCount);
  const perWinner = Math.floor(giveaway.prizeCopper / winnerCount);

  for (const winner of winners) {
    await eco.addCopper(winner.id, perWinner).catch(() => {});
  }

  const winnerMentions = winners.map(w => `<@${w.id}>`).join(", ");
  await channel.send(
    `🎉 **GIVEAWAY ENDED!**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🏆 **Winner(s):** ${winnerMentions}\n` +
    `💰 **Prize:** ${eco.formatWallet(eco.fromCopper(perWinner))} each\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `*Congratulations! The Family takes care of its own.* 🤝`
  ).catch(() => {});

  try { await supabase.from("giveaways").update({ ended: true }).eq("message_id", messageId); } catch (e) { console.error("[GIVEAWAY END]", e.message); }
}

async function rerollGiveaway(messageId, guild) {
  let hostId = null;
  try {
    const { data } = await supabase.from("giveaways").select("host_id").eq("message_id", messageId).single();
    hostId = data?.host_id || null;
  } catch {}

  for (const [, ch] of guild.channels.cache) {
    if (!ch.isTextBased()) continue;
    try {
      const msg = await ch.messages.fetch(messageId);
      const reaction = msg.reactions.cache.get("🎉");
      if (!reaction) return "🔫 No entries found.";
      const users = await reaction.users.fetch();
      const entries = [...users.values()].filter(u => !u.bot && u.id !== hostId);
      if (!entries.length) return "🔫 No entries to reroll from.";
      const winner = entries[Math.floor(Math.random() * entries.length)];
      await ch.send(`🎉 **REROLL!** New winner: <@${winner.id}>! Congratulations! 🏆`).catch(() => {});
      return null;
    } catch { continue; }
  }
  return "🔫 Couldn't find that giveaway message.";
}

async function loadGiveaways(guild) {
  try {
    const { data } = await supabase.from("giveaways").select("*").eq("ended", false);
    if (!data) return;
    const now = Date.now();
    for (const g of data) {
      const endsAt = new Date(g.ends_at).getTime();
      const remaining = endsAt - now;
      if (remaining <= 0) {
        await endGiveaway(g.message_id, guild);
      } else {
        activeGiveaways.set(g.message_id, {
          messageId: g.message_id,
          channelId: g.channel_id,
          hostId: g.host_id,
          prizeCopper: g.prize_copper,
          winners: g.winners,
          endsAt,
          ended: false,
        });
        setTimeout(() => endGiveaway(g.message_id, guild), remaining);
      }
    }
    console.log(`[GIVEAWAYS] Loaded ${data.length} active giveaway(s)`);
  } catch (e) { console.error("[LOAD GIVEAWAYS]", e.message); }
}

// ═══════════════════════════════════════════════════════════════
// ── TRIVIA TOURNAMENT ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const TRIVIA_QUESTIONS = [
  { q: "What is the capital of France?", a: "paris", choices: ["London", "Paris", "Berlin", "Madrid"] },
  { q: "How many sides does a hexagon have?", a: "6", choices: ["5", "6", "7", "8"] },
  { q: "What planet is closest to the Sun?", a: "mercury", choices: ["Venus", "Earth", "Mercury", "Mars"] },
  { q: "Who painted the Mona Lisa?", a: "da vinci", choices: ["Picasso", "Da Vinci", "Rembrandt", "Michelangelo"] },
  { q: "What is the chemical symbol for gold?", a: "au", choices: ["Go", "Gd", "Au", "Ag"] },
  { q: "How many bones are in the human body?", a: "206", choices: ["196", "206", "216", "226"] },
  { q: "What is the largest ocean?", a: "pacific", choices: ["Atlantic", "Indian", "Pacific", "Arctic"] },
  { q: "What year did World War II end?", a: "1945", choices: ["1943", "1944", "1945", "1946"] },
  { q: "What is the fastest land animal?", a: "cheetah", choices: ["Lion", "Cheetah", "Leopard", "Tiger"] },
  { q: "How many planets are in our solar system?", a: "8", choices: ["7", "8", "9", "10"] },
  { q: "What is the square root of 144?", a: "12", choices: ["10", "11", "12", "13"] },
  { q: "What language has the most native speakers?", a: "mandarin", choices: ["English", "Spanish", "Mandarin", "Hindi"] },
  { q: "What is the smallest country in the world?", a: "vatican city", choices: ["Monaco", "Vatican City", "San Marino", "Liechtenstein"] },
  { q: "What is H2O commonly known as?", a: "water", choices: ["Oxygen", "Hydrogen", "Water", "Salt"] },
  { q: "Who wrote Romeo and Juliet?", a: "shakespeare", choices: ["Dickens", "Shakespeare", "Hemingway", "Austen"] },
  { q: "How many continents are there?", a: "7", choices: ["5", "6", "7", "8"] },
  { q: "What is the currency of Japan?", a: "yen", choices: ["Won", "Yuan", "Yen", "Ringgit"] },
  { q: "What is the longest river in the world?", a: "nile", choices: ["Amazon", "Nile", "Yangtze", "Mississippi"] },
  { q: "What gas do plants absorb from the atmosphere?", a: "carbon dioxide", choices: ["Oxygen", "Carbon Dioxide", "Nitrogen", "Helium"] },
  { q: "What is the hardest natural substance on Earth?", a: "diamond", choices: ["Gold", "Iron", "Diamond", "Quartz"] },
  { q: "What is the largest planet in our solar system?", a: "jupiter", choices: ["Saturn", "Jupiter", "Neptune", "Uranus"] },
  { q: "How many strings does a standard guitar have?", a: "6", choices: ["4", "5", "6", "7"] },
  { q: "What is the capital of Japan?", a: "tokyo", choices: ["Osaka", "Kyoto", "Tokyo", "Hiroshima"] },
  { q: "Who invented the telephone?", a: "bell", choices: ["Edison", "Tesla", "Bell", "Marconi"] },
  { q: "What is the speed of light?", a: "299792458", choices: ["199792458", "299792458", "399792458", "499792458"] },
  { q: "What element does 'O' represent on the periodic table?", a: "oxygen", choices: ["Osmium", "Oxygen", "Gold", "Oganesson"] },
  { q: "How many hours are in a week?", a: "168", choices: ["148", "158", "168", "178"] },
  { q: "What country has the most natural lakes?", a: "canada", choices: ["Russia", "USA", "Canada", "Brazil"] },
  { q: "What is the powerhouse of the cell?", a: "mitochondria", choices: ["Nucleus", "Ribosome", "Mitochondria", "Golgi"] },
  { q: "Who was the first man on the moon?", a: "armstrong", choices: ["Aldrin", "Armstrong", "Glenn", "Shepard"] },
];

const activeTournaments = new Map();

async function startTriviaRound(channelId, guild, tournament) {
  if (tournament.currentRound > tournament.totalRounds) {
    await endTriviaTournament(channelId, guild, tournament);
    return;
  }

  const channel = guild.channels.cache.get(channelId);
  if (!channel) return;

  // Pick a question not used yet this tournament
  const unused = TRIVIA_QUESTIONS.filter((_, i) => !tournament.usedQuestions?.has(i));
  const pool = unused.length > 0 ? unused : TRIVIA_QUESTIONS;
  const idx = Math.floor(Math.random() * pool.length);
  const q = pool[idx];
  if (!tournament.usedQuestions) tournament.usedQuestions = new Set();
  tournament.usedQuestions.add(TRIVIA_QUESTIONS.indexOf(q));

  tournament.currentQuestion = q;
  tournament.answered = new Set();
  tournament.roundStarted = Date.now();

  const optionsText = q.choices.map((c, i) => `${["🇦","🇧","🇨","🇩"][i]} ${c}`).join("\n");

  await channel.send(
    `🧠 **TRIVIA TOURNAMENT — Round ${tournament.currentRound}/${tournament.totalRounds}**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `**${q.q}**\n\n` +
    `${optionsText}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `*Type your answer! You have **20 seconds**. First correct answer gets bonus points!*`
  ).catch(() => {});

  tournament.roundTimeout = setTimeout(async () => {
    const t = activeTournaments.get(channelId);
    if (!t || t.roundStarted !== tournament.roundStarted) return;
    const correctDisplay = q.choices.find(c => c.toLowerCase() === q.a) || q.a;
    await channel.send(
      `⏰ **Time's up!** The answer was **${correctDisplay}**.\n\n` +
      `📊 *Scores: ${getScoreBoard(t)}*`
    ).catch(() => {});
    t.currentRound++;
    setTimeout(() => startTriviaRound(channelId, guild, t), 4000);
  }, 20000);
}

function getScoreBoard(tournament) {
  return Object.entries(tournament.scores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, score], i) => `${["🥇","🥈","🥉","4.","5."][i]} <@${id}> **${score}pts**`)
    .join(" | ") || "No scores yet";
}

async function endTriviaTournament(channelId, guild, tournament) {
  activeTournaments.delete(channelId);
  const channel = guild.channels.cache.get(channelId);
  if (!channel) return;

  const sorted = Object.entries(tournament.scores).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) {
    await channel.send("🧠 **Tournament ended** — nobody scored!").catch(() => {});
    return;
  }

  const [winnerId, winnerScore] = sorted[0];
  const prize = tournament.prizeCopper;
  await eco.addCopper(winnerId, prize).catch(() => {});

  // Runner up prizes (2nd gets 30%, 3rd gets 10%)
  if (sorted[1]) await eco.addCopper(sorted[1][0], Math.floor(prize * 0.3)).catch(() => {});
  if (sorted[2]) await eco.addCopper(sorted[2][0], Math.floor(prize * 0.1)).catch(() => {});

  const podium = sorted.slice(0, 3).map(([id, score], i) =>
    `${["🥇","🥈","🥉"][i]} <@${id}> — **${score} pts**`
  ).join("\n");

  await channel.send(
    `🏆 **TRIVIA TOURNAMENT — FINAL RESULTS** 🏆\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${podium}\n\n` +
    `💰 **Prize Pool Distribution:**\n` +
    `🥇 1st: ${eco.formatWallet(eco.fromCopper(prize))} → <@${winnerId}>\n` +
    (sorted[1] ? `🥈 2nd: ${eco.formatWallet(eco.fromCopper(Math.floor(prize * 0.3)))} → <@${sorted[1][0]}>\n` : "") +
    (sorted[2] ? `🥉 3rd: ${eco.formatWallet(eco.fromCopper(Math.floor(prize * 0.1)))} → <@${sorted[2][0]}>\n` : "") +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `*The Family salutes its champion. 🔫*`
  ).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════
// ── LIVE VAULT HEIST ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
// Replaces the old text-join heist. Two live moments instead of one static
// window: (1) a 60s join phase with a real button and a countdown message
// that live-edits every 10s, and (2) after the crew assembles, an 8-second
// "grab the cash" button window — everyone in the crew has to actually be
// there and click in time to be counted in the payout. Miss the click,
// you're still on the hook for your entry fee but get nothing back either
// way. This is what makes it "live" instead of "set it and forget it."
const activeHeists = new Map(); // channelId -> heist state
const JOIN_WINDOW_MS = 60000;
const GRAB_WINDOW_MS = 8000;
const MAX_CREW = 10;

function heistJoinRow(channelId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`heist_join:${channelId}`).setLabel("🦹 Join Heist").setStyle(ButtonStyle.Primary).setDisabled(disabled)
  );
}

function heistGrabRow(channelId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`heist_grab:${channelId}`).setLabel("💰 GRAB IT").setStyle(ButtonStyle.Success).setDisabled(disabled)
  );
}

function buildHeistJoinText(heist) {
  const secondsLeft = Math.max(0, Math.ceil((heist.joinDeadline - Date.now()) / 1000));
  const crewMentions = [...heist.participants.keys()].map(id => `<@${id}>`).join(", ");
  return (
    `🦹 **LIVE VAULT HEIST FORMING** 🦹\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🏦 **Target vault:** ${eco.formatWallet(eco.fromCopper(heist.vaultCopper))}\n` +
    `💸 **Entry fee:** ${eco.formatWallet(eco.fromCopper(heist.entryFee))}\n` +
    `👥 **Crew (${heist.participants.size}/${MAX_CREW}):** ${crewMentions}\n\n` +
    `Click **🦹 Join Heist** below to jump in!\n` +
    `**Launching in ${secondsLeft}s...**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `*More members = higher success chance. When it launches, you'll need to click again FAST to actually grab your cut — miss it, get nothing.*`
  );
}

async function startHeist(channel, initiatorId, vaultCopper) {
  if (activeHeists.has(channel.id)) return "🔫 A heist is already being planned in this channel.";

  const entryFee = Math.max(100, Math.floor(vaultCopper * 0.05));
  const deducted = await eco.deductCopper(initiatorId, entryFee).catch(() => null);
  if (!deducted) return `🔫 You need **${eco.formatWallet(eco.fromCopper(entryFee))}** entry fee to start the heist.`;

  const heist = {
    channelId: channel.id,
    vaultCopper,
    entryFee,
    participants: new Map([[initiatorId, true]]),
    startedAt: Date.now(),
    joinDeadline: Date.now() + JOIN_WINDOW_MS,
    launched: false,
    messageId: null,
    grabbers: null,
    grabDeadline: null,
  };
  activeHeists.set(channel.id, heist);

  const msg = await channel.send({ content: buildHeistJoinText(heist), components: [heistJoinRow(channel.id)] }).catch(() => null);
  if (msg) heist.messageId = msg.id;

  const tickInterval = setInterval(async () => {
    const h = activeHeists.get(channel.id);
    if (!h || h.launched) { clearInterval(tickInterval); return; }
    if (!h.messageId) return;
    const message = await channel.messages.fetch(h.messageId).catch(() => null);
    if (message) await message.edit({ content: buildHeistJoinText(h), components: [heistJoinRow(channel.id)] }).catch(() => {});
  }, 10000);

  setTimeout(() => executeHeist(channel.id, channel.guild).catch(e => console.error("[HEIST EXECUTE]", e.message)), JOIN_WINDOW_MS);
  return null;
}

// Called from the heist_join button interaction.
async function joinHeistButton(channelId, userId) {
  const heist = activeHeists.get(channelId);
  if (!heist) return { success: false, reason: "No heist forming here anymore." };
  if (heist.launched) return { success: false, reason: "The heist already launched — too late." };
  if (heist.participants.has(userId)) return { success: false, reason: "You're already in the crew." };
  if (heist.participants.size >= MAX_CREW) return { success: false, reason: `Crew is full (${MAX_CREW} max).` };

  const deducted = await eco.deductCopper(userId, heist.entryFee).catch(() => null);
  if (!deducted) return { success: false, reason: `You need ${eco.formatWallet(eco.fromCopper(heist.entryFee))} to join.` };

  heist.participants.set(userId, true);
  return { success: true, heist };
}

// Called from the heist_grab button interaction, during the live grab window.
async function grabHeistCash(channelId, userId) {
  const heist = activeHeists.get(channelId);
  if (!heist || !heist.launched || !heist.grabDeadline) return { success: false, reason: "No grab window active right now." };
  if (Date.now() > heist.grabDeadline) return { success: false, reason: "Too slow — the window already closed." };
  if (!heist.participants.has(userId)) return { success: false, reason: "You're not part of this heist's crew." };
  if (heist.grabbers.has(userId)) return { success: false, reason: "You already grabbed it." };
  heist.grabbers.add(userId);
  return { success: true, grabbedCount: heist.grabbers.size };
}

async function executeHeist(channelId, guild) {
  const heist = activeHeists.get(channelId);
  if (!heist || heist.launched) return;
  heist.launched = true;

  const channel = guild.channels.cache.get(channelId);
  if (!channel) { activeHeists.delete(channelId); return; }

  const crewIds = [...heist.participants.keys()];
  const totalPot = heist.entryFee * crewIds.length;

  await channel.send(`🚨 **BREACHING THE VAULT** 🚨\n*${crewIds.length} crew member(s) assembled. Get ready...*`).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  // ── The live moment — everyone has to actually click to grab their cut ──
  heist.grabbers = new Set();
  heist.grabDeadline = Date.now() + GRAB_WINDOW_MS;
  const crewMentions = crewIds.map(id => `<@${id}>`).join(", ");
  const grabMsg = await channel.send({
    content: `💰 **GRAB THE CASH — ${Math.round(GRAB_WINDOW_MS / 1000)} SECONDS!** 💰\n${crewMentions}\nClick below NOW or you get nothing, no matter how this goes.`,
    components: [heistGrabRow(channelId)],
  }).catch(() => null);

  await new Promise(r => setTimeout(r, GRAB_WINDOW_MS));
  if (grabMsg) await grabMsg.edit({ components: [heistGrabRow(channelId, true)] }).catch(() => {});

  const grabbedIds = [...heist.grabbers].filter(id => heist.participants.has(id));
  activeHeists.delete(channelId);

  if (grabbedIds.length === 0) {
    await eco.addCopper(MASTER_ID, totalPot).catch(() => {});
    await channel.send(`😬 **Nobody grabbed the cash in time.** The whole crew's entry fees are gone — the vault stays locked.`).catch(() => {});
    return;
  }

  const successChance = Math.min(0.80, 0.20 + (grabbedIds.length - 1) * 0.10);
  const roll = Math.random();
  const grabbedMentions = grabbedIds.map(id => `<@${id}>`).join(", ");
  const missedCount = crewIds.length - grabbedIds.length;
  const missedLine = missedCount > 0 ? `😬 *${missedCount} crew member(s) were too slow and get nothing.*\n` : "";

  if (roll < successChance) {
    const totalPrize = heist.vaultCopper + totalPot;
    const perPerson = Math.floor(totalPrize / grabbedIds.length);
    for (const uid of grabbedIds) await eco.addCopper(uid, perPerson).catch(() => {});
    await eco.deductCopper(MASTER_ID, heist.vaultCopper).catch(() => {});
    await channel.send(
      `💰 **HEIST SUCCESSFUL!** 💰\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🦹 **Grabbed in time:** ${grabbedMentions}\n${missedLine}` +
      `🏦 **Vault cracked:** ${eco.formatWallet(eco.fromCopper(heist.vaultCopper))}\n` +
      `💸 **Each grabber gets:** ${eco.formatWallet(eco.fromCopper(perPerson))}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `*The Family's vault has been hit. Don Clint is NOT pleased. 😤*`
    ).catch(() => {});
  } else {
    await eco.addCopper(MASTER_ID, totalPot).catch(() => {});
    await channel.send(
      `🚨 **HEIST FAILED!** 🚨\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🦹 **In the vault:** ${grabbedMentions}\n${missedLine}` +
      `💀 **Guards caught you all!**\n` +
      `💸 **Every crew member's entry fee seized:** ${eco.formatWallet(eco.fromCopper(totalPot))} → the Vig\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `*${Math.round(successChance * 100)}% chance and you still blew it. Disgraceful.*`
    ).catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════════
// ── STOCK MARKET — REAL DATA ────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

const STOCKS = {
  IRON: {
    name: "🏗️ Concrete & Construction",
    basePrice: 100,
    volatility: 0.08,
    realTicker: "X",         // US Steel
    cryptoId: null,
    desc: "Tracks real steel/commodities market",
  },
  GOLD: {
    name: "🥇 Gold Trade",
    basePrice: 500,
    volatility: 0.10,
    realTicker: "GLD",       // Gold ETF
    cryptoId: null,
    desc: "Tracks real gold price",
  },
  ARMS: {
    name: "🔫 The Armory",
    basePrice: 250,
    volatility: 0.12,
    realTicker: "LMT",       // Lockheed Martin
    cryptoId: null,
    desc: "Tracks defense sector",
  },
  SILK: {
    name: "🧵 Import/Export Co.",
    basePrice: 150,
    volatility: 0.07,
    realTicker: "NKE",       // Nike / luxury consumer
    cryptoId: null,
    desc: "Tracks luxury & consumer goods",
  },
  DARK: {
    name: "🌑 The Underground",
    basePrice: 1000,
    volatility: 0.22,
    realTicker: null,
    cryptoId: "bitcoin",     // BTC
    desc: "Tracks Bitcoin — never sleeps",
  },
  RUNE: {
    name: "🎰 The Backroom Exchange",
    basePrice: 750,
    volatility: 0.18,
    realTicker: null,
    cryptoId: "ethereum",    // ETH
    desc: "Tracks Ethereum — never sleeps",
  },
  // ── Penny Stocks ──────────────────────────────────────────
  COAL: {
    name: "⛏️ Coal Racket",
    basePrice: 50,        // 50 Cash per share
    volatility: 0.28,
    realTicker: "BTU",
    cryptoId: null,
    desc: "⚠️ Penny stock — high risk, high reward",
    penny: true,
  },
  GRAIN: {
    name: "🌾 Grain Front",
    basePrice: 80,        // 80 Cash per share
    volatility: 0.24,
    realTicker: "WEAT",
    cryptoId: null,
    desc: "⚠️ Penny stock — high risk, high reward",
    penny: true,
  },
  WOOD: {
    name: "🪵 Timber Racket",
    basePrice: 120,       // 120 Cash per share
    volatility: 0.26,
    realTicker: "WY",
    cryptoId: null,
    desc: "⚠️ Penny stock — high risk, high reward",
    penny: true,
  },
};

let stockPrices = {};
let stockCandles = {};   // { [ticker]: { o, h, l, c, label }[] }  — OHLC per 30-min tick
let stockPortfolios = new Map();
let stockMarketOpen = true;
let donManipulation = null;

// Server-wide Don's Call cooldown
let donsCallLastUsed = 0;
const DONS_CALL_COOLDOWN = 24 * 60 * 60 * 1000;

// Market pressure from large buys/sells
const marketPressure = {};

// Track average buy price per user per ticker for P&L
const avgBuyPrice = new Map(); // `${userId}-${ticker}` -> avg copper per share

function initStockPrices() {
  for (const [ticker, stock] of Object.entries(STOCKS)) {
    // Penny stocks: basePrice IS the copper price directly
    // Regular stocks: basePrice × 100 (e.g. GOLD base 500 = 50,000 copper = 5 Gold)
    stockPrices[ticker] = stock.penny ? stock.basePrice : stock.basePrice * 100;
    stockCandles[ticker] = [];
  }
}

function fixPennyStockPrices() {
  for (const [ticker, stock] of Object.entries(STOCKS)) {
    if (stock.penny && (!stockPrices[ticker] || stockPrices[ticker] > stock.basePrice * 50)) {
      // Price is way too high — was multiplied by 100 incorrectly, reset
      stockPrices[ticker] = stock.basePrice;
      stockCandles[ticker] = [];
      console.log(`[STOCKS] Reset ${ticker} to ${stock.basePrice} copper`);
    }
  }
}

// ── Real market data fetchers ─────────────────────────────────

function isMarketHours() {
  const now = new Date();
  // Convert to EST
  const est = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = est.getDay(); // 0=Sun, 6=Sat
  const hour = est.getHours();
  const minute = est.getMinutes();
  const timeVal = hour * 60 + minute;
  if (day === 0 || day === 6) return false;
  return timeVal >= 9 * 60 + 30 && timeVal < 16 * 60;
}

async function fetchStockChange(ticker) {
  try {
    const key = process.env.ALPHA_VANTAGE_KEY;
    if (!key) return null;
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${key}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    const quote = data["Global Quote"];
    if (!quote || !quote["10. change percent"]) return null;
    const pct = parseFloat(quote["10. change percent"].replace("%", ""));
    if (isNaN(pct)) return null;
    console.log(`[STOCKS] ${ticker} real change: ${pct.toFixed(2)}%`);
    return pct / 100;
  } catch (e) {
    console.error(`[STOCKS] Alpha Vantage fetch failed for ${ticker}:`, e.message);
    return null;
  }
}

async function fetchCryptoChange(coinId) {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    const pct = data[coinId]?.usd_24h_change;
    if (pct === undefined || pct === null) return null;
    // Scale 24h change to 30min equivalent (roughly 1/48th)
    const scaled = (pct / 100) / 48;
    console.log(`[STOCKS] ${coinId} 24h: ${pct.toFixed(2)}% → 30min scaled: ${(scaled * 100).toFixed(3)}%`);
    return scaled;
  } catch (e) {
    console.error(`[STOCKS] CoinGecko fetch failed for ${coinId}:`, e.message);
    return null;
  }
}

// Alpha Vantage free tier: 25 calls/day = ~1 call per stock per market session
// We cache last fetched change and reuse it with noise for intermediate ticks
const cachedRealChanges = {};
let lastAlphaFetch = 0;
const ALPHA_FETCH_INTERVAL = 4 * 60 * 60 * 1000; // fetch real data every 4h max

async function tickStockMarket() {
  const marketOpen = isMarketHours();

  const tickTime = new Date();
  const timeLabel = tickTime.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" });

  for (const [ticker, stock] of Object.entries(STOCKS)) {
    const isTraditional = !stock.cryptoId;
    const open = stockPrices[ticker];

    // 1-min candle: scale volatility down (30min vol / sqrt(30))
    const minVol = stock.volatility / Math.sqrt(30);

    // Base drift from cached real data scaled to 1 min
    let realInfluence = (cachedRealChanges[ticker] || 0) / 30;

    // Outside market hours tiny drift for traditional stocks
    if (isTraditional && !marketOpen) {
      realInfluence = (Math.random() - 0.5) * 0.001;
    }

    const noise = (Math.random() - 0.5) * 2 * minVol;
    let change = realInfluence + noise;

    // Don manipulation
    if (donManipulation && donManipulation.ticker === ticker && donManipulation.rounds > 0) {
      change += donManipulation.direction * 0.15;
      donManipulation.rounds--;
      if (donManipulation.rounds === 0) donManipulation = null;
    }

    // Community market pressure — spikes next candle then decays
    if (marketPressure[ticker]) {
      change += marketPressure[ticker];
      marketPressure[ticker] = marketPressure[ticker] * 0.3;
      if (Math.abs(marketPressure[ticker]) < 0.001) marketPressure[ticker] = 0;
    }

    // Mean reversion very gentle at 1-min scale
    const base = stock.basePrice * 100;
    const drift = (base - stockPrices[ticker]) / base * 0.001;
    change += drift;

    // Intra-candle high/low
    const wickSize = Math.abs(change) * 0.5 + minVol * Math.random();
    const close = Math.max(1, Math.round(open * (1 + change)));
    const high  = Math.max(open, close) + Math.round(open * wickSize * 0.5);
    const low   = Math.max(1, Math.min(open, close) - Math.round(open * wickSize * 0.5));

    stockPrices[ticker] = close;

    if (!stockCandles[ticker]) stockCandles[ticker] = [];
    stockCandles[ticker].push({ o: open, h: high, l: low, c: close, label: timeLabel });
    if (stockCandles[ticker].length > 60) stockCandles[ticker].shift();
  }
}


async function buyStock(userId, ticker, shares) {
  ticker = ticker.toUpperCase();
  if (!STOCKS[ticker]) return `🔫 Unknown stock. Valid: ${Object.keys(STOCKS).join(", ")}`;
  if (!stockMarketOpen) return "🔫 The market is closed. Don's orders.";
  if (shares < 1) return "🔫 Buy at least 1 share.";

  const price = stockPrices[ticker];
  const total = price * shares;

  const deducted = await eco.deductCopper(userId, total).catch(() => null);
  if (!deducted) return `🔫 You need **${eco.formatWallet(eco.fromCopper(total))}** to buy ${shares} shares of ${ticker}.`;

  if (!stockPortfolios.has(userId)) {
    // Try loading from Supabase first before assuming empty
    try {
      const { data } = await supabase.from("stock_portfolios").select("portfolio").eq("user_id", userId).single();
      if (data?.portfolio) { stockPortfolios.set(userId, JSON.parse(data.portfolio)); if (data.avg_prices) { const ap = JSON.parse(data.avg_prices); for (const [t,p] of Object.entries(ap)) avgBuyPrice.set(`${userId}-${t}`, p); } }
      else stockPortfolios.set(userId, {});
    } catch { stockPortfolios.set(userId, {}); }
  }
  const portfolio = stockPortfolios.get(userId);

  // Track average buy price
  const key = `${userId}-${ticker}`;
  const prevShares = portfolio[ticker] || 0;
  const prevAvg = avgBuyPrice.get(key) || price;
  const newAvg = prevShares === 0 ? price : Math.round((prevAvg * prevShares + price * shares) / (prevShares + shares));
  avgBuyPrice.set(key, newAvg);

  portfolio[ticker] = prevShares + shares;
  await savePortfolio(userId, portfolio);

  // Market pressure — based on share count, not copper value
  // 500 shares = ~1% pressure, 5000 shares = ~10%, max 15%
  const pressureStrength = Math.min(0.15, shares / 50000);
  if (pressureStrength > 0.01) {
    if (!marketPressure[ticker]) marketPressure[ticker] = 0;
    marketPressure[ticker] += pressureStrength;
  }

  await logStockTransaction(userId, ticker, "buy", shares, price, total, null);

  const pressureLine = pressureStrength > 0.01
    ? `\n📢 *Large order detected — **${ticker}** will spike on the next candle! 📈*`
    : "";

  return (
    `📈 **BOUGHT ${shares}x ${STOCKS[ticker].name} (${ticker})**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 Price per share: **${eco.formatWallet(eco.fromCopper(price))}**\n` +
    `💸 Total spent: **${eco.formatWallet(eco.fromCopper(total))}**\n` +
    `📊 Your holdings: **${portfolio[ticker]} shares**\n` +
    `📉 Avg buy price: **${eco.formatWallet(eco.fromCopper(newAvg))}**` +
    pressureLine
  );
}

async function sellStock(userId, ticker, shares) {
  ticker = ticker.toUpperCase();
  if (!STOCKS[ticker]) return `🔫 Unknown stock. Valid: ${Object.keys(STOCKS).join(", ")}`;
  if (!stockMarketOpen) return "🔫 The market is closed. Don's orders.";

  if (!stockPortfolios.has(userId)) {
    try {
      const { data } = await supabase.from("stock_portfolios").select("portfolio").eq("user_id", userId).single();
      if (data?.portfolio) { stockPortfolios.set(userId, JSON.parse(data.portfolio)); if (data.avg_prices) { const ap = JSON.parse(data.avg_prices); for (const [t,p] of Object.entries(ap)) avgBuyPrice.set(`${userId}-${t}`, p); } }
      else stockPortfolios.set(userId, {});
    } catch { stockPortfolios.set(userId, {}); }
  }
  const portfolio = stockPortfolios.get(userId) || {};
  const held = portfolio[ticker] || 0;
  if (held < shares) return `🔫 You only have **${held} shares** of ${ticker}.`;

  const price = stockPrices[ticker];
  const total = price * shares;

  // Calculate profit/loss
  const key = `${userId}-${ticker}`;
  const avgPrice = avgBuyPrice.get(key) || price;
  const profitLoss = (price - avgPrice) * shares;
  const plText = profitLoss >= 0
    ? `✅ **+${eco.formatWallet(eco.fromCopper(Math.abs(Math.round(profitLoss))))} profit**`
    : `❌ **-${eco.formatWallet(eco.fromCopper(Math.abs(Math.round(profitLoss))))} loss**`;

  portfolio[ticker] -= shares;
  if (portfolio[ticker] === 0) {
    delete portfolio[ticker];
    avgBuyPrice.delete(key);
  }
  stockPortfolios.set(userId, portfolio);

  await eco.addCopper(userId, total).catch(() => {});
  await savePortfolio(userId, portfolio);
  await logStockTransaction(userId, ticker, "sell", shares, price, total, Math.round(profitLoss));

  // Market pressure — based on share count
  const pressureStrength = Math.min(0.15, shares / 50000);
  if (pressureStrength > 0.01) {
    if (!marketPressure[ticker]) marketPressure[ticker] = 0;
    marketPressure[ticker] -= pressureStrength;
  }

  const pressureLine = pressureStrength > 0.01
    ? `\n📢 *Large sell detected — **${ticker}** will drop on the next candle! 📉*`
    : "";

  return (
    `📉 **SOLD ${shares}x ${STOCKS[ticker].name} (${ticker})**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 Price per share: **${eco.formatWallet(eco.fromCopper(price))}**\n` +
    `💵 Total received: **${eco.formatWallet(eco.fromCopper(total))}**\n` +
    `${plText}\n` +
    `📊 Remaining: **${portfolio[ticker] || 0} shares**` +
    pressureLine
  );
}

function getMarketBoardData() {
  const marketOpen = isMarketHours();
  const candleData = {};
  const stockInfo  = {};

  for (const [ticker, stock] of Object.entries(STOCKS)) {
    const candles = stockCandles[ticker] || [];
    const price   = stockPrices[ticker] || stock.basePrice * 100;

    // Use first candle open vs current close for accurate % change
    const visibleCandles = candles.slice(-20);
    const firstOpen = visibleCandles.length > 0 ? visibleCandles[0].o : price;
    const changePct = firstOpen > 0 ? ((price - firstOpen) / firstOpen * 100) : 0;

    candleData[ticker] = candles;
    stockInfo[ticker]  = {
      name: stock.name,
      currentPrice: price,
      changePercent: parseFloat(changePct.toFixed(2)),
      marketOpen,
      isCrypto: !!stock.cryptoId,
      isPenny: !!stock.penny,
    };
  }

  return { candleData, stockInfo, marketOpen };
}

// Text fallback (used in help displays)
function getMarketBoard() {
  const marketOpen = isMarketHours();
  const lines = [
    `📊 **FAMILY STOCK MARKET** ${stockMarketOpen ? (marketOpen ? "🟢 LIVE" : "🌙 AFTER HOURS") : "🔴 CLOSED"}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  ];
  for (const [ticker, stock] of Object.entries(STOCKS)) {
    const candles = stockCandles[ticker] || [];
    const price   = stockPrices[ticker];
    const prev    = candles.length >= 2 ? candles[candles.length - 2].c : price;
    const changePct = prev ? ((price - prev) / prev * 100).toFixed(1) : "0.0";
    const arrow   = parseFloat(changePct) > 0 ? "📈" : parseFloat(changePct) < 0 ? "📉" : "➡️";
    lines.push(`${arrow} **${ticker}** — ${stock.name} | ${eco.formatWallet(eco.fromCopper(price))} | ${parseFloat(changePct) >= 0 ? "+" : ""}${changePct}%`);
  }
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*Cosa stocks — view chart image*`);
  return lines.join("\n");
}

async function getPortfolio(userId) {
  if (!stockPortfolios.has(userId)) {
    try {
      const { data } = await supabase.from("stock_portfolios").select("portfolio").eq("user_id", userId).single();
      if (data?.portfolio) { stockPortfolios.set(userId, JSON.parse(data.portfolio)); if (data.avg_prices) { const ap = JSON.parse(data.avg_prices); for (const [t,p] of Object.entries(ap)) avgBuyPrice.set(`${userId}-${t}`, p); } }
      else stockPortfolios.set(userId, {});
    } catch { stockPortfolios.set(userId, {}); }
  }
  const portfolio = stockPortfolios.get(userId) || {};
  const entries = Object.entries(portfolio).filter(([, s]) => s > 0);
  if (!entries.length) return "📊 You have no stocks. Buy with **Cosa stock buy [TICKER] [shares]**.";

  // Flat currency: everything is Cash now.
  function fmt(copper) {
    return `💵 ${eco.fmt(Math.abs(Math.round(copper)))} Cash`;
  }

  let totalValue = 0;
  let totalCost = 0;
  const lines = [`📊 **YOUR PORTFOLIO**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`];

  for (const [ticker, shares] of entries) {
    const price = stockPrices[ticker] || 0;
    const value = price * shares;
    const avgP = avgBuyPrice.get(`${userId}-${ticker}`) || price;
    const cost = avgP * shares;
    const pl = value - cost;
    const plSign = pl >= 0 ? `✅ +${fmt(pl)}` : `❌ -${fmt(pl)}`;
    const pct = cost > 0 ? ((pl / cost) * 100).toFixed(1) : "0.0";
    totalValue += value;
    totalCost += cost;
    lines.push(
      `**${ticker}** — ${STOCKS[ticker]?.name || ticker}\n` +
      `  ${shares.toLocaleString()} shares | Avg: ${fmt(avgP)} | Now: ${fmt(price)}\n` +
      `  Value: **${fmt(value)}** | P&L: ${plSign} (${parseFloat(pct) >= 0 ? "+" : ""}${pct}%)`
    );
  }

  const totalPL = totalValue - totalCost;
  const totalPct = totalCost > 0 ? ((totalPL / totalCost) * 100).toFixed(1) : "0.0";
  lines.push(
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `💼 **Total:** ${fmt(totalValue)} | P&L: ${totalPL >= 0 ? `✅ +${fmt(totalPL)}` : `❌ -${fmt(totalPL)}`} (${parseFloat(totalPct) >= 0 ? "+" : ""}${totalPct}%)`
  );
  return lines.join("\n");
}

async function getStockHistory(userId) {
  try {
    const { data } = await supabase
      .from("stock_transactions")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(10);
    if (!data || !data.length) return "📊 No trade history yet. Start trading with **Cosa stock buy [TICKER] [shares]**.";
    const lines = [`📊 **YOUR TRADE HISTORY** (last 10)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`];
    for (const tx of data) {
      const isBuy = tx.action === "buy";
      const plStr = tx.profit_loss !== null && tx.profit_loss !== undefined
        ? ` | ${tx.profit_loss >= 0 ? `✅ +${eco.formatWallet(eco.fromCopper(Math.abs(tx.profit_loss)))}` : `❌ -${eco.formatWallet(eco.fromCopper(Math.abs(tx.profit_loss)))}`}`
        : "";
      const date = new Date(tx.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
      lines.push(
        `${isBuy ? "📈 BUY " : "📉 SELL"} **${tx.ticker}** x${tx.shares} @ ${eco.formatWallet(eco.fromCopper(tx.price_per_share))} | Total: ${eco.formatWallet(eco.fromCopper(tx.total_copper))}${plStr} *(${date})*`
      );
    }
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    return lines.join("\n");
  } catch (e) {
    console.error("[STOCK HISTORY]", e.message);
    return "🔫 Couldn't load trade history.";
  }
}

async function logStockTransaction(userId, ticker, action, shares, pricePerShare, totalCopper, profitLoss) {
  try {
    await supabase.from("stock_transactions").insert({
      user_id: userId,
      ticker,
      action,
      shares,
      price_per_share: pricePerShare,
      total_copper: totalCopper,
      profit_loss: profitLoss,
    });
  } catch (e) { console.error("[LOG TX]", e.message); }
}

async function savePortfolio(userId, portfolio) {
  try {
    // Save portfolio + avgBuyPrice together
    const avgPrices = {};
    for (const [key, val] of avgBuyPrice.entries()) {
      if (key.startsWith(userId + "-")) {
        avgPrices[key.replace(userId + "-", "")] = val;
      }
    }
    await supabase.from("stock_portfolios").upsert({
      user_id: userId,
      portfolio: JSON.stringify(portfolio),
      avg_prices: JSON.stringify(avgPrices),
    }, { onConflict: "user_id" });
  } catch (e) { console.error("[SAVE PORTFOLIO]", e.message); }
}

async function loadPortfolios() {
  try {
    const { data } = await supabase.from("stock_portfolios").select("*");
    if (!data) return;
    for (const row of data) {
      try {
        stockPortfolios.set(row.user_id, JSON.parse(row.portfolio));
        // Load avg prices if saved
        if (row.avg_prices) {
          const avgP = JSON.parse(row.avg_prices);
          for (const [ticker, price] of Object.entries(avgP)) {
            avgBuyPrice.set(`${row.user_id}-${ticker}`, price);
          }
        }
      } catch {}
    }
    console.log(`[STOCKS] Loaded ${data.length} portfolio(s) with avg prices`);
  } catch (e) { console.error("[LOAD PORTFOLIOS]", e.message); }
}

async function saveStockPrices() {
  try {
    await supabase.from("empire_data").upsert({
      key: "stock_prices",
      value: { prices: stockPrices, candles: stockCandles },
    }, { onConflict: "key" });
  } catch (e) { console.error("[SAVE STOCKS]", e.message); }
}

async function loadStockPrices() {
  try {
    const { data } = await supabase.from("empire_data").select("value").eq("key", "stock_prices").single();
    if (data?.value?.prices) {
      stockPrices  = data.value.prices;
      stockCandles = data.value.candles || {};
      fixPennyStockPrices(); // fix any wrong penny prices
      console.log("[STOCKS] Prices + candles loaded from Supabase");
    } else {
      initStockPrices();
    }
  } catch {
    initStockPrices();
  }
}

function startStockMarket(guild, generalChannelId) {
  // Fetch real data every 4 hours independently
  const fetchRealData = async () => {
    try {
      const marketOpen = isMarketHours();

      // Always fetch crypto first — unlimited
      const btcChange = await fetchCryptoChange("bitcoin");
      const ethChange = await fetchCryptoChange("ethereum");
      if (btcChange !== null) cachedRealChanges["DARK"] = btcChange;
      if (ethChange !== null) cachedRealChanges["RUNE"] = ethChange;

      // Use crypto sentiment as fallback for all stocks
      // If BTC/ETH data available, derive traditional stock movements from it
      const cryptoSentiment = ((btcChange || 0) + (ethChange || 0)) / 2;

      // Try Alpha Vantage for traditional stocks
      let alphaWorking = true;
      for (const [ticker, stock] of Object.entries(STOCKS)) {
        if (stock.penny || stock.cryptoId) continue;
        if (!stock.realTicker || !marketOpen) {
          // Outside market hours — use scaled crypto sentiment + noise
          cachedRealChanges[ticker] = cryptoSentiment * 0.3 + (Math.random() - 0.5) * 0.005;
          continue;
        }
        if (!alphaWorking) {
          // Alpha Vantage exhausted — use crypto sentiment scaled by stock volatility
          cachedRealChanges[ticker] = cryptoSentiment * (stock.volatility / 0.20) * 0.4 + (Math.random() - 0.5) * 0.003;
          continue;
        }
        const change = await fetchStockChange(stock.realTicker);
        if (change !== null) {
          cachedRealChanges[ticker] = change;
          await new Promise(r => setTimeout(r, 15000));
        } else {
          // Alpha Vantage returned nothing — mark as exhausted, use crypto fallback
          alphaWorking = false;
          cachedRealChanges[ticker] = cryptoSentiment * (stock.volatility / 0.20) * 0.4 + (Math.random() - 0.5) * 0.003;
          console.log(`[STOCKS] Alpha Vantage exhausted — using crypto fallback for ${ticker}`);
        }
      }

      // Penny stocks always use crypto sentiment + extra noise
      for (const [ticker, stock] of Object.entries(STOCKS)) {
        if (!stock.penny) continue;
        cachedRealChanges[ticker] = cryptoSentiment * (stock.volatility / 0.20) * 0.6 + (Math.random() - 0.5) * stock.volatility * 0.1;
      }

      console.log(`[STOCKS] Real data fetched | BTC: ${btcChange?.toFixed(4) || "N/A"} | ETH: ${ethChange?.toFixed(4) || "N/A"} | Alpha: ${alphaWorking ? "OK" : "EXHAUSTED→crypto fallback"}`);
    } catch (e) {
      console.error("[STOCKS] Real data fetch error:", e.message);
    }
    setTimeout(fetchRealData, 4 * 60 * 60 * 1000);
  };
  setTimeout(fetchRealData, 5000);

  // Tick every 1 minute — ALWAYS reschedules even on error
  const tick = async () => {
    console.log("[STOCKS TICK] Starting tick at", new Date().toISOString());
    try {
      await tickStockMarket();
      await saveStockPrices();
      console.log("[STOCKS TICK] Tick complete — prices saved");
      const channel = guild.channels.cache.get(generalChannelId);
      if (channel) {
        for (const [ticker] of Object.entries(STOCKS)) {
          const candles = stockCandles[ticker] || [];
          if (candles.length < 2) continue;
          const prev = candles[candles.length - 2].c;
          const curr = candles[candles.length - 1].c;
          const pct = (curr - prev) / prev * 100;
          if (Math.abs(pct) >= 5) {
            const dir = pct > 0 ? "📈 **SURGING**" : "📉 **CRASHING**";
            await channel.send(
              `${dir} **${ticker}** — ${STOCKS[ticker].name} moved **${pct > 0 ? "+" : ""}${pct.toFixed(1)}%** in 1 minute!\n` +
              `Current: **${eco.formatWallet(eco.fromCopper(stockPrices[ticker]))}** | Cosa stocks / Cosa market / Cosa trade`
            ).catch(() => {});
          }
        }
      }
    } catch (e) {
      console.error("[STOCKS TICK ERROR]", e.message);
    }
    setTimeout(tick, 60 * 1000);
  };

  setTimeout(tick, 60 * 1000);
  console.log("📊 Stock market started — 1 min candles | Real data every 4h | Crypto live");
}

async function tickImmediately() {
  await tickStockMarket();
  await saveStockPrices();
  console.log("[STOCKS] Immediate tick complete");
}

/**
 * Force N instant candles on a specific ticker at +5% or -5% each.
 * direction: 1 = pump (green), -1 = crash (red)
 */
async function forcePumpCrash(ticker, rounds, direction) {
  ticker = ticker.toUpperCase();
  if (!STOCKS[ticker]) return;
  for (let i = 0; i < rounds; i++) {
    const open = stockPrices[ticker];
    const move = direction * 0.05; // exactly 5% per candle
    const close = Math.max(1, Math.round(open * (1 + move)));
    // Wick extends slightly beyond body
    const high  = direction > 0 ? Math.round(close * 1.005) : Math.round(open * 1.002);
    const low   = direction > 0 ? Math.round(open * 0.998)  : Math.round(close * 0.995);
    const now   = new Date();
    const label = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" });
    if (!stockCandles[ticker]) stockCandles[ticker] = [];
    stockCandles[ticker].push({ o: open, h: high, l: low, c: close, label });
    if (stockCandles[ticker].length > 60) stockCandles[ticker].shift();
    stockPrices[ticker] = close;
    // Small delay between candles so they look distinct
    if (i < rounds - 1) await new Promise(r => setTimeout(r, 300));
  }
  await saveStockPrices();
  console.log(`[STOCKS] Force ${direction > 0 ? "PUMP" : "CRASH"} ${ticker} x${rounds} — final price: ${stockPrices[ticker]}`);
}

// ═══════════════════════════════════════════════════════════════
// ── MARRIAGE SYSTEM ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const MARRIAGE_COST = 5000;
const DIVORCE_COST = 10000;
const pendingProposals = new Map();

async function proposeMarriage(proposerId, targetId, guild, channelId) {
  if (proposerId === targetId) return "🔫 You can't marry yourself. Touch grass.";
  if (targetId === MASTER_ID) return "🚫 You dare propose to Don Clint? Absolutely not.";

  const existing = await getMarriage(proposerId);
  if (existing) return `🔫 You're already married to <@${existing.partnerId}>. Divorce first.`;
  const targetExisting = await getMarriage(targetId);
  if (targetExisting) return `🔫 <@${targetId}> is already married to <@${targetExisting.partnerId}>.`;

  const deducted = await eco.deductCopper(proposerId, MARRIAGE_COST).catch(() => null);
  if (!deducted) return `🔫 You need **${eco.formatWallet(eco.fromCopper(MARRIAGE_COST))}** to propose. Buy a ring first.`;

  if (pendingProposals.has(targetId)) {
    await eco.addCopper(proposerId, MARRIAGE_COST).catch(() => {});
    return "🔫 That person already has a pending proposal.";
  }

  const timeout = setTimeout(async () => {
    if (pendingProposals.has(targetId)) {
      pendingProposals.delete(targetId);
      await eco.addCopper(proposerId, MARRIAGE_COST).catch(() => {});
      const ch = guild.channels.cache.get(channelId);
      if (ch) await ch.send(`💔 <@${targetId}> didn't respond in time. Proposal expired. Ring refunded.`).catch(() => {});
    }
  }, 60000);

  pendingProposals.set(targetId, { proposerId, channelId, timeout });

  return (
    `💍 **MARRIAGE PROPOSAL**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<@${proposerId}> has proposed to <@${targetId}>! 💕\n\n` +
    `<@${targetId}> — say **Cosa marry accept** to say yes\n` +
    `or **Cosa marry decline** to break their heart.\n\n` +
    `*You have 60 seconds to decide.*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `*Married couples get a **+10% daily bonus**!*`
  );
}

async function acceptProposal(targetId, guild, channelId) {
  const proposal = pendingProposals.get(targetId);
  if (!proposal) return "🔫 No pending proposal for you.";

  clearTimeout(proposal.timeout);
  pendingProposals.delete(targetId);

  // Proposer may have accepted a different proposal (to another target) in the meantime
  const proposerMarriage = await getMarriage(proposal.proposerId);
  if (proposerMarriage) {
    await eco.addCopper(proposal.proposerId, MARRIAGE_COST).catch(() => {});
    return `🔫 <@${proposal.proposerId}> is already married to <@${proposerMarriage.partnerId}>. Proposal cancelled — ring refunded.`;
  }

  const marriedAt = new Date().toISOString();
  await supabase.from("marriages").upsert([
    { user_id: proposal.proposerId, partner_id: targetId, married_at: marriedAt },
    { user_id: targetId, partner_id: proposal.proposerId, married_at: marriedAt },
  ]).catch(() => {});

  return (
    `💒 **MARRIED!** 💒\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<@${proposal.proposerId}> 💍 <@${targetId}>\n\n` +
    `*The Family witnesses this union. May it last forever... or at least a week.*\n` +
    `💡 Married couples get a **+10% daily bonus**!\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  );
}

async function declineProposal(targetId) {
  const proposal = pendingProposals.get(targetId);
  if (!proposal) return "🔫 No pending proposal for you.";
  clearTimeout(proposal.timeout);
  pendingProposals.delete(targetId);
  await eco.addCopper(proposal.proposerId, MARRIAGE_COST).catch(() => {});
  return `💔 <@${targetId}> said **no**. Ring returned. That's rough.`;
}

async function divorce(userId) {
  const marriage = await getMarriage(userId);
  if (!marriage) return "🔫 You're not married.";

  const deducted = await eco.deductCopper(userId, DIVORCE_COST).catch(() => null);
  if (!deducted) return `🔫 Divorce costs **${eco.formatWallet(eco.fromCopper(DIVORCE_COST))}**. Can't even afford that, huh?`;

  try { await supabase.from("marriages").delete().eq("user_id", userId); await supabase.from("marriages").delete().eq("user_id", marriage.partnerId); } catch (e) { console.error("[DIVORCE]", e.message); }

  return `💔 **DIVORCED** — <@${userId}> and <@${marriage.partnerId}> are no longer married.\n*The Family has seen many such endings. It's for the best.*`;
}

async function getMarriage(userId) {
  try {
    const { data } = await supabase.from("marriages").select("*").eq("user_id", userId).single();
    if (!data) return null;
    return { partnerId: data.partner_id, marriedAt: data.married_at };
  } catch { return null; }
}

async function getMarriageBonus(userId) {
  const m = await getMarriage(userId);
  if (!m) return 0;
  return hasEffect(userId, "honeymoon_fund") ? 0.20 : 0.10;
}

// ═══════════════════════════════════════════════════════════════
// ── SHOP SYSTEM ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const SHOP_ITEMS = {
  rob_shield: {
    id: "rob_shield",
    name: "🤐 Snitch Insurance",
    desc: "Immune to a shakedown for 1 hour",
    price: 50000,        // 50,000 Cash
    duration: 60 * 60 * 1000,
    rarity: "common",
  },
  lucky_charm: {
    id: "lucky_charm",
    name: "🎲 Loaded Dice",
    desc: "Better odds for 5 minutes — flat +10% luck buff on slots, wheel & coinflip. No rerolls, no dodging bad outcomes, no payout boost — just shifted odds. Buy up to 12 per day; no cap on stacking/using them, so buy 12 and pop them whenever you like.",
    price: 5000000,      // 5,000,000 Cash — expensive for a reason
    duration: 5 * 60 * 1000,
    rarity: "epic",
  },
  xp_boost: {
    id: "xp_boost",
    name: "⭐ Daily Boost",
    desc: "Double your next daily cut",
    price: 100000,       // 100,000 Cash
    duration: null,
    rarity: "uncommon",
  },
  noble_pass: {
    id: "noble_pass",
    name: "🪪 Made Pass",
    desc: "Skip a gambling cooldown once. Usable at most once every 5 minutes, no matter how many you own — stockpiling doesn't let you chain-skip.",
    price: 20000,        // 20,000 Cash (up from 5,000)
    duration: null,
    rarity: "common",
  },
  heist_boost: {
    id: "heist_boost",
    name: "🚗 Getaway Car",
    desc: "+20% heist success chance for your next heist",
    price: 200000,       // 200,000 Cash
    duration: null,
    rarity: "rare",
  },
  stock_tip: {
    id: "stock_tip",
    name: "🤫 Inside Info",
    desc: "Shows pending buy/sell pressure + momentum signals for all stocks — see what's coming before the next candle",
    price: 100000,       // 100,000 Cash
    duration: null,
    rarity: "uncommon",
  },
  kings_call: {
    id: "kings_call",
    name: "☎️ The Don's Call",
    desc: "Summons Don Clint to intervene in the market. He decides which stock and whether to pump or crash. 24h server cooldown. No refunds.",
    price: 10000000,     // 10,000,000 Cash
    duration: null,
    rarity: "legendary",
  },
  vault_skip: {
    id: "vault_skip",
    name: "🔓 Vault Skip",
    desc: "Instantly unlocks your next bank vault tier for free — skips the Cash upgrade cost entirely. ⚠️ ONE-TIME USE, EVER. Can't be bought again once used, no matter what.",
    price: 25000000,     // 25,000,000 Cash — a one-shot legendary shortcut
    duration: null,
    rarity: "legendary",
  },
  honeymoon_fund: {
    id: "honeymoon_fund",
    name: "💍 Honeymoon Fund",
    desc: "Doubles your marriage daily bonus (+10% → +20%) for 24 hours. Must be married to use.",
    price: 150000,       // 150,000 Cash
    duration: 24 * 60 * 60 * 1000,
    rarity: "rare",
  },
  crew_backup: {
    id: "crew_backup",
    name: "👥 Crew Backup",
    desc: "Halves the fine/loss on your next crime or smuggle bust. Only consumed if you actually get caught — a clean run or success leaves it untouched for next time.",
    price: 90000,        // 90,000 Cash
    duration: null,
    rarity: "uncommon",
  },
  fast_hands: {
    id: "fast_hands",
    name: "⚡ Fast Hands",
    desc: "Halves the cooldown set by your very next work/crime/scavenge/smuggle run — whichever job you do first after using this.",
    price: 65000,        // 65,000 Cash
    duration: null,
    rarity: "uncommon",
  },
  house_favor: {
    id: "house_favor",
    name: "🎰 House Favor",
    desc: "Guarantees no total-loss (💀/wipeout) on your next slots or wheel spin. Does NOT apply automatically — you must activate it first with **Cosa use house_favor** before you gamble, then it protects whichever spin you play within 30 minutes. Usable at most once per hour, no matter how many you own.",
    price: 3000000,      // 3,000,000 Cash (up from 800,000)
    duration: null,
    rarity: "epic",
  },
  second_wind: {
    id: "second_wind",
    name: "💰 Second Wind",
    desc: "Lets you claim your daily reward a second time within the same 20h window, once.",
    price: 3000000,      // 3,000,000 Cash — priced as a treat, not a farming loop
    duration: null,
    rarity: "epic",
  },
};

// ── Rarity → quest-drop weighting ─────────────────────────────────────────────
// Higher weight = more likely to drop from a completed quest board. Legendary is
// the jackpot (the 10M Don's Call), epic close behind (the 5M Loaded Dice).
const RARITY_WEIGHT = { common: 100, uncommon: 45, rare: 20, epic: 6, legendary: 2 };
const RARITY_LABEL  = {
  common:    "⚪ Common",
  uncommon:  "🟢 Uncommon",
  rare:      "🔵 Rare",
  epic:      "🟣 Epic",
  legendary: "🟠 Legendary",
};

// ── Per-item real-time use cooldowns ──────────────────────────────────────────
// Separate from inventory "uses" — owning 50 copies of an item no longer lets
// you burn them back-to-back. You can only actually USE one every N ms, no
// matter how many are sitting in inventory. Guards the items that were
// previously fully stackable/spammable: Made Pass (noble_pass), House Favor
// (house_favor), and Second Wind (second_wind — this one got missed when the
// other two were fixed, which is exactly how someone was able to chain-claim
// the daily reward 3x in a row just by owning 3 of them).
const ITEM_USE_COOLDOWNS = {
  noble_pass: 5 * 60 * 1000,        // 5 minutes
  house_favor: 60 * 60 * 1000,      // 1 hour
  second_wind: 20 * 60 * 60 * 1000, // 20 hours — matches the daily cooldown itself, so it's truly one bonus claim per day, not per stockpile
};
const itemLastUsed = new Map(); // `${userId}:${itemId}` -> timestamp

function getItemCooldownRemaining(userId, itemId) {
  const cd = ITEM_USE_COOLDOWNS[itemId];
  if (!cd) return 0;
  const last = itemLastUsed.get(`${userId}:${itemId}`) || 0;
  return Math.max(0, cd - (Date.now() - last));
}

function markItemUsed(userId, itemId) {
  if (ITEM_USE_COOLDOWNS[itemId]) itemLastUsed.set(`${userId}:${itemId}`, Date.now());
}

const userInventories = new Map();
const activeEffects = new Map();
// House Favor — armed userId -> expiresAt. Activating the item (Cosa use
// house_favor) is what actually starts the cooldown and consumes the use now,
// instead of silently deciding pass/fail at gambling time with zero feedback
// when the cooldown blocks it (that silence is exactly what was confusing
// people into thinking it always applies). Once armed, it's guaranteed to
// protect the very next slots/wheel spin, or it expires unused after 30 min.
const armedHouseFavor = new Map();
function isHouseFavorArmed(userId) {
  const expiry = armedHouseFavor.get(userId);
  return !!expiry && expiry > Date.now();
}
function clearHouseFavorArmed(userId) {
  armedHouseFavor.delete(userId);
}
// Daily purchase tracker: userId -> { date: "YYYY-MM-DD", lucky_charm: count }
const dailyPurchases = new Map();

function getTodayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function getDailyPurchaseCount(userId, itemId) {
  const today = getTodayKey();
  const record = dailyPurchases.get(userId);
  if (!record || record.date !== today) return 0;
  return record[itemId] || 0;
}

function recordDailyPurchase(userId, itemId, quantity) {
  const today = getTodayKey();
  const record = dailyPurchases.get(userId);
  if (!record || record.date !== today) {
    dailyPurchases.set(userId, { date: today, [itemId]: quantity });
  } else {
    record[itemId] = (record[itemId] || 0) + quantity;
  }
}

async function buyShopItem(userId, itemId, quantity = 1) {
  const item = SHOP_ITEMS[itemId];
  if (!item) return `🔫 Item not found. Check **Cosa shop** for available items.`;
  if (itemId === "rob_shield" && quantity > 1) return `🔫 **Snitch Insurance** can only be held one at a time. Buy 1.`;
  if (quantity < 1 || quantity > 100) return `🔫 Buy between 1 and 100 at a time.`;

  // Vault Skip — permanent, once-per-account-ever. Blocked from re-purchase both
  // after it's been used (checked against the permanent DB flag in bank.js) and
  // while an unused copy is still sitting in inventory (no stockpiling).
  if (itemId === "vault_skip") {
    if (quantity > 1) return `🔫 **${item.name}** can only ever be bought once. Buy 1.`;
    if (await bank.isVaultSkipUsed(userId)) return `🔫 You've already used your **one lifetime Vault Skip**. It can never be bought again.`;
    const existingOwned = (userInventories.get(userId) || {})[itemId];
    if (existingOwned && (existingOwned.uses || 0) > 0) return `🔫 You already own an unused **${item.name}** — use it with **Cosa use vault_skip** first. You only ever get one, so it can't be bought again on top of it.`;
  }

  // Daily purchase limits
  const DAILY_LIMITS = { lucky_charm: 12 };
  if (DAILY_LIMITS[itemId] !== undefined) {
    const alreadyBought = getDailyPurchaseCount(userId, itemId);
    const limit = DAILY_LIMITS[itemId];
    if (alreadyBought >= limit) return `🔫 You've already bought **${limit}x ${SHOP_ITEMS[itemId].name}** today. Daily limit reached — come back tomorrow.`;
    if (alreadyBought + quantity > limit) return `🔫 That would exceed the daily limit of **${limit}x ${SHOP_ITEMS[itemId].name}**. You can only buy **${limit - alreadyBought}** more today.`;
  }

  const totalPrice = item.price * quantity;
  const deducted = await eco.deductCopper(userId, totalPrice).catch(() => null);
  if (!deducted) return `🔫 You need **💵 ${eco.fmt(totalPrice)} Cash** to buy ${quantity}x **${item.name}**.`;

  // Record daily purchase count
  if (DAILY_LIMITS && DAILY_LIMITS[itemId] !== undefined) recordDailyPurchase(userId, itemId, quantity);

  if (!userInventories.has(userId)) userInventories.set(userId, {});
  const inv = userInventories.get(userId);

  if (item.duration) {
    // Timed items — stack duration
    const currentExpiry = inv[itemId]?.expiresAt || Date.now();
    const addedDuration = item.duration * quantity;
    const newExpiry = Math.max(Date.now(), currentExpiry) + addedDuration;
    inv[itemId] = { expiresAt: newExpiry };
    const timeLeft = newExpiry - Date.now();
    setTimeout(() => {
      const i = userInventories.get(userId);
      if (i && i[itemId]?.expiresAt <= Date.now()) delete i[itemId];
    }, timeLeft);
  } else {
    // One-use items — stack uses
    inv[itemId] = { uses: (inv[itemId]?.uses || 0) + quantity };
  }

  await saveInventory(userId, inv);

  const totalDuration = item.duration ? item.duration * quantity : null;
  return (
    `🛒 **PURCHASED!** ${quantity}x ${item.name}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${item.desc}\n` +
    `💰 Total cost: **💵 ${eco.fmt(totalPrice)} Cash**\n` +
    (totalDuration ? `⏰ Total duration: **${Math.round(totalDuration / 60000)} minutes**` : `🎯 **${quantity} use(s) added to inventory**`) +
    `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `*Use it with **Cosa use ${itemId}***`
  );
}

async function useShopItem(userId, itemId, quantity = 1) {
  const item = SHOP_ITEMS[itemId];
  if (!item) return `🔫 Unknown item.`;

  const inv = userInventories.get(userId) || {};
  const owned = inv[itemId];
  if (!owned) return `🔫 You don't own **${item.name}**. Buy it with **Cosa shop buy ${itemId}**.`;

  if (owned.expiresAt && owned.expiresAt > Date.now()) {
    // Timed items — extend duration
    if (quantity > 1 && item.duration) {
      owned.expiresAt += item.duration * (quantity - 1);
      await saveInventory(userId, inv);
      return `✅ **${item.name}** extended! Now active for **${Math.round((owned.expiresAt - Date.now()) / 60000)} more minutes**.`;
    }
    return `🔫 **${item.name}** is already active! Expires <t:${Math.floor(owned.expiresAt / 1000)}:R>`;
  }
  if (owned.uses !== undefined) {
    if (owned.uses <= 0) return `🔫 You have no **${item.name}** uses left. Buy more with **Cosa shop buy ${itemId}**.`;
    if (quantity > owned.uses) return `🔫 You only have **${owned.uses}** use(s) of **${item.name}**.`;
  }

  // Special case: Vault Skip — one-time-ever free tier upgrade
  if (itemId === "vault_skip") {
    if (await bank.isVaultSkipUsed(userId)) {
      owned.uses = 0;
      await saveInventory(userId, inv);
      return `🔫 Your one lifetime **${item.name}** has already been used — this copy is void.`;
    }
    const account = await bank.getBankAccount(userId);
    const nextTierKey = bank.getNextTier(account.vault_tier);
    if (!nextTierKey) {
      return `🔫 You're already at the highest vault tier available to you — nothing to skip to. **${item.name}** was **NOT** consumed; hang onto it.`;
    }
    if (nextTierKey === "donsvault" && userId !== MASTER_ID) {
      return `🚫 The Don's Vault is reserved for the boss alone — **${item.name}** can't unlock it. Not consumed.`;
    }
    account.vault_tier = nextTierKey;
    await bank.saveBankAccount(account);
    owned.uses = 0;
    await saveInventory(userId, inv);
    await bank.markVaultSkipUsed(userId);
    const tierInfo = bank.VAULT_TIERS[nextTierKey];
    return (
      `🔓 **VAULT SKIP USED!**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `Your vault jumped straight to **${tierInfo.label}** — the usual **${bank.formatCopper(tierInfo.cost)}** upgrade cost was waived.\n` +
      `⚠️ *This was a once-in-a-lifetime item — you cannot buy or use another, ever.*`
    );
  }

  // Special case: market intel
  if (itemId === "stock_tip") {
    owned.uses = 0;
    await saveInventory(userId, inv);

    const lines = [`📰 **MARKET INTEL — CLASSIFIED** 🔒\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`];

    for (const [ticker, stock] of Object.entries(STOCKS)) {
      const candles = stockCandles[ticker] || [];
      const price   = stockPrices[ticker] || stock.basePrice * 100;

      // Pending pressure
      const pressure = marketPressure[ticker] || 0;
      const pressureStr = pressure > 0.02  ? `🔥 Heavy buy pressure (+${(pressure * 100).toFixed(1)}%)`
                        : pressure < -0.02 ? `🩸 Heavy sell pressure (${(pressure * 100).toFixed(1)}%)`
                        : pressure > 0     ? `📈 Light buy pressure`
                        : pressure < 0     ? `📉 Light sell pressure`
                        : `😴 No pending pressure`;

      // Momentum — last 5 candles
      const recent = candles.slice(-5);
      const bullish = recent.filter(c => c.c >= c.o).length;
      const bearish = recent.filter(c => c.c < c.o).length;
      const momentum = bullish >= 4 ? `🟢 Strong bullish (${bullish}/5 green)`
                     : bullish >= 3 ? `🟡 Mild bullish (${bullish}/5 green)`
                     : bearish >= 4 ? `🔴 Strong bearish (${bearish}/5 red)`
                     : bearish >= 3 ? `🟡 Mild bearish (${bearish}/5 red)`
                     : `⚪ Neutral — no clear trend`;

      // Signal
      const signal = (pressure > 0.02 || bullish >= 4) ? `⚡ **BUY SIGNAL**`
                   : (pressure < -0.02 || bearish >= 4) ? `⚠️ **SELL SIGNAL**`
                   : `🔍 **HOLD/WATCH**`;

      lines.push(`**${ticker}** — ${stock.name}\n  ${pressureStr}\n  ${momentum}\n  ${signal}`);
    }

    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*This intel expires after 1 minute. Act fast.*`);
    return lines.join("\n");
  }

  if (itemId === "kings_call") {
    // Check server-wide cooldown
    const now = Date.now();
    const remaining = DONS_CALL_COOLDOWN - (now - donsCallLastUsed);
    if (remaining > 0) {
      const hrs = Math.floor(remaining / 3600000);
      const mins = Math.floor((remaining % 3600000) / 60000);
      return `🔫 **The Don's Call** is on server cooldown — available again in **${hrs}h ${mins}m**. Your use was **NOT** consumed.`;
    }
    donsCallLastUsed = now;
    owned.uses = Math.max(0, (owned.uses || 1) - 1);
    await saveInventory(userId, inv);
    return `__DONS_CALL__:${userId}`;
  }

  // noble_pass: don't consume on use — consumed when cooldown is actually skipped
  if (itemId === "noble_pass") {
    const available = owned.uses || 0;
    if (available <= 0) return `🔫 You have no **Made Pass** uses left.`;
    return `🪪 **Made Pass ready** — you have **${available}** use(s). Next time you hit a gambling cooldown it will be skipped automatically.`;
  }

  // house_favor: now a real "activate it" item instead of a silent passive
  // check at gambling time — that silence was exactly why people thought it
  // always applied even when the 1-hour cooldown should've blocked it.
  if (itemId === "house_favor") {
    const remaining = getItemCooldownRemaining(userId, "house_favor");
    if (remaining > 0) {
      const mins = Math.ceil(remaining / 60000);
      return `🔫 **House Favor** is on cooldown for another **${mins}m**. Your use was **NOT** consumed — try again once it's off cooldown.`;
    }
    const available = owned.uses || 0;
    if (available <= 0) return `🔫 You have no **House Favor** uses left.`;
    consumeItem(userId, "house_favor"); // spends the use AND starts the 1h cooldown right now
    armedHouseFavor.set(userId, Date.now() + 30 * 60000);
    return `🎰 **House Favor activated!** Your very next slots or wheel spin is guaranteed to avoid a total wipeout. Armed for the next **30 minutes** — go spin before it expires.`;
  }

  // Passive items — these apply automatically to the next relevant action
  // (jobs.js handlers check hasEffect + consume them directly) rather than
  // being manually "activated" via Cosa use.
  const PASSIVE_AUTO_ITEMS = {
    crew_backup: "It automatically halves your next crime/smuggle bust — no need to activate it, just go do the job.",
    fast_hands:  "It automatically halves the cooldown from your next work/crime/scavenge/smuggle run — no need to activate it, just go do the job.",
    second_wind: "It automatically lets your next **Cosa daily** ignore the cooldown — no need to activate it, just claim your daily.",
  };
  if (PASSIVE_AUTO_ITEMS[itemId]) {
    return `🔫 **${item.name}** doesn't need to be manually used. ${PASSIVE_AUTO_ITEMS[itemId]} (Not consumed.)`;
  }

  // Honeymoon Fund needs an active marriage to have anything to boost
  if (itemId === "honeymoon_fund") {
    const marriage = await getMarriage(userId);
    if (!marriage) return `🔫 You're not married — **${item.name}** has nothing to boost. Get hitched first with **Cosa marry**. Not consumed.`;
  }

  if (!activeEffects.has(userId)) activeEffects.set(userId, new Set());
  activeEffects.get(userId).add(itemId);

  if (item.duration) {
    const totalDuration = item.duration * quantity;
    owned.expiresAt = Date.now() + totalDuration;
    setTimeout(() => {
      const effects = activeEffects.get(userId);
      if (effects) effects.delete(itemId);
    }, totalDuration);
    await saveInventory(userId, inv);
    return `✅ **${quantity}x ${item.name}** activated! ${item.desc} — Active for **${Math.round(totalDuration / 60000)} minutes**`;
  } else {
    owned.uses = (owned.uses || 0) - quantity;
    await saveInventory(userId, inv);
    return `✅ **${quantity}x ${item.name}** used! ${item.desc}`;
  }
}

function hasEffect(userId, itemId) {
  const inv = userInventories.get(userId) || {};
  const owned = inv[itemId];
  if (!owned) return false;
  if (owned.expiresAt) return owned.expiresAt > Date.now();
  if (owned.uses !== undefined) return owned.uses > 0;
  return false;
}

function consumeItem(userId, itemId) {
  const inv = userInventories.get(userId) || {};
  if (inv[itemId]?.uses !== undefined) {
    inv[itemId].uses = Math.max(0, inv[itemId].uses - 1);
    saveInventory(userId, inv).catch(() => {});
  }
  markItemUsed(userId, itemId);
}

// ── Admin: wipe a user's entire shop inventory (Don Clint only, enforced by caller) ─
async function resetInventory(userId) {
  userInventories.set(userId, {});
  await saveInventory(userId, {});
  return true;
}

// Read-only peek at every shop item currently active/usable for a user
// (used by the /cooldowns command). Never mutates anything.
function getActiveEffectsSummary(userId) {
  const inv = userInventories.get(userId) || {};
  const now = Date.now();
  const out = [];
  for (const [itemId, owned] of Object.entries(inv)) {
    const item = SHOP_ITEMS[itemId];
    if (!item || !owned) continue;
    if (owned.expiresAt && owned.expiresAt > now) {
      out.push({ itemId, name: item.name, kind: "timed", remainingMs: owned.expiresAt - now });
    } else if (!owned.expiresAt && (owned.uses || 0) > 0) {
      out.push({ itemId, name: item.name, kind: "uses", usesLeft: owned.uses });
    }
  }
  return out;
}

function getShopDisplay() {
  function fmtPrice(copper) {
    return `💵 ${eco.fmt(Math.floor(copper))} Cash`;
  }
  const lines = [`🛒 **FAMILY SHOP**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`];
  for (const [id, item] of Object.entries(SHOP_ITEMS)) {
    lines.push(
      `${item.name} — **${fmtPrice(item.price)}**\n` +
      `  *${item.desc}*\n` +
      `  ID: \`${id}\``
    );
  }
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*Buy: **Cosa shop buy [id] [qty]** | Use: **Cosa use [id]***`);
  return lines.join("\n");
}

function getInventoryDisplay(userId) {
  const inv = userInventories.get(userId) || {};
  const entries = Object.entries(inv).filter(([, v]) => {
    if (v.expiresAt) return v.expiresAt > Date.now();
    if (v.uses !== undefined) return v.uses > 0;
    return false;
  });
  if (!entries.length) return "🎒 Your inventory is empty. Buy items with **Cosa shop**.";
  const lines = [`🎒 **YOUR INVENTORY**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`];
  for (const [id, data] of entries) {
    const item = SHOP_ITEMS[id];
    if (!item) continue;
    const status = data.expiresAt
      ? `Expires <t:${Math.floor(data.expiresAt / 1000)}:R>`
      : `${data.uses} use(s) left`;
    lines.push(`${item.name} — *${status}*`);
  }
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*Use: **Cosa use [id]***`);
  return lines.join("\n");
}

async function saveInventory(userId, inv) {
  try {
    await supabase.from("inventories").upsert({
      user_id: userId,
      inventory: JSON.stringify(inv),
    }, { onConflict: "user_id" });
  } catch (e) { console.error("[SAVE INV]", e.message); }
}

async function loadInventories() {
  try {
    const { data } = await supabase.from("inventories").select("*");
    if (!data) return;
    const now = Date.now();
    for (const row of data) {
      try {
        const inv = JSON.parse(row.inventory);
        for (const [id, val] of Object.entries(inv)) {
          if (val.expiresAt && val.expiresAt <= now) delete inv[id];
        }
        userInventories.set(row.user_id, inv);
      } catch {}
    }
    console.log(`[SHOP] Loaded ${data.length} inventories`);
  } catch (e) { console.error("[LOAD INV]", e.message); }
}

// Strips rob_shield from EVERY player's inventory — in-memory AND in Supabase —
// so nobody's active/stored Snitch Insurance survives. Used by the Don-only
// "cosa reset rob shields" command. Returns how many players were affected.
async function resetAllRobShields() {
  let affected = 0;
  // In-memory first — covers anyone already loaded/cached on this running bot.
  for (const [userId, inv] of userInventories) {
    if (inv && inv.rob_shield) {
      delete inv.rob_shield;
      affected++;
      await saveInventory(userId, inv);
    }
  }
  // Also sweep Supabase directly in case a row exists that hasn't been loaded
  // into memory yet (e.g. a player who hasn't interacted since last restart).
  try {
    const { data } = await supabase.from("inventories").select("*");
    for (const row of data || []) {
      if (userInventories.has(row.user_id)) continue; // already handled above
      let inv;
      try { inv = JSON.parse(row.inventory); } catch { continue; }
      if (!inv.rob_shield) continue;
      delete inv.rob_shield;
      affected++;
      userInventories.set(row.user_id, inv);
      await saveInventory(row.user_id, inv);
    }
  } catch (e) { console.error("[RESET ROB SHIELDS]", e.message); }
  return affected;
}

// ── Granting items (no charge) ────────────────────────────────────────────────
// Drops an item straight into a player's inventory — used by quest rewards.
// Mirrors buyShopItem's inventory bookkeeping (uses vs. timed duration) but skips
// payment and daily-limit checks entirely.
function grantItem(userId, itemId, quantity = 1) {
  const item = SHOP_ITEMS[itemId];
  if (!item) return null;
  if (!userInventories.has(userId)) userInventories.set(userId, {});
  const inv = userInventories.get(userId);

  if (item.duration) {
    const currentExpiry = inv[itemId]?.expiresAt || Date.now();
    const newExpiry = Math.max(Date.now(), currentExpiry) + item.duration * quantity;
    inv[itemId] = { expiresAt: newExpiry };
    const timeLeft = newExpiry - Date.now();
    setTimeout(() => {
      const i = userInventories.get(userId);
      if (i && i[itemId]?.expiresAt <= Date.now()) delete i[itemId];
    }, timeLeft);
  } else {
    inv[itemId] = { uses: (inv[itemId]?.uses || 0) + quantity };
  }

  saveInventory(userId, inv).catch(() => {});
  return item;
}

// Picks one shop item weighted by rarity and grants it. Returns the granted item
// plus its rarity label for display. Legendary is the rare jackpot.
async function grantRandomQuestItem(userId) {
  const ids = Object.keys(SHOP_ITEMS);
  const weighted = ids.map(id => ({ id, w: RARITY_WEIGHT[SHOP_ITEMS[id].rarity] || 10 }));
  const total = weighted.reduce((a, x) => a + x.w, 0);
  let r = Math.random() * total;
  let chosenId = weighted[weighted.length - 1].id;
  for (const x of weighted) { r -= x.w; if (r <= 0) { chosenId = x.id; break; } }
  const item = grantItem(userId, chosenId, 1);
  return { item, rarity: item.rarity, rarityLabel: RARITY_LABEL[item.rarity] || item.rarity };
}

module.exports = {
  initFeatures,
  // AFK
  setAfk, removeAfk, getAfk, isAfk, getAfkPingerMute, formatAfkTime,
  // Giveaway
  startGiveaway, endGiveaway, rerollGiveaway, loadGiveaways, activeGiveaways,
  // Trivia
  activeTournaments, startTriviaRound, getScoreBoard, endTriviaTournament, TRIVIA_QUESTIONS,
  // Heist
  activeHeists, startHeist, joinHeistButton, grabHeistCash, executeHeist,
  // Stocks
  STOCKS, stockPrices,
  get stockCandles() { return stockCandles; },
  stockPortfolios,
  buyStock, sellStock, getMarketBoard, getMarketBoardData, getPortfolio, getStockHistory,
  startStockMarket, loadPortfolios, loadStockPrices, tickImmediately,
  forcePumpCrash,
  get marketPressure() { return marketPressure; },
  isMarketHours,
  get stockMarketOpen() { return stockMarketOpen; },
  setStockMarketOpen: (v) => { stockMarketOpen = v; },
  get donManipulation() { return donManipulation; },
  setDonManipulation: (v) => { donManipulation = v; },
  // Marriage
  proposeMarriage, acceptProposal, declineProposal, divorce,
  getMarriage, getMarriageBonus, pendingProposals,
  MARRIAGE_COST, DIVORCE_COST,
  // Shop
  SHOP_ITEMS, buyShopItem, useShopItem, hasEffect, consumeItem,
  getActiveEffectsSummary,
  getShopDisplay, getInventoryDisplay, loadInventories, resetAllRobShields,
  grantItem, grantRandomQuestItem, RARITY_LABEL,
  getItemCooldownRemaining, resetInventory, isHouseFavorArmed, clearHouseFavorArmed,
};
