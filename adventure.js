// ═══════════════════════════════════════════════════════════════
// ── ADVENTURE / EXPLORING ────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
// A lightweight choice-driven expedition mini-game. Pick a location with
// "Cosa explore [location]", then answer each scene with "Cosa choose 1"
// or "Cosa choose 2" — safe vs risky. 3 stages per run. Cash is paid out
// live as you go; treasures (kept in inventory, sellable for Cash) are
// rolled at the end based on how the run went.
const eco = require("./economy.js");
const features = require("./features.js");

const EXPLORE_COOLDOWN_MS = 45 * 60 * 1000;
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // abandon if you go quiet mid-run
const STAGES_PER_RUN = 3;

const LOCATIONS = {
  docks: { label: "🚢 Abandoned Docks", desc: "Rotting piers where smugglers used to unload — half-sunk crates everywhere." },
  vineyard: { label: "🍇 Old Vineyard", desc: "An overgrown vineyard the Family walked away from generations ago." },
  sewers: { label: "🕳️ Underground Sewers", desc: "Tunnels under the city — rumor says a rival's stash is down here somewhere." },
  mansion: { label: "🏚️ Burned-Out Mansion", desc: "A rival Don's estate, torched years back. Nobody's picked through the ash." },
};

// Scene flavor pool — combined with the location's label for variety.
const SCENES = [
  "You push past a rusted gate and find {loc} deeper in than expected.",
  "A loose panel catches your eye deep inside {loc}.",
  "You hear something shift up ahead in {loc} — could be nothing.",
  "The floor creaks under you as you move further into {loc}.",
  "A locked chest sits half-buried in the debris of {loc}.",
  "Old crates are stacked strangely at the back of {loc}, like someone hid something.",
];

const cooldowns = new Map();      // userId -> last explore timestamp
const pendingSessions = new Map(); // userId -> session

function getCooldownRemaining(userId) {
  const last = cooldowns.get(userId) || 0;
  return EXPLORE_COOLDOWN_MS - (Date.now() - last);
}

function getLocationsDisplay() {
  const lines = [`🗺️ **CHOOSE WHERE TO EXPLORE**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`];
  for (const [id, loc] of Object.entries(LOCATIONS)) {
    lines.push(`${loc.label} — *${loc.desc}*\n  Start: **Cosa explore ${id}**`);
  }
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n*3 stages, choices matter, loot at the end. 45min cooldown per run.*`);
  return lines.join("\n");
}

function randomScene(locLabel) {
  const template = SCENES[Math.floor(Math.random() * SCENES.length)];
  return template.replace("{loc}", locLabel);
}

// Difficulty scales up each stage — later stages pay more but bite harder.
function buildStage(stageIndex, locLabel) {
  const scale = 1 + stageIndex * 0.6; // stage 0/1/2 -> 1x / 1.6x / 2.2x
  return {
    scene: randomScene(locLabel),
    choiceA: {
      label: "🐢 Play it safe",
      successChance: 0.80,
      cashRange: [Math.round(3000 * scale), Math.round(9000 * scale)],
      failCashLoss: [0, Math.round(1500 * scale)],
      treasureChanceOnSuccess: 0.08,
      perkChanceOnSuccess: 0.12, // small success-rate buff for later stages
    },
    choiceB: {
      label: "🎲 Push your luck",
      successChance: 0.50,
      cashRange: [Math.round(8000 * scale), Math.round(25000 * scale)],
      failCashLoss: [Math.round(2000 * scale), Math.round(6000 * scale)],
      treasureChanceOnSuccess: 0.24,
      perkChanceOnSuccess: 0.05,
      injuryChanceOnFail: 0.35, // small penalty to future success chance
    },
  };
}

function startExploring(userId, locationId) {
  const loc = LOCATIONS[locationId];
  if (!loc) return { success: false, reason: `🔫 Unknown location. Check **Cosa explore** for the list.` };

  if (pendingSessions.has(userId)) {
    const s = pendingSessions.get(userId);
    if (s.expiresAt > Date.now()) {
      return { success: false, reason: `🗺️ You're already mid-expedition. Answer with **Cosa choose 1** or **Cosa choose 2** (or **Cosa explore cancel**).` };
    }
    pendingSessions.delete(userId); // stale/expired session, clean up
  }

  const cdLeft = getCooldownRemaining(userId);
  if (cdLeft > 0) return { success: false, reason: `⏰ You're still recovering from your last expedition. Try again in **${Math.ceil(cdLeft / 60000)} minute(s)**.` };

  const session = {
    locationId, locLabel: loc.label,
    stage: 0, bonus: 0, cashEarned: 0, treasuresFound: [],
    stageData: buildStage(0, loc.label),
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
  };
  pendingSessions.set(userId, session);

  return {
    success: true, locLabel: loc.label,
    text: renderStageText(session),
  };
}

function renderStageText(session) {
  const { scene, choiceA, choiceB } = session.stageData;
  return (
    `🗺️ **${session.locLabel}** — Stage ${session.stage + 1}/${STAGES_PER_RUN}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${scene}\n\n` +
    `**1️⃣ ${choiceA.label}** — safer bet, smaller reward\n` +
    `**2️⃣ ${choiceB.label}** — riskier, bigger payout, bigger obstacle if it goes wrong\n\n` +
    `*Answer with **Cosa choose 1** or **Cosa choose 2***`
  );
}

function randRange([min, max]) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

async function makeChoice(userId, choiceNum) {
  const session = pendingSessions.get(userId);
  if (!session) return { success: false, reason: `🔫 You're not on an expedition. Start one with **Cosa explore**.` };
  if (session.expiresAt <= Date.now()) {
    pendingSessions.delete(userId);
    return { success: false, reason: `⌛ That expedition timed out from inactivity. Start a new one with **Cosa explore**.` };
  }
  if (choiceNum !== 1 && choiceNum !== 2) return { success: false, reason: `🔫 Choose **1** or **2**.` };

  const choice = choiceNum === 1 ? session.stageData.choiceA : session.stageData.choiceB;
  const roll = Math.random();
  const effectiveChance = Math.max(0.1, Math.min(0.95, choice.successChance + session.bonus));
  const won = roll < effectiveChance;

  const lines = [];
  if (won) {
    const cash = randRange(choice.cashRange);
    session.cashEarned += cash;
    await eco.addCopper(userId, cash);
    lines.push(`✅ It pays off — you walk away with **💵 ${eco.fmt(cash)} Cash**.`);

    if (Math.random() < (choice.treasureChanceOnSuccess || 0)) {
      const treasure = features.pickRandomTreasure();
      features.grantTreasure(userId, treasure.id, 1);
      session.treasuresFound.push(treasure);
      lines.push(`✨ You spot something in the wreckage — **${treasure.name}**! Added to your treasures.`);
    }
    if (Math.random() < (choice.perkChanceOnSuccess || 0)) {
      session.bonus = Math.min(0.25, session.bonus + 0.10);
      lines.push(`🧭 You find a shortcut through the area — better odds for the rest of the run.`);
    }
  } else {
    const loss = randRange(choice.failCashLoss);
    if (loss > 0) {
      await eco.deductCopper(userId, loss).catch(() => {});
      lines.push(`💥 Obstacle! It costs you **💵 ${eco.fmt(loss)} Cash** in damage/bribes to get clear.`);
    } else {
      lines.push(`💥 Obstacle! You get out clean, but empty-handed this stage.`);
    }
    if (choice.injuryChanceOnFail && Math.random() < choice.injuryChanceOnFail) {
      session.bonus = Math.max(-0.25, session.bonus - 0.10);
      lines.push(`🩹 You're a little banged up — worse odds for what's left of the run.`);
    }
  }

  session.stage++;
  if (session.stage >= STAGES_PER_RUN) {
    // Run complete — final bonus loot roll, odds boosted by how well it went.
    pendingSessions.delete(userId);
    cooldowns.set(userId, Date.now());

    const finalTreasureChance = 0.30 + Math.max(0, session.bonus) + (session.cashEarned > 50000 ? 0.10 : 0);
    let bonusTreasureLine = "";
    if (Math.random() < finalTreasureChance) {
      const treasure = features.pickRandomTreasure();
      features.grantTreasure(userId, treasure.id, 1);
      session.treasuresFound.push(treasure);
      bonusTreasureLine = `\n🏆 **BONUS FIND:** ${treasure.name} — pulled from the very last stash you check.`;
    }

    lines.push(
      `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🏁 **EXPEDITION COMPLETE — ${session.locLabel}**\n` +
      `💰 Total Cash earned: **💵 ${eco.fmt(session.cashEarned)} Cash**\n` +
      (session.treasuresFound.length
        ? `🗺️ Treasures found: ${session.treasuresFound.map(t => t.name).join(", ")}`
        : `🗺️ No treasures this run — better luck next time.`) +
      bonusTreasureLine +
      `\n*Check your haul with **Cosa treasures***`
    );
    return { success: true, done: true, text: lines.join("\n") };
  }

  session.stageData = buildStage(session.stage, session.locLabel);
  session.expiresAt = Date.now() + SESSION_TIMEOUT_MS;
  lines.push(`\n${renderStageText(session)}`);
  return { success: true, done: false, text: lines.join("\n") };
}

function cancelExploring(userId) {
  const session = pendingSessions.get(userId);
  if (!session) return { success: false, reason: `🔫 You're not on an expedition.` };
  pendingSessions.delete(userId);
  cooldowns.set(userId, Date.now());
  return {
    success: true,
    text: `🏳️ You pull out early from **${session.locLabel}**.\n💰 You keep the **💵 ${eco.fmt(session.cashEarned)} Cash** earned so far.` +
      (session.treasuresFound.length ? `\n🗺️ Treasures kept: ${session.treasuresFound.map(t => t.name).join(", ")}` : ""),
  };
}

// Wipes every in-memory explore cooldown/session — used by the Don-only
// "reset economy" command.
function resetAllCooldowns() {
  cooldowns.clear();
  pendingSessions.clear();
}

module.exports = {
  LOCATIONS, getLocationsDisplay, startExploring, makeChoice, cancelExploring,
  getCooldownRemaining, EXPLORE_COOLDOWN_MS, resetAllCooldowns,
};
