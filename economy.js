const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

// ── Currency System ───────────────────────────────────────────────────────────
// Single flat currency: Cash. 1 is just 1 — no denominations, no conversion.
// `copper`/`silver`/`gold`/`stellar` remain the Supabase column names (renaming
// requires a migration), but only `copper` is ever used now. Old wallets that
// still have a balance sitting in silver/gold/stellar (from before the
// flatten) are folded into `copper` automatically the moment they're read —
// nobody's balance disappears, it just all becomes Cash going forward.
function formatWallet(wallet) {
  return `💵 ${Math.floor(wallet.copper || 0).toLocaleString()} Cash`;
}

function walletToCopper(wallet) {
  return Math.floor(
    (wallet.copper  || 0) +
    (wallet.silver  || 0) * 100 +
    (wallet.gold    || 0) * 10000 +
    (wallet.stellar || 0) * 1000000
  );
}

function fromCopper(copper) {
  return { copper: Math.floor(copper), silver: 0, gold: 0, stellar: 0 };
}

function parseBet(amount) {
  const num = parseInt(amount);
  if (isNaN(num) || num <= 0) return null;
  return num;
}

// ── Supabase Wallet Store ─────────────────────────────────────────────────────
let supabase;
function initEconomy(supabaseUrl, supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey, { realtime: { transport: ws } });
    console.log("✅ Economy system initialized");
  } catch (e) {
    console.error("[ECONOMY] Init failed:", e.message);
  }
}

async function getWallet(userId) {
  const empty = { user_id: userId, copper: 0, silver: 0, gold: 0, stellar: 0, last_daily: null, total_earned: 0, debt: 0 };
  if (!supabase) return empty;
  const { data, error } = await supabase.from("wallets").select("*").eq("user_id", userId);
  if (error) {
    console.error("[GET WALLET ERROR]", error.message);
    return empty;
  }
  if (!data || data.length === 0) return empty;
  // Flatten on read — a wallet with a leftover balance in silver/gold/stellar
  // from before the flatten shows up as Cash immediately, not just after its
  // next transaction.
  const w = data[0];
  return { ...w, copper: walletToCopper(w), silver: 0, gold: 0, stellar: 0 };
}

async function saveWallet(wallet) {
  if (!supabase) return;
  const { error } = await supabase.from("wallets").upsert(wallet, { onConflict: "user_id" });
  if (error) console.error("[SAVE WALLET]", error.message);
}

async function getDebt(userId) {
  const w = await getWallet(userId);
  return w.debt || 0;
}

async function addDebt(userId, amount) {
  try {
    const w = await getWallet(userId);
    const newW = { ...w, debt: (w.debt || 0) + amount };
    await saveWallet(newW);
    return newW;
  } catch (e) { console.error("[ADD DEBT]", e.message); return null; }
}

async function payDebt(userId, amount) {
  try {
    const w = await getWallet(userId);
    const currentDebt = w.debt || 0;
    const pay = Math.min(amount, currentDebt);
    const newW = { ...w, debt: currentDebt - pay };
    // Also deduct from balance
    const totalCopper = walletToCopper(w);
    if (totalCopper < pay) return null;
    Object.assign(newW, fromCopper(totalCopper - pay));
    await saveWallet(newW);
    return newW;
  } catch (e) { console.error("[PAY DEBT]", e.message); return null; }
}

function formatDebt(debt) {
  if (!debt || debt === 0) return null;
  return "🔴 **YOU OWE THE FAMILY: " + debt.toLocaleString() + " Cash**";
}

async function addCopper(userId, copperAmount) {
  try {
    const w = await getWallet(userId);
    const total = walletToCopper(w) + copperAmount;
    const newW = { ...w, ...fromCopper(total), total_earned: (w.total_earned || 0) + Math.max(0, copperAmount) };
    await saveWallet(newW);
    return newW;
  } catch (e) { console.error("[ADD COPPER]", e.message); return null; }
}

async function deductCopper(userId, copperAmount) {
  try {
    const w = await getWallet(userId);
    const total = walletToCopper(w);
    if (total < copperAmount) return null;
    const newW = { ...w, ...fromCopper(total - copperAmount) };
    await saveWallet(newW);
    return newW;
  } catch (e) { console.error("[DEDUCT COPPER]", e.message); return null; }
}

async function getLeaderboard(limit = 10) {
  const { data, error } = await supabase.from("wallets").select("*").order("total_earned", { ascending: false }).limit(limit);
  if (error) {
    console.error("[GET LEADERBOARD ERROR]", error.message);
    return [];
  }
  return data || [];
}

// ── Daily Rewards by Rank ─────────────────────────────────────────────────────
// Mirrors the 10-tier Family ladder. Flat Cash amounts now (same effective
// values as the old tiered rewards, just no denominations to think in).
// Don Clint's cut is effectively bottomless.
const DAILY_REWARDS = {
  streetrat:   100,
  associate:   500,
  soldier:     1000,
  mademan:     3000,
  enforcer:    10000,
  capo:        100000,
  underboss:   200000,
  consigliere: 1000000,
  boss:        5000000,
  donclint:    999999999,
};

function getDailyAmount(rankKey) {
  return DAILY_REWARDS[rankKey] || DAILY_REWARDS.streetrat;
}

// ── Slots ─────────────────────────────────────────────────────────────────────
// Weights tuned so matching two commons is frequent, jackpots are rare.
// Total weight ~100. Skull symbol reduced from 37→15 so near-misses feel fair.
const SLOT_SYMBOLS = [
  { emoji: "🤵", weight: 3,  multiplier: 10  }, // rare jackpot — the Don himself
  { emoji: "💎", weight: 6,  multiplier: 6   },
  { emoji: "🔫", weight: 10, multiplier: 4   },
  { emoji: "🥃", weight: 16, multiplier: 2.5 },
  { emoji: "🎩", weight: 22, multiplier: 1.5 },
  { emoji: "🚬", weight: 24, multiplier: 1   },
  { emoji: "💵", weight: 27, multiplier: 0.5 }, // partial return on pair
  { emoji: "💀", weight: 8,  multiplier: 0   }, // loss, further reduced
];

function spinSlot() {
  const totalWeight = SLOT_SYMBOLS.reduce((a, s) => a + s.weight, 0);
  let r = Math.random() * totalWeight;
  for (const s of SLOT_SYMBOLS) { r -= s.weight; if (r <= 0) return s; }
  return SLOT_SYMBOLS[SLOT_SYMBOLS.length - 1];
}

function playSlots(bet, charmActive = false, houseFavorActive = false) {
  const reels = [spinSlot(), spinSlot(), spinSlot()];
  // Loaded dice: reroll the worst reel once if no match
  if (charmActive) {
    const hasMatch = reels[0].emoji === reels[1].emoji || reels[1].emoji === reels[2].emoji || reels[0].emoji === reels[2].emoji;
    if (!hasMatch) {
      // Find the odd one out and reroll it
      const idx = reels[0].emoji === reels[1].emoji ? 2 : reels[1].emoji === reels[2].emoji ? 0 : 1;
      reels[idx] = spinSlot();
    }
  }
  // House Favor: guarantee no 💀 (total-loss) symbol makes it into the final result
  if (houseFavorActive) {
    for (let i = 0; i < reels.length; i++) {
      let tries = 0;
      while (reels[i].multiplier === 0 && tries < 8) {
        reels[i] = spinSlot();
        tries++;
      }
    }
  }
  const display = reels.map(r => r.emoji).join(" | ");
  let multiplier = 0;
  let isJackpot = false;
  if (reels[0].emoji === reels[1].emoji && reels[1].emoji === reels[2].emoji) {
    multiplier = reels[0].multiplier * 3; // jackpot
    isJackpot = multiplier > 1;
  } else if (reels[0].emoji === reels[1].emoji) {
    multiplier = reels[0].multiplier * 0.5; // pair uses the matched symbol's payout
  } else if (reels[1].emoji === reels[2].emoji) {
    multiplier = reels[1].multiplier * 0.5;
  } else if (reels[0].emoji === reels[2].emoji) {
    multiplier = reels[0].multiplier * 0.5;
  }
  const winnings = Math.floor(bet * multiplier);
  return { display, multiplier, winnings, isJackpot };
}

// ── Wheel ─────────────────────────────────────────────────────────────────────
// Max is now 5x. 0.5x counts as a loss (loaded dice reroll it).
// 3x and 5x are rare but reachable. Total weight = 1000 for clean math.
const WHEEL_SEGMENTS = [
  { label: "💀 WIPED OUT",  multiplier: 0,   weight: 180 },
  { label: "☠️ WIPED OUT",  multiplier: 0,   weight: 150 },
  { label: "0.5x 😬",       multiplier: 0.5, weight: 170 }, // treated as loss for loaded dice
  { label: "1x",            multiplier: 1,   weight: 250 },
  { label: "2x",            multiplier: 2,   weight: 150 },
  { label: "3x 🔥",         multiplier: 3,   weight: 70  },
  { label: "5x ⚡",         multiplier: 5,   weight: 30  },
];

function spinWheel(houseFavorActive = false) {
  function roll() {
    const total = WHEEL_SEGMENTS.reduce((a, s) => a + s.weight, 0);
    let r = Math.random() * total;
    for (const s of WHEEL_SEGMENTS) { r -= s.weight; if (r <= 0) return s; }
    return WHEEL_SEGMENTS[0];
  }
  let seg = roll();
  // House Favor: guarantee no true 0x wipeout segment (0.5x still can happen — that's a partial loss, not the floor)
  if (houseFavorActive) {
    let tries = 0;
    while (seg.multiplier === 0 && tries < 8) {
      seg = roll();
      tries++;
    }
  }
  return seg;
}

// ── Blackjack ─────────────────────────────────────────────────────────────────
const BJ_DECK = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
function bjValue(card) { return card === "A" ? 11 : ["J","Q","K"].includes(card) ? 10 : parseInt(card); }
function bjHandValue(hand) {
  let total = hand.reduce((a, c) => a + bjValue(c), 0);
  let aces = hand.filter(c => c === "A").length;
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}
function dealCard() { return BJ_DECK[Math.floor(Math.random() * BJ_DECK.length)]; }
function newBjHand() { return [dealCard(), dealCard()]; }

// ── Shakedown (Rob) ────────────────────────────────────────────────────────────
// 40% success, 30% caught (fine = 50% of attempted take), 30% they got away clean
function attemptRob(targetCopperBalance, robberCopperBalance, robberDebt = 0) {
  const r = Math.random();
  const steal = Math.floor(targetCopperBalance * (0.2 + Math.random() * 0.2));
  const finePercent = 0.5 + Math.random() * 0.2;
  // In debt to the Family = lower success rate (20% instead of 40%)
  const successThreshold = robberDebt > 0 ? 0.25 : 0.50;
  if (r < successThreshold) return { result: "success", amount: steal };
  if (r < 0.7) return { result: "caught", fine: Math.floor(steal * finePercent) };
  return { result: "escaped" };
}

// ── Chat Rewards ──────────────────────────────────────────────────────────────
const chatCounters = new Map(); // userId -> message count since last reward
function shouldRewardChat(userId) {
  const count = (chatCounters.get(userId) || 0) + 1;
  chatCounters.set(userId, count);
  if (count >= (5 + Math.floor(Math.random() * 6))) { // every 5-10 messages
    chatCounters.set(userId, 0);
    return Math.floor(10 + Math.random() * 40); // 10-50 cash
  }
  return 0;
}

// Active blackjack games: userId -> { playerHand, dealerHand, bet, channelId }
const bjGames = new Map();

module.exports = {
  fromCopper, formatWallet, walletToCopper, parseBet,
  initEconomy, getWallet, saveWallet, addCopper, deductCopper, getLeaderboard,
  getDailyAmount, DAILY_REWARDS,
  playSlots, spinWheel, WHEEL_SEGMENTS,
  bjHandValue, dealCard, newBjHand, bjGames,
  attemptRob, shouldRewardChat,
  getDebt, addDebt, payDebt, formatDebt,
};
