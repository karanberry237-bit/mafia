// ── Jobs, Hustles & Quests ────────────────────────────────────────────────────
// Self-contained set of repeatable ways to earn Cash, all flat-currency.
// Rewards scale with the player's Family rank level (0 = street rat, 8 = boss;
// Don Clint bypasses everything). Cooldowns are in-memory Maps — same approach
// the rest of the bot already uses for gamble/loan cooldowns, so a bot restart
// simply clears the timers (players lose nothing but a wait).

const eco = require("./economy");
const features = require("./features");

// ── Cooldowns ──────────────────────────────────────────────────────────────────
const WORK_COOLDOWN_MS     = 10 * 60 * 1000;      // 10 min
const CRIME_COOLDOWN_MS    = 10 * 60 * 1000;      // 10 min
const SCAVENGE_COOLDOWN_MS = 1 * 60 * 1000;       // 1 min
const SMUGGLE_COOLDOWN_MS  = 90 * 60 * 1000;      // 90 min

const cooldowns = {
  work:     new Map(),
  crime:    new Map(),
  scavenge: new Map(),
  smuggle:  new Map(),
};

function checkCooldown(kind, userId, ms, isDon) {
  if (isDon) return null;
  const last = cooldowns[kind].get(userId) || 0;
  const left = ms - (Date.now() - last);
  if (left > 0) {
    const totalSecs = Math.ceil(left / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }
  return null;
}
function setCooldown(kind, userId) { cooldowns[kind].set(userId, Date.now()); }

// Wipes every in-memory job cooldown for every user — used by the Don-only
// "reset economy" command after a full economy wipe.
function resetAllCooldowns() {
  for (const kind of Object.keys(cooldowns)) cooldowns[kind].clear();
}

// Fast Hands: if active, halve the cooldown this job action sets and consume
// the item. Works by back-dating the "last used" timestamp by half the
// cooldown window, so checkCooldown sees half the wait already elapsed.
function setCooldownMaybeHalved(kind, userId, ms, isDon) {
  if (!isDon && features.hasEffect(userId, "fast_hands")) {
    cooldowns[kind].set(userId, Date.now() - ms / 2);
    features.consumeItem(userId, "fast_hands");
    return true; // fast hands triggered
  }
  cooldowns[kind].set(userId, Date.now());
  return false;
}

// Read-only peek at all job cooldowns for a user (used by the /cooldowns command).
// Reuses checkCooldown, which never mutates state — safe to call anytime.
function getCooldownStatus(userId, isDon) {
  return {
    work:     checkCooldown("work", userId, WORK_COOLDOWN_MS, isDon),
    crime:    checkCooldown("crime", userId, CRIME_COOLDOWN_MS, isDon),
    scavenge: checkCooldown("scavenge", userId, SCAVENGE_COOLDOWN_MS, isDon),
    smuggle:  checkCooldown("smuggle", userId, SMUGGLE_COOLDOWN_MS, isDon),
  };
}

function rankMultiplier(rankLevel) {
  // rankLevel: 0 (street rat) .. 8 (boss). Each rank adds +40%.
  return 1 + Math.max(0, rankLevel) * 0.4;
}

function rint(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── The Feds — rare bonus fine ON TOP OF an existing bust ───────────────────
// Independent roll from the normal "caught" fine above — most busts are just
// the normal fine, but occasionally the Feds were specifically watching that
// one and tack on an extra cut. Only rolled when a job already went bad.
const FEDS_CHANCE = 0.08; // 8% — rare
const FEDS_FINE_MIN_PCT = 0.15;
const FEDS_FINE_MAX_PCT = 0.30;

async function maybeApplyFedsBonus(userId, isDon, deps) {
  if (isDon) return "";
  if (Math.random() >= FEDS_CHANCE) return "";
  const wallet = await eco.getWallet(userId);
  const have = eco.walletToCopper(wallet);
  if (have <= 0) return "";
  const pct = FEDS_FINE_MIN_PCT + Math.random() * (FEDS_FINE_MAX_PCT - FEDS_FINE_MIN_PCT);
  const bonusFine = Math.floor(have * pct);
  if (bonusFine <= 0) return "";
  const { debtAdded } = await applyLoss(userId, bonusFine, deps, isDon);
  const debtLine = debtAdded > 0 ? ` (an extra **💵 ${eco.fmt(debtAdded)} Cash** added to your debt)` : "";
  return `\n🚨 **THE FEDS WERE WATCHING THAT ONE.** On top of the bust, they hit you with a bonus **💵 ${eco.fmt(bonusFine)} Cash** fine.${debtLine}`;
}

// ── Loss handling ────────────────────────────────────────────────────────────
// A failed job costs the FULL loss amount — it is never capped at the wallet.
// The wallet pays what it can; any shortfall becomes debt to the Family (no
// dipping into the player's bank vault). Whatever real cash is taken becomes the
// Don's vig income via deps.vig(). The Don himself never pays.
async function applyLoss(userId, loss, deps, isDon) {
  if (isDon || loss <= 0) return { paidFromWallet: 0, debtAdded: 0 };
  const wallet = await eco.getWallet(userId);
  const have = eco.walletToCopper(wallet);
  const paidFromWallet = Math.min(have, loss);
  if (paidFromWallet > 0) await eco.deductCopper(userId, paidFromWallet);
  const debtAdded = loss - paidFromWallet;
  if (debtAdded > 0) await eco.addDebt(userId, debtAdded);
  // Only real cash actually taken flows to the Don — debt isn't minted as income.
  if (paidFromWallet > 0 && deps && typeof deps.vig === "function") {
    await deps.vig(paidFromWallet);
  }
  return { paidFromWallet, debtAdded };
}

// ── Flavor pools ────────────────────────────────────────────────────────────────
const WORK_JOBS = [
  { verb: "tended bar", where: "at the Family's speakeasy" },
  { verb: "ran numbers", where: "for the local bookie" },
  { verb: "worked the docks", where: "unloading 'imported goods'" },
  { verb: "drove the getaway car", where: "for a quiet pickup" },
  { verb: "collected protection money", where: "on the boss's block" },
  { verb: "washed cash", where: "through the laundromat" },
  { verb: "stood watch", where: "outside the social club" },
  { verb: "delivered a package", where: "no questions asked" },
  { verb: "fixed the odds", where: "at the back-room card game" },
  { verb: "moved crates", where: "out of the warehouse" },
];

const CRIME_SUCCESS = [
  "cracked a jewelry store safe",
  "hijacked a truck full of cigarettes",
  "ran a slick pickpocket circuit downtown",
  "boosted a luxury car and flipped it",
  "pulled off a clean warehouse burglary",
  "shook down a rival's poker game",
];
const CRIME_CAUGHT = [
  "a beat cop caught you red-handed",
  "the job went sideways and you had to pay off a witness",
  "an alarm tripped and you bribed your way out",
  "a snitch tipped off the target — you paid to keep quiet",
];

const SCAVENGE_FINDS = [
  "found a wad of cash in a storm drain",
  "picked a dropped wallet off the sidewalk",
  "cashed in some bottles and scrap",
  "shook down a vending machine",
  "found loose bills under the bar's floorboards",
  "pawned a 'found' watch",
];

const SMUGGLE_ROUTES = [
  "ran liquor across the county line",
  "moved a shipment through the harbor",
  "smuggled contraband past the checkpoint",
  "flipped a truckload of 'tax-free' goods",
];
const SMUGGLE_BUST = [
  "the feds were waiting at the drop",
  "a rival crew jacked your shipment",
  "customs flagged the container",
  "your driver flipped and you lost the load",
];

// ── WORK — safe, guaranteed, small ──────────────────────────────────────────────
async function doWork(userId, rankLevel, isDon) {
  const cd = checkCooldown("work", userId, WORK_COOLDOWN_MS, isDon);
  if (cd) return `⏰ You've done enough for now. Clock back in in **${cd}**.`;

  const mult = rankMultiplier(rankLevel);
  const pay = Math.floor(rint(2500, 8000) * mult);
  const job = pick(WORK_JOBS);
  const fastHandsUsed = setCooldownMaybeHalved("work", userId, WORK_COOLDOWN_MS, isDon);
  const newW = await eco.addCopper(userId, pay);
  recordQuest(userId, "work");

  return (
    `💼 **Honest Work** *(well, honest-ish)*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `You ${job.verb} ${job.where} and earned **💵 ${eco.fmt(pay)} Cash**.\n` +
    `New balance: ${eco.formatWallet(newW)}` +
    (fastHandsUsed ? `\n⚡ **Fast Hands** cut this cooldown in half!` : "")
  );
}

// ── CRIME — risky, bigger reward, can backfire ──────────────────────────────────
async function doCrime(userId, rankLevel, isDon, deps = {}) {
  const cd = checkCooldown("crime", userId, CRIME_COOLDOWN_MS, isDon);
  if (cd) return `⏰ Too hot on the streets right now. Lay low for **${cd}**.`;

  const fastHandsUsed = setCooldownMaybeHalved("crime", userId, CRIME_COOLDOWN_MS, isDon);
  const fastHandsLine = fastHandsUsed ? `\n⚡ **Fast Hands** cut this cooldown in half!` : "";
  const mult = rankMultiplier(rankLevel);
  const roll = Math.random();

  if (roll < 0.55) {
    // Success
    const pay = Math.floor(rint(9000, 28000) * mult);
    const newW = await eco.addCopper(userId, pay);
    recordQuest(userId, "crime");
    return (
      `🔫 **Score!**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `You ${pick(CRIME_SUCCESS)} and walked with **💵 ${eco.fmt(pay)} Cash**.\n` +
      `New balance: ${eco.formatWallet(newW)}${fastHandsLine}`
    );
  } else if (roll < 0.85) {
    // Caught — fine is paid in full; shortfall becomes debt, cash goes to the Don.
    // Sized to bite against the 9k–28k success payout so a bust is a real setback.
    let fine = Math.floor(rint(12000, 30000) * mult);
    let crewBackupUsed = false;
    if (!isDon && features.hasEffect(userId, "crew_backup")) {
      fine = Math.floor(fine / 2);
      features.consumeItem(userId, "crew_backup");
      crewBackupUsed = true;
    }
    const { debtAdded } = await applyLoss(userId, fine, deps, isDon);
    const newW = await eco.getWallet(userId);
    const debtLine = debtAdded > 0
      ? `\n🔴 You couldn't cover it — **💵 ${eco.fmt(debtAdded)} Cash** added to your debt to the Family.`
      : "";
    const crewLine = crewBackupUsed ? `\n👥 **Crew Backup** cut your losses in half!` : "";
    const fedsLine = await maybeApplyFedsBonus(userId, isDon, deps);
    return (
      `🚔 **Busted.**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `You tried to pull a job but ${pick(CRIME_CAUGHT)}. It cost you **💵 ${eco.fmt(fine)} Cash**.${debtLine}${crewLine}${fedsLine}\n` +
      `New balance: ${eco.formatWallet(newW)}${fastHandsLine}`
    );
  } else {
    // Clean escape, no gain
    return (
      `🏃 **Aborted.**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `The job smelled wrong so you bailed. No cash, but no heat either.${fastHandsLine}`
    );
  }
}

// ── SCAVENGE — very short cooldown, tiny reward, rare bonus ──────────────────────
async function doScavenge(userId, rankLevel, isDon) {
  const cd = checkCooldown("scavenge", userId, SCAVENGE_COOLDOWN_MS, isDon);
  if (cd) return `⏰ Nothing left to pick over yet. Try again in **${cd}**.`;

  const fastHandsUsed = setCooldownMaybeHalved("scavenge", userId, SCAVENGE_COOLDOWN_MS, isDon);
  let pay = rint(400, 1800);
  let bonusLine = "";
  if (Math.random() < 0.08) {
    const bonus = rint(4000, 10000);
    pay += bonus;
    bonusLine = `\n✨ **Rare find!** +💵 ${eco.fmt(bonus)} Cash`;
  }
  const newW = await eco.addCopper(userId, pay);
  recordQuest(userId, "scavenge");
  return (
    `🔦 **Scavenging**\n` +
    `You ${pick(SCAVENGE_FINDS)} — **💵 ${eco.fmt(pay)} Cash**.${bonusLine}\n` +
    `New balance: ${eco.formatWallet(newW)}` +
    (fastHandsUsed ? `\n⚡ **Fast Hands** cut this cooldown in half!` : "")
  );
}

// ── SMUGGLE — long cooldown, high stakes ────────────────────────────────────────
async function doSmuggle(userId, rankLevel, isDon, deps = {}) {
  const cd = checkCooldown("smuggle", userId, SMUGGLE_COOLDOWN_MS, isDon);
  if (cd) return `⏰ The route's being watched. Wait **${cd}** before the next run.`;

  const fastHandsUsed = setCooldownMaybeHalved("smuggle", userId, SMUGGLE_COOLDOWN_MS, isDon);
  const fastHandsLine = fastHandsUsed ? `\n⚡ **Fast Hands** cut this cooldown in half!` : "";
  const mult = rankMultiplier(rankLevel);
  // Fair high-stakes coin-flip: win and bust are the SAME magnitude, so this is a
  // real gamble, not a free printer. A bust is never capped at the wallet — what
  // you can't cover in cash becomes debt to the Family, and the cash you do lose
  // becomes the Don's vig.
  if (Math.random() < 0.48) {
    const pay = Math.floor(rint(70000, 160000) * mult);
    const newW = await eco.addCopper(userId, pay);
    recordQuest(userId, "smuggle");
    return (
      `🚢 **Shipment delivered.**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `You ${pick(SMUGGLE_ROUTES)} and cleared **💵 ${eco.fmt(pay)} Cash**.\n` +
      `New balance: ${eco.formatWallet(newW)}${fastHandsLine}`
    );
  } else {
    let loss = Math.floor(rint(70000, 160000) * mult);
    let crewBackupUsed = false;
    if (!isDon && features.hasEffect(userId, "crew_backup")) {
      loss = Math.floor(loss / 2);
      features.consumeItem(userId, "crew_backup");
      crewBackupUsed = true;
    }
    const { debtAdded } = await applyLoss(userId, loss, deps, isDon);
    const newW = await eco.getWallet(userId);
    const debtLine = debtAdded > 0
      ? `\n🔴 You couldn't cover it — **💵 ${eco.fmt(debtAdded)} Cash** added to your debt to the Family.`
      : "";
    const crewLine = crewBackupUsed ? `\n👥 **Crew Backup** cut your losses in half!` : "";
    const fedsLine = await maybeApplyFedsBonus(userId, isDon, deps);
    return (
      `💥 **Run went bad.**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `You ${pick(SMUGGLE_BUST)}. The bill came to **💵 ${eco.fmt(loss)} Cash** covering your tracks.${debtLine}${crewLine}${fedsLine}\n` +
      `New balance: ${eco.formatWallet(newW)}${fastHandsLine}`
    );
  }
}

// ── Daily Quest Board ────────────────────────────────────────────────────────────
// Three rotating objectives, all completable through the jobs above so tracking
// stays fully self-contained. Progress is in-memory and resets at UTC midnight
// (and on bot restart). Completing all three pays a lump-sum bonus, once per day.
const QUEST_TEMPLATES = [
  { key: "work",     goal: 3, label: "Pull 3 legit shifts",       cmd: "Cosa work" },
  { key: "crime",    goal: 2, label: "Land 2 successful crimes",  cmd: "Cosa crime" },
  { key: "scavenge", goal: 5, label: "Scavenge 5 times",          cmd: "Cosa scavenge" },
];
// Clearing the board drops a rarity-weighted item from the Family stash (see
// features.grantRandomQuestItem) — jobs already pay plenty of Cash, so the reward
// here is loot instead.

// userId -> { day: "YYYY-MM-DD", progress: {work,crime,scavenge,...}, claimed: bool }
const questState = new Map();

function today() { return new Date().toISOString().slice(0, 10); }

function getQuest(userId) {
  const day = today();
  let q = questState.get(userId);
  if (!q || q.day !== day) {
    q = { day, progress: {}, claimed: false };
    questState.set(userId, q);
  }
  return q;
}

function recordQuest(userId, key) {
  const q = getQuest(userId);
  q.progress[key] = (q.progress[key] || 0) + 1;
}

function questComplete(q) {
  return QUEST_TEMPLATES.every(t => (q.progress[t.key] || 0) >= t.goal);
}

function getQuestBoard(userId) {
  const q = getQuest(userId);
  const lines = QUEST_TEMPLATES.map(t => {
    const have = Math.min(q.progress[t.key] || 0, t.goal);
    const done = have >= t.goal;
    const bar = `${have}/${t.goal}`;
    return `${done ? "✅" : "⬜"} ${t.label} — **${bar}**  *(${t.cmd})*`;
  });
  const all = questComplete(q);
  let footer;
  if (q.claimed) footer = `🏆 Today's reward already claimed. Resets at midnight UTC.`;
  else if (all)  footer = `🎉 All done! Claim your **mystery item** from the Family stash with **Cosa quest claim** — could be anything up to 🟠 Legendary.`;
  else           footer = `Complete all three, then run **Cosa quest claim** for a random item (rarer loot = luckier you).`;
  return (
    `📋 **DAILY BOUNTY BOARD** *(resets midnight UTC)*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    lines.join("\n") +
    `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    footer
  );
}

async function claimQuest(userId) {
  const q = getQuest(userId);
  if (q.claimed) return `🏆 You've already claimed today's bounty reward. Come back after midnight UTC.`;
  if (!questComplete(q)) return `🔫 You haven't finished all three bounties yet.\n\n${getQuestBoard(userId)}`;
  q.claimed = true;
  const reward = await features.grantRandomQuestItem(userId);
  return (
    `🏆 **BOUNTY BOARD CLEARED!**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Don Clint digs into the Family stash and tosses you some loot:\n` +
    `${reward.rarityLabel} — **${reward.item.name}**\n` +
    `*${reward.item.desc}*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `See it with **Cosa inventory** • use it with **Cosa use ${reward.item.id}**`
  );
}

// ── Help ─────────────────────────────────────────────────────────────────────────
const JOBS_HELP = [
  "```",
  "💼  JOBS & HUSTLES  (all pay Cash, scale with your rank)",
  "  Cosa work       ← safe pay, 10m cooldown",
  "  Cosa crime      ← risky, bigger score, 10m cooldown",
  "  Cosa scavenge   ← quick pocket change, 1m cooldown",
  "  Cosa smuggle    ← high stakes, 90m cooldown",
  "",
  "📋  QUESTS",
  "  Cosa quests     ← view the daily bounty board",
  "  Cosa quest claim ← clear the board for a random shop item (rarity-weighted)",
  "",
  "⏰  Cosa cooldowns ← see every timer (jobs, gambling, rob, chess, daily, loan) in one place",
  "```",
].join("\n");

module.exports = {
  doWork, doCrime, doScavenge, doSmuggle,
  getQuestBoard, claimQuest, recordQuest,
  getCooldownStatus, resetAllCooldowns,
  JOBS_HELP,
};
