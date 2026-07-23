// ── Jobs, Hustles & Quests ────────────────────────────────────────────────────
// Self-contained set of repeatable ways to earn Cash, all flat-currency.
// Rewards scale with the player's Family rank level (0 = street rat, 8 = boss;
// Don Clint bypasses everything). Cooldowns are in-memory Maps — same approach
// the rest of the bot already uses for gamble/loan cooldowns, so a bot restart
// simply clears the timers (players lose nothing but a wait).

const eco = require("./economy");

// ── Cooldowns ──────────────────────────────────────────────────────────────────
const WORK_COOLDOWN_MS     = 30 * 60 * 1000;      // 30 min
const CRIME_COOLDOWN_MS    = 45 * 60 * 1000;      // 45 min
const SCAVENGE_COOLDOWN_MS = 10 * 60 * 1000;      // 10 min
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

function rankMultiplier(rankLevel) {
  // rankLevel: 0 (street rat) .. 8 (boss). Each rank adds +40%.
  return 1 + Math.max(0, rankLevel) * 0.4;
}

function rint(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

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
  setCooldown("work", userId);
  const newW = await eco.addCopper(userId, pay);
  recordQuest(userId, "work");

  return (
    `💼 **Honest Work** *(well, honest-ish)*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `You ${job.verb} ${job.where} and earned **💵 ${pay.toLocaleString()} Cash**.\n` +
    `New balance: ${eco.formatWallet(newW)}`
  );
}

// ── CRIME — risky, bigger reward, can backfire ──────────────────────────────────
async function doCrime(userId, rankLevel, isDon) {
  const cd = checkCooldown("crime", userId, CRIME_COOLDOWN_MS, isDon);
  if (cd) return `⏰ Too hot on the streets right now. Lay low for **${cd}**.`;

  setCooldown("crime", userId);
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
      `You ${pick(CRIME_SUCCESS)} and walked with **💵 ${pay.toLocaleString()} Cash**.\n` +
      `New balance: ${eco.formatWallet(newW)}`
    );
  } else if (roll < 0.85) {
    // Caught — fine (capped at what they have)
    const wallet = await eco.getWallet(userId);
    const have = eco.walletToCopper(wallet);
    const fine = Math.min(have, Math.floor(rint(6000, 16000) * mult));
    if (fine > 0) await eco.deductCopper(userId, fine);
    const newW = await eco.getWallet(userId);
    return (
      `🚔 **Busted.**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `You tried to pull a job but ${pick(CRIME_CAUGHT)}. It cost you **💵 ${fine.toLocaleString()} Cash**.\n` +
      `New balance: ${eco.formatWallet(newW)}`
    );
  } else {
    // Clean escape, no gain
    return (
      `🏃 **Aborted.**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `The job smelled wrong so you bailed. No cash, but no heat either.`
    );
  }
}

// ── SCAVENGE — very short cooldown, tiny reward, rare bonus ──────────────────────
async function doScavenge(userId, rankLevel, isDon) {
  const cd = checkCooldown("scavenge", userId, SCAVENGE_COOLDOWN_MS, isDon);
  if (cd) return `⏰ Nothing left to pick over yet. Try again in **${cd}**.`;

  setCooldown("scavenge", userId);
  let pay = rint(400, 1800);
  let bonusLine = "";
  if (Math.random() < 0.08) {
    const bonus = rint(4000, 10000);
    pay += bonus;
    bonusLine = `\n✨ **Rare find!** +💵 ${bonus.toLocaleString()} Cash`;
  }
  const newW = await eco.addCopper(userId, pay);
  recordQuest(userId, "scavenge");
  return (
    `🔦 **Scavenging**\n` +
    `You ${pick(SCAVENGE_FINDS)} — **💵 ${pay.toLocaleString()} Cash**.${bonusLine}\n` +
    `New balance: ${eco.formatWallet(newW)}`
  );
}

// ── SMUGGLE — long cooldown, high stakes ────────────────────────────────────────
async function doSmuggle(userId, rankLevel, isDon) {
  const cd = checkCooldown("smuggle", userId, SMUGGLE_COOLDOWN_MS, isDon);
  if (cd) return `⏰ The route's being watched. Wait **${cd}** before the next run.`;

  setCooldown("smuggle", userId);
  const mult = rankMultiplier(rankLevel);
  // Biggest payout on the board, so the odds are a coin-flip and busts hurt.
  if (Math.random() < 0.48) {
    const pay = Math.floor(rint(110000, 270000) * mult);
    const newW = await eco.addCopper(userId, pay);
    recordQuest(userId, "smuggle");
    return (
      `🚢 **Shipment delivered.**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `You ${pick(SMUGGLE_ROUTES)} and cleared **💵 ${pay.toLocaleString()} Cash**.\n` +
      `New balance: ${eco.formatWallet(newW)}`
    );
  } else {
    const wallet = await eco.getWallet(userId);
    const have = eco.walletToCopper(wallet);
    const loss = Math.min(have, Math.floor(rint(60000, 150000) * mult));
    if (loss > 0) await eco.deductCopper(userId, loss);
    const newW = await eco.getWallet(userId);
    return (
      `💥 **Run went bad.**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `You ${pick(SMUGGLE_BUST)}. Lost **💵 ${loss.toLocaleString()} Cash** covering your tracks.\n` +
      `New balance: ${eco.formatWallet(newW)}`
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
const QUEST_BONUS = 3000;

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
  if (q.claimed) footer = `🏆 Today's bonus already claimed. Resets at midnight UTC.`;
  else if (all)  footer = `🎉 All done! Claim your **💵 ${QUEST_BONUS.toLocaleString()} Cash** bonus with **Cosa quest claim**.`;
  else           footer = `Complete all three, then run **Cosa quest claim** for **💵 ${QUEST_BONUS.toLocaleString()} Cash**.`;
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
  if (q.claimed) return `🏆 You've already claimed today's bounty bonus. Come back after midnight UTC.`;
  if (!questComplete(q)) return `🔫 You haven't finished all three bounties yet.\n\n${getQuestBoard(userId)}`;
  q.claimed = true;
  const newW = await eco.addCopper(userId, QUEST_BONUS);
  return (
    `🏆 **BOUNTY BOARD CLEARED!**\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Don Clint slides you a **💵 ${QUEST_BONUS.toLocaleString()} Cash** bonus for a productive day.\n` +
    `New balance: ${eco.formatWallet(newW)}`
  );
}

// ── Help ─────────────────────────────────────────────────────────────────────────
const JOBS_HELP = [
  "```",
  "💼  JOBS & HUSTLES  (all pay Cash, scale with your rank)",
  "  Cosa work       ← safe pay, 30m cooldown",
  "  Cosa crime      ← risky, bigger score, 45m cooldown",
  "  Cosa scavenge   ← quick pocket change, 10m cooldown",
  "  Cosa smuggle    ← high stakes, 90m cooldown",
  "",
  "📋  QUESTS",
  "  Cosa quests     ← view the daily bounty board",
  "  Cosa quest claim ← claim your all-done bonus",
  "```",
].join("\n");

module.exports = {
  doWork, doCrime, doScavenge, doSmuggle,
  getQuestBoard, claimQuest, recordQuest,
  JOBS_HELP,
};
